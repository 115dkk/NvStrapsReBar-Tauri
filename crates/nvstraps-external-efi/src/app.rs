use alloc::{format, string::ToString, vec, vec::Vec};
use nvstraps_external::{
    execute::{self, Machine},
    *,
};
use uefi::{
    CString16, Handle, Status,
    boot::{self, LoadImageSource},
    proto::{
        device_path::{
            DevicePath,
            build::{DevicePathBuilder, media::FilePath},
        },
        media::{
            file::{File, FileAttribute, FileInfo, FileMode},
            fs::SimpleFileSystem,
        },
    },
};

const REPORT: &str = "\\NvStrapsDiagnostic.json";
const PLAN: &str = "\\EFI\\NvStraps\\plan.json";

#[cfg(feature = "qemu-model")]
pub fn handoff_probe() -> Status {
    let _ = uefi::helpers::init();
    uefi::println!("EXTERNAL-HANDOFF: real LoadImage/StartImage reached successor");
    Status::SUCCESS
}

fn read_file(handle: Handle, path: &str, limit: usize) -> Result<Vec<u8>, &'static str> {
    let path = CString16::try_from(path).map_err(|_| "invalid UCS-2 path")?;
    let mut fs = crate::native::open::<SimpleFileSystem>(handle)?;
    let mut root = fs.open_volume().map_err(|_| "open volume failed")?;
    let mut file = root
        .open(&path, FileMode::Read, FileAttribute::empty())
        .map_err(|_| "open file failed")?
        .into_regular_file()
        .ok_or("not a regular file")?;
    let info = file
        .get_boxed_info::<FileInfo>()
        .map_err(|_| "file metadata unavailable")?;
    let len = usize::try_from(info.file_size()).map_err(|_| "file too large")?;
    if len > limit {
        return Err("file exceeds size limit");
    }
    let mut bytes = vec![0; len];
    let mut at = 0;
    while at < len {
        let n = file
            .read(&mut bytes[at..])
            .map_err(|_| "file read failed")?;
        if n == 0 {
            return Err("short file read");
        }
        at += n;
    }
    Ok(bytes)
}
fn own_device() -> Result<Handle, &'static str> {
    crate::native::open::<uefi::proto::loaded_image::LoadedImage>(boot::image_handle())?
        .device()
        .ok_or("image device absent")
}
fn save_new(path: &str, bytes: &[u8]) -> Result<(), &'static str> {
    let device = own_device()?;
    if let Ok(old) = read_file(device, path, MAX_REPORT_BYTES) {
        return if old == bytes {
            Ok(())
        } else {
            Err("output already exists with different contents")
        };
    }
    let path = CString16::try_from(path).map_err(|_| "invalid output path")?;
    let mut fs = crate::native::open::<SimpleFileSystem>(device)?;
    let mut root = fs.open_volume().map_err(|_| "open output volume failed")?;
    // A successful read/open, including a directory, always constitutes an existing output.
    match root.open(&path, FileMode::Read, FileAttribute::empty()) {
        Ok(_) => return Err("output already exists"),
        Err(e) if e.status() == Status::NOT_FOUND => {}
        Err(_) => return Err("output existence check failed"),
    }
    let mut file = root
        .open(&path, FileMode::CreateReadWrite, FileAttribute::empty())
        .map_err(|_| "create output failed")?
        .into_regular_file()
        .ok_or("output is not a file")?;
    file.write(bytes).map_err(|_| "output write failed")?;
    file.flush().map_err(|_| "output flush failed")?;
    drop(file);
    drop(root);
    drop(fs);
    if read_file(device, &path.to_string(), MAX_REPORT_BYTES)? != bytes {
        return Err("output readback mismatch");
    }
    Ok(())
}

pub fn diagnostic() -> Status {
    if uefi::helpers::init().is_err() {
        return Status::ABORTED;
    }
    uefi::println!("EXTERNAL-DIAGNOSTIC: start; PCI and firmware state read-only");
    #[cfg(not(feature = "qemu-model"))]
    let snapshot = crate::native::capture();
    #[cfg(feature = "qemu-model")]
    let snapshot = crate::model::Model::new().source;
    for error in &snapshot.errors {
        uefi::println!("EXTERNAL-DIAGNOSTIC: incomplete: {error}");
    }
    match serde_json::to_vec_pretty(&snapshot)
        .map_err(|_| "diagnostic encoding failed")
        .and_then(|bytes| save_new(REPORT, &bytes))
    {
        Ok(()) => {
            uefi::println!(
                "EXTERNAL-DIAGNOSTIC: saved; devices={} errors={} environment={:?}",
                snapshot.devices.len(),
                snapshot.errors.len(),
                snapshot.environment
            );
            Status::SUCCESS
        }
        Err(e) => {
            uefi::println!("EXTERNAL-DIAGNOSTIC: {e}");
            Status::ABORTED
        }
    }
}

fn prepare_handoff(h: &Handoff) -> Result<Handle, &'static str> {
    let mut candidate = None;
    for handle in crate::native::handles::<SimpleFileSystem>()? {
        let Ok(bytes) = read_file(handle, &h.path, 32 * 1024 * 1024) else {
            continue;
        };
        if digest(&bytes) != h.sha256 {
            continue;
        }
        if candidate.is_some() {
            return Err("ambiguous successor: multiple matching volumes");
        }
        candidate = Some((handle, bytes));
    }
    let (handle, bytes) = candidate.ok_or("pinned successor missing or changed")?;
    let path = CString16::try_from(h.path.as_str()).map_err(|_| "invalid successor path")?;
    let device = crate::native::open::<DevicePath>(handle)?;
    let mut storage = Vec::new();
    let file_path = DevicePathBuilder::with_vec(&mut storage)
        .push(&FilePath { path_name: &path })
        .map_err(|_| "successor path build failed")?
        .finalize()
        .map_err(|_| "successor path finalization failed")?;
    let full = device
        .append_path(file_path)
        .map_err(|_| "device path append failed")?;
    boot::load_image(
        boot::image_handle(),
        LoadImageSource::FromBuffer {
            buffer: &bytes,
            file_path: Some(&full),
        },
    )
    .map_err(|_| "successor LoadImage/authentication failed")
}

fn run() -> Result<(), &'static str> {
    let bytes = read_file(own_device()?, PLAN, MAX_REPORT_BYTES)?;
    let plan: Plan = serde_json::from_slice(&bytes).map_err(|_| "invalid plan JSON")?;
    #[cfg(not(feature = "qemu-model"))]
    let mut machine = {
        if plan.source.environment != Environment::Physical {
            return Err("test plan rejected by production loader");
        }
        crate::native::NativeMachine::new(plan.target)?
    };
    #[cfg(feature = "qemu-model")]
    let mut machine = {
        let mut model = crate::model::Model::new();
        model.fail_writes = read_file(own_device()?, "\\EFI\\NvStraps\\model-fault.txt", 64)
            .is_ok_and(|v| v == b"permanent-write-failure");
        model
    };
    let current = machine.snapshot()?;
    validate_plan(&plan, &current).map_err(|_| "fresh diagnostic does not match plan")?;
    let next = prepare_handoff(&plan.handoff)?;
    uefi::println!(
        "EXTERNAL-LOADER: successor authenticated; target={:?} environment={:?}",
        plan.target,
        plan.source.environment
    );
    let applied = match execute::apply(&mut machine, &plan) {
        Ok(receipt) => receipt,
        Err(e) => {
            let _ = boot::unload_image(next);
            uefi::println!(
                "EXTERNAL-LOADER: failed={} rollback_failed={}",
                e.reason,
                e.rollback_failed
            );
            if e.rollback_failed {
                halt_failed_restore();
            }
            return Err(e.reason);
        }
    };
    uefi::println!(
        "EXTERNAL-LOADER: aperture readback={} base={:#x}",
        applied.measured_bytes,
        applied.destination.start
    );
    let receipt = format!(
        "schema=1\nenvironment={:?}\nsource={:02x?}\nbar1Base={:#x}\nmeasuredBytes={}\nphase=before-handoff\n",
        plan.source.environment,
        plan.source_sha256,
        applied.destination.start,
        applied.measured_bytes
    );
    let receipt_hash = digest(receipt.as_bytes());
    let name = format!(
        "\\NvStraps-{:02x}{:02x}{:02x}{:02x}.txt",
        receipt_hash[0], receipt_hash[1], receipt_hash[2], receipt_hash[3]
    );
    if let Err(e) = save_new(&name, receipt.as_bytes()) {
        let rollback = execute::restore(&mut machine, applied.saved, applied.destination);
        let _ = boot::unload_image(next);
        uefi::println!("EXTERNAL-LOADER: receipt failure; rollback={rollback:?}");
        if rollback.is_err() {
            halt_failed_restore();
        }
        return Err(e);
    }
    let result = boot::start_image(next);
    // A successor normally never returns. Returning to firmware must undo our
    // change before exposing the pre-existing PCI_IO resource descriptions again.
    let rollback = execute::restore(&mut machine, applied.saved, applied.destination);
    let _ = boot::unload_image(next);
    uefi::println!("EXTERNAL-LOADER: successor returned={result:?}; restored={rollback:?}");
    if rollback.is_err() {
        halt_failed_restore();
    }
    #[cfg(feature = "qemu-model")]
    {
        if result.is_ok() {
            uefi::println!(
                "EXTERNAL-MODEL: shared executor and chainload PASS; no physical GPU proof"
            );
            // The debug-only CI payload is the removable-media boot target. Returning
            // SUCCESS opens OVMF's setup UI; shut down the test VM after verified undo.
            uefi::runtime::reset(uefi::runtime::ResetType::SHUTDOWN, Status::SUCCESS, None);
        }
    }
    Err("successor returned instead of booting")
}

pub fn loader() -> Status {
    if uefi::helpers::init().is_err() {
        return Status::ABORTED;
    }
    match run() {
        Ok(()) => Status::SUCCESS,
        Err(e) => {
            uefi::println!("EXTERNAL-LOADER: stopped: {e}");
            Status::ABORTED
        }
    }
}

fn halt_failed_restore() -> ! {
    uefi::println!(
        "EXTERNAL-LOADER: RESTORE FAILED; halted before firmware fallback; cold power-off required"
    );
    loop {
        core::hint::spin_loop();
    }
}
