#![cfg_attr(target_os = "uefi", no_main)]
#![cfg_attr(target_os = "uefi", no_std)]

#[cfg(target_os = "uefi")]
use uefi::prelude::*;

#[cfg(target_os = "uefi")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    if let Some(system_table) = uefi::table::system_table_raw() {
        // SAFETY: The entry macro initialized the global pointer, and each service pointer is
        // checked before its synchronous call.
        let system_table = unsafe { system_table.as_ref() };
        if !system_table.boot_services.is_null() {
            if !system_table.stdout.is_null() {
                let message = uefi::cstr16!("[PANIC] NvStrapsReBar\r\n");
                // SAFETY: Boot Services are active, stdout is non-null, and message is a static
                // NUL-terminated UCS-2 string.
                let _ = unsafe {
                    ((*system_table.stdout).output_string)(
                        system_table.stdout,
                        message.as_ptr().cast(),
                    )
                };
            }
            // SAFETY: boot services are active and PI defines no error condition for Stall.
            let _ = unsafe { ((*system_table.boot_services).stall)(10_000_000) };
        }
        if !system_table.runtime_services.is_null() {
            // SAFETY: ResetSystem is a non-returning runtime service with no data payload here.
            unsafe {
                ((*system_table.runtime_services).reset_system)(
                    uefi::runtime::ResetType::SHUTDOWN,
                    Status::ABORTED,
                    0,
                    core::ptr::null(),
                )
            }
        }
    }

    loop {
        // SAFETY: HLT has no memory side effects and avoids burning a CPU on an unrecoverable
        // panic.
        unsafe { core::arch::asm!("hlt", options(nomem, nostack)) }
    }
}

#[cfg(target_os = "uefi")]
#[entry]
fn main() -> Status {
    if uefi::helpers::init().is_err() {
        return Status::ABORTED;
    }

    nvstraps_uefi::driver::initialize()
}

#[cfg(not(target_os = "uefi"))]
fn main() {
    eprintln!("NvStrapsReBar is a UEFI boot-service driver; build for x86_64-unknown-uefi");
}
