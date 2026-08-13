use alloc::boxed::Box;
use alloc::vec::Vec;
use core::ptr;
use core::sync::atomic::{AtomicPtr, Ordering};

use nvstraps_core::pci::PciAddress;
use nvstraps_core::status::EfiErrorLocation;
use uefi::boot::{self, OpenProtocolAttributes, OpenProtocolParams, ScopedProtocol};
use uefi::proto::pci::PciIoAddress;
use uefi::proto::unsafe_protocol;
use uefi::{Handle, Status};

use crate::engine::FirmwareEngine;

const BEFORE_RESOURCE_COLLECTION: u32 = 1;

type PreprocessController = unsafe extern "efiapi" fn(
    *mut PciHostBridgeResourceAllocation,
    Handle,
    PciIoAddress,
    u32,
) -> Status;

/// PI PCI Host Bridge Resource Allocation protocol. The opaque entries retain
/// the official function-pointer layout; this driver only replaces the final
/// `preprocess_controller` entry.
#[unsafe_protocol("cf8034be-6768-4d8b-b739-7cce683a9fbe")]
#[repr(C)]
struct PciHostBridgeResourceAllocation {
    notify_phase: usize,
    get_next_root_bridge: usize,
    get_alloc_attributes: usize,
    start_bus_enumeration: usize,
    set_bus_numbers: usize,
    submit_resources: usize,
    get_proposed_resources: usize,
    preprocess_controller: PreprocessController,
}

const _: () = assert!(
    core::mem::size_of::<PciHostBridgeResourceAllocation>() == 8 * core::mem::size_of::<usize>()
);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HookInstallError {
    pub location: EfiErrorLocation,
    pub status: Status,
}

struct HookedProtocol {
    interface: ScopedProtocol<PciHostBridgeResourceAllocation>,
    original: PreprocessController,
}

struct HookContext {
    engine: FirmwareEngine,
    protocols: Vec<HookedProtocol>,
}

static CONTEXT: AtomicPtr<HookContext> = AtomicPtr::new(ptr::null_mut());

pub fn install(engine: FirmwareEngine) -> Result<(), HookInstallError> {
    if !CONTEXT.load(Ordering::Acquire).is_null() {
        return Err(HookInstallError {
            location: EfiErrorLocation::LoadBridgeProtocol,
            status: Status::ALREADY_STARTED,
        });
    }
    let handles = boot::find_handles::<PciHostBridgeResourceAllocation>().map_err(|error| {
        HookInstallError {
            location: EfiErrorLocation::LocateBridgeProtocol,
            status: error.status(),
        }
    })?;
    let mut protocols = Vec::with_capacity(handles.len());
    for handle in handles {
        // SAFETY: The protocol type uses the PI GUID and exact eight-pointer
        // layout. Interfaces remain open because the context is DXE-lifetime.
        let interface = unsafe {
            boot::open_protocol::<PciHostBridgeResourceAllocation>(
                OpenProtocolParams {
                    handle,
                    agent: boot::image_handle(),
                    controller: None,
                },
                OpenProtocolAttributes::GetProtocol,
            )
        }
        .map_err(|error| HookInstallError {
            location: EfiErrorLocation::LoadBridgeProtocol,
            status: error.status(),
        })?;
        let original = interface.preprocess_controller;
        protocols.push(HookedProtocol {
            interface,
            original,
        });
    }

    let context = Box::new(HookContext { engine, protocols });
    let context = Box::into_raw(context);
    if CONTEXT
        .compare_exchange(
            ptr::null_mut(),
            context,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        // SAFETY: The pointer came from Box::into_raw above and was not stored.
        unsafe { drop(Box::from_raw(context)) };
        return Err(HookInstallError {
            location: EfiErrorLocation::LoadBridgeProtocol,
            status: Status::ALREADY_STARTED,
        });
    }

    // SAFETY: The context has DXE lifetime after publication. PCI enumeration
    // is not running yet, so no callback can race these pointer replacements.
    for hooked in unsafe { &mut *context }.protocols.iter_mut() {
        hooked.interface.preprocess_controller = preprocess_controller_override;
    }
    Ok(())
}

unsafe extern "efiapi" fn preprocess_controller_override(
    this: *mut PciHostBridgeResourceAllocation,
    root_bridge: Handle,
    pci_address: PciIoAddress,
    phase: u32,
) -> Status {
    let context = CONTEXT.load(Ordering::Acquire);
    if context.is_null() {
        return Status::NOT_READY;
    }
    // SAFETY: `install` intentionally leaks this context for the DXE lifetime;
    // PI enumeration invokes PreprocessController serially.
    let context = unsafe { &mut *context };
    let Some(original) = context.protocols.iter().find_map(|hooked| {
        let interface = &*hooked.interface as *const PciHostBridgeResourceAllocation;
        ptr::eq(interface, this.cast_const()).then_some(hooked.original)
    }) else {
        return Status::NOT_FOUND;
    };

    // SAFETY: This is the original function pointer from the same live PI
    // protocol instance and receives the untouched callback arguments.
    let status = unsafe { original(this, root_bridge, pci_address, phase) };
    if phase <= BEFORE_RESOURCE_COLLECTION
        && let Some(address) = PciAddress::new(pci_address.bus, pci_address.dev, pci_address.fun)
    {
        context.engine.process_device(root_bridge, address);
    }
    status
}
