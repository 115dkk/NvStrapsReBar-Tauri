use core::ptr;
use core::sync::atomic::{AtomicPtr, AtomicU8, Ordering};

use nvstraps_core::pci::PciAddress;
use nvstraps_core::status::EfiErrorLocation;
use uefi::boot::{self, OpenProtocolAttributes, OpenProtocolParams, ScopedProtocol, SearchType};
use uefi::proto::pci::PciIoAddress;
use uefi::proto::unsafe_protocol;
use uefi::{Handle, Status};

use crate::engine::FirmwareEngine;
use crate::exclusive::ExclusiveCell;
use crate::pool::{PoolBox, PoolVec};

const BEFORE_RESOURCE_COLLECTION: u32 = 1;
const MAX_HOST_BRIDGE_PROTOCOLS: usize = 256;
const INSTALL_UNINITIALIZED: u8 = 0;
const INSTALLING: u8 = 1;
const INSTALLED: u8 = 2;

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
    preprocess_controller: Option<PreprocessController>,
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
    interface_address: usize,
    original: PreprocessController,
}

struct HookContext {
    engine: ExclusiveCell<FirmwareEngine>,
    protocols: PoolVec<HookedProtocol>,
}

static CONTEXT: AtomicPtr<HookContext> = AtomicPtr::new(ptr::null_mut());
static INSTALL_STATE: AtomicU8 = AtomicU8::new(INSTALL_UNINITIALIZED);

pub fn install(engine: FirmwareEngine) -> Result<(), HookInstallError> {
    if INSTALL_STATE
        .compare_exchange(
            INSTALL_UNINITIALIZED,
            INSTALLING,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        return Err(HookInstallError {
            location: EfiErrorLocation::LoadBridgeProtocol,
            status: Status::ALREADY_STARTED,
        });
    }

    match install_claimed(engine) {
        Ok(()) => {
            INSTALL_STATE.store(INSTALLED, Ordering::Release);
            Ok(())
        }
        Err(error) => {
            INSTALL_STATE.store(INSTALL_UNINITIALIZED, Ordering::Release);
            Err(error)
        }
    }
}

fn install_claimed(engine: FirmwareEngine) -> Result<(), HookInstallError> {
    let handles =
        boot::locate_handle_buffer(SearchType::from_proto::<PciHostBridgeResourceAllocation>())
            .map_err(|error| HookInstallError {
                location: EfiErrorLocation::LocateBridgeProtocol,
                status: error.status(),
            })?;
    if handles.is_empty() || handles.len() > MAX_HOST_BRIDGE_PROTOCOLS {
        return Err(HookInstallError {
            location: EfiErrorLocation::LoadBridgeProtocol,
            status: Status::BAD_BUFFER_SIZE,
        });
    }
    let mut protocols =
        PoolVec::with_capacity(handles.len()).map_err(|status| HookInstallError {
            location: EfiErrorLocation::LoadBridgeProtocol,
            status,
        })?;
    for &handle in handles.iter() {
        // SAFETY: The protocol type uses the PI GUID and exact eight-pointer layout. The PI host
        // bridge provider owns this interface throughout PCI resource enumeration; callbacks can
        // only arrive through that live interface. Installation runs before enumeration, so the
        // pointer replacement is not concurrent. The context is intentionally retained only for
        // those boot-service callbacks.
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
        let protocol = interface.get().ok_or(HookInstallError {
            location: EfiErrorLocation::LoadBridgeProtocol,
            status: Status::UNSUPPORTED,
        })?;
        let original = protocol.preprocess_controller.ok_or(HookInstallError {
            location: EfiErrorLocation::LoadBridgeProtocol,
            status: Status::UNSUPPORTED,
        })?;
        let interface_address = ptr::from_ref(protocol).addr();
        protocols
            .push(HookedProtocol {
                interface,
                interface_address,
                original,
            })
            .map_err(|status| HookInstallError {
                location: EfiErrorLocation::LoadBridgeProtocol,
                status,
            })?;
    }

    let mut context = PoolBox::new(HookContext {
        engine: ExclusiveCell::new(engine),
        protocols,
    })
    .map_err(|status| HookInstallError {
        location: EfiErrorLocation::LoadBridgeProtocol,
        status,
    })?;
    for hooked in context.get_mut().protocols.as_mut_slice() {
        let interface = hooked
            .interface
            .get_mut()
            .expect("a host-bridge interface validated immediately before storage");
        interface.preprocess_controller = Some(preprocess_controller_override);
    }
    let context = context.leak();
    CONTEXT.store(context.as_ptr(), Ordering::Release);
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
    // SAFETY: install publishes a fully initialized context and intentionally
    // retains it for the complete boot-services callback lifetime.
    let context = unsafe { &*context };
    let this_address = this.addr();
    let Some(original) =
        context.protocols.as_slice().iter().find_map(|hooked| {
            (hooked.interface_address == this_address).then_some(hooked.original)
        })
    else {
        return Status::NOT_FOUND;
    };

    // SAFETY: This is the original function pointer from the same live PI
    // protocol instance and receives the untouched callback arguments.
    let status = unsafe { original(this, root_bridge, pci_address, phase) };
    if phase <= BEFORE_RESOURCE_COLLECTION
        && let Some(address) = PciAddress::new(pci_address.bus, pci_address.dev, pci_address.fun)
    {
        let _ = context
            .engine
            .try_with(|engine| engine.process_device(root_bridge, address));
    }
    status
}
