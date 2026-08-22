use core::mem::{self, size_of};
use core::ptr::{self, NonNull};
use core::slice;
use core::sync::atomic::{AtomicPtr, Ordering};

use nvstraps_core::pci::PciAddress;
use nvstraps_core::status::EfiErrorLocation;
use uefi::boot::{
    self, MemoryType, OpenProtocolAttributes, OpenProtocolParams, ScopedProtocol, SearchType,
};
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
    protocols: NonNull<HookedProtocol>,
    protocol_count: usize,
}

impl HookContext {
    fn protocols(&self) -> &[HookedProtocol] {
        // SAFETY: install publishes an initialized allocation for the entire DXE lifetime.
        unsafe { slice::from_raw_parts(self.protocols.as_ptr(), self.protocol_count) }
    }

    fn protocols_mut(&mut self) -> &mut [HookedProtocol] {
        // SAFETY: install has exclusive access before publishing the callback hooks.
        unsafe { slice::from_raw_parts_mut(self.protocols.as_ptr(), self.protocol_count) }
    }
}

struct ProtocolBuffer {
    pointer: NonNull<HookedProtocol>,
    initialized: usize,
    capacity: usize,
}

impl ProtocolBuffer {
    fn allocate(capacity: usize) -> Result<Self, Status> {
        let size = capacity
            .checked_mul(size_of::<HookedProtocol>())
            .filter(|size| *size != 0)
            .ok_or(Status::OUT_OF_RESOURCES)?;
        let pointer = boot::allocate_pool(MemoryType::BOOT_SERVICES_DATA, size)
            .map_err(|error| error.status())?
            .cast::<HookedProtocol>();
        Ok(Self {
            pointer,
            initialized: 0,
            capacity,
        })
    }

    fn push(
        &mut self,
        interface: ScopedProtocol<PciHostBridgeResourceAllocation>,
    ) -> Result<(), Status> {
        if self.initialized >= self.capacity {
            return Err(Status::OUT_OF_RESOURCES);
        }
        let original = interface.preprocess_controller;
        // SAFETY: allocate reserved space for every located handle and this slot is uninitialized.
        unsafe {
            self.pointer
                .as_ptr()
                .add(self.initialized)
                .write(HookedProtocol {
                    interface,
                    original,
                });
        }
        self.initialized += 1;
        Ok(())
    }

    fn leak(self) -> (NonNull<HookedProtocol>, usize) {
        let result = (self.pointer, self.initialized);
        mem::forget(self);
        result
    }
}

impl Drop for ProtocolBuffer {
    fn drop(&mut self) {
        while self.initialized != 0 {
            self.initialized -= 1;
            // SAFETY: Slots below initialized were written exactly once by push.
            unsafe {
                self.pointer.as_ptr().add(self.initialized).drop_in_place();
            }
        }
        // SAFETY: This buffer uniquely owns the matching pool allocation.
        let _ = unsafe { boot::free_pool(self.pointer.cast::<u8>()) };
    }
}

static CONTEXT: AtomicPtr<HookContext> = AtomicPtr::new(ptr::null_mut());

pub fn install(engine: FirmwareEngine) -> Result<(), HookInstallError> {
    if !CONTEXT.load(Ordering::Acquire).is_null() {
        return Err(HookInstallError {
            location: EfiErrorLocation::LoadBridgeProtocol,
            status: Status::ALREADY_STARTED,
        });
    }
    let handles =
        boot::locate_handle_buffer(SearchType::from_proto::<PciHostBridgeResourceAllocation>())
            .map_err(|error| HookInstallError {
                location: EfiErrorLocation::LocateBridgeProtocol,
                status: error.status(),
            })?;
    let mut protocols =
        ProtocolBuffer::allocate(handles.len()).map_err(|status| HookInstallError {
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
        protocols
            .push(interface)
            .map_err(|status| HookInstallError {
                location: EfiErrorLocation::LoadBridgeProtocol,
                status,
            })?;
    }

    let context_allocation =
        boot::allocate_pool(MemoryType::BOOT_SERVICES_DATA, size_of::<HookContext>()).map_err(
            |error| HookInstallError {
                location: EfiErrorLocation::LoadBridgeProtocol,
                status: error.status(),
            },
        )?;
    let (protocols, protocol_count) = protocols.leak();
    let context = context_allocation.cast::<HookContext>().as_ptr();
    // SAFETY: context_allocation is correctly aligned writable storage of the exact type size.
    unsafe {
        context.write(HookContext {
            engine,
            protocols,
            protocol_count,
        });
    }
    if CONTEXT
        .compare_exchange(
            ptr::null_mut(),
            context,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        // SAFETY: Publication failed, so no callback can observe or alias these allocations.
        unsafe {
            let HookContext {
                engine,
                protocols,
                protocol_count,
            } = context.read();
            drop(engine);
            drop(ProtocolBuffer {
                pointer: protocols,
                initialized: protocol_count,
                capacity: protocol_count,
            });
            let _ = boot::free_pool(context_allocation);
        }
        return Err(HookInstallError {
            location: EfiErrorLocation::LoadBridgeProtocol,
            status: Status::ALREADY_STARTED,
        });
    }

    // SAFETY: The context has DXE lifetime after publication. PCI enumeration
    // is not running yet, so no callback can race these pointer replacements.
    for hooked in unsafe { &mut *context }.protocols_mut() {
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
    let Some(original) = context.protocols().iter().find_map(|hooked| {
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
