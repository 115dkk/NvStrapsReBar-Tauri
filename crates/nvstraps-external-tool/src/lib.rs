use nvstraps_external::*;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("not a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("file exceeds limit".into());
    }
    Ok(bytes)
}
pub fn read_snapshot(path: &Path) -> Result<Snapshot, String> {
    serde_json::from_slice(&read_bounded(path, MAX_REPORT_BYTES as u64)?).map_err(|e| e.to_string())
}
pub fn read_plan(path: &Path) -> Result<Plan, String> {
    let p: Plan = serde_json::from_slice(&read_bounded(path, MAX_REPORT_BYTES as u64)?)
        .map_err(|e| e.to_string())?;
    validate_plan(&p, &p.source).map_err(|e| format!("invalid plan: {e:?}"))?;
    Ok(p)
}
pub fn write_immutable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut f) => {
            f.write_all(bytes)
                .and_then(|()| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    if read_bounded(path, bytes.len() as u64)? != bytes {
        return Err(format!("immutable output conflict: {}", path.display()));
    }
    Ok(())
}
pub fn validate_application(bytes: &[u8]) -> Result<(), String> {
    let u16_at = |p: usize| {
        bytes
            .get(p..p + 2)
            .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
    };
    let header = bytes
        .get(0x3c..0x40)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize)
        .ok_or("missing PE header")?;
    if bytes.get(..2) != Some(b"MZ")
        || bytes.get(header..header + 4) != Some(b"PE\0\0")
        || u16_at(header + 4) != Some(0x8664)
        || u16_at(header + 24) != Some(0x20b)
        || u16_at(header + 24 + 68) != Some(10)
    {
        return Err("expected an AMD64 EFI application".into());
    }
    Ok(())
}
pub fn package(
    probe: &Path,
    loader: &Path,
    plan: &Plan,
    output: &Path,
) -> Result<serde_json::Value, String> {
    validate_plan(plan, &plan.source).map_err(|e| format!("invalid plan: {e:?}"))?;
    let diagnostic = read_bounded(probe, 16 * 1024 * 1024)?;
    let loader = read_bounded(loader, 16 * 1024 * 1024)?;
    validate_application(&diagnostic)?;
    validate_application(&loader)?;
    let plan_bytes = serde_json::to_vec_pretty(plan).map_err(|e| e.to_string())?;
    let files = [
        ("EFI/BOOT/BOOTX64.EFI", loader),
        ("EFI/NvStraps/NvStrapsDiagnostic.efi", diagnostic),
        ("EFI/NvStraps/plan.json", plan_bytes),
    ];
    // Refuse symlink/reparse destinations rather than following an existing tree into an ESP.
    if output.exists() {
        return Err("package destination must be a new directory".into());
    }
    fs::create_dir(output).map_err(|e| e.to_string())?;
    let mut manifest = Vec::new();
    for (name, bytes) in files {
        let destination = output.join(name);
        fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
        write_immutable(&destination, &bytes)?;
        manifest.push(serde_json::json!({"path":name,"sha256":digest(&bytes),"bytes":bytes.len()}));
    }
    let receipt = serde_json::json!({"schema":SCHEMA,"environment":plan.source.environment,"sourceSha256":plan.source_sha256,"handoff":plan.handoff,"files":manifest,"installState":"prepared","scope":"cold boot; existing decode windows; unbound non-console Turing GPU"});
    write_immutable(
        &output.join("manifest.json"),
        &serde_json::to_vec_pretty(&receipt).map_err(|e| e.to_string())?,
    )?;
    Ok(receipt)
}
pub fn inject(source: &Path, driver: &Path, output: &Path) -> Result<(), String> {
    let firmware = read_bounded(source, 64 * 1024 * 1024)?;
    let ffs = read_bounded(driver, 1024 * 1024)?;
    let plan = nvstraps_ffs::plan_ffs_injection(&firmware, &ffs).map_err(|e| e.to_string())?;
    if nvstraps_ffs::signed_update_covers_injection(&firmware, &plan) {
        return Err(
            "signed update covers injection; use the diagnostic-bound external route".into(),
        );
    }
    let (patched, _) = nvstraps_ffs::inject_ffs(&firmware, &ffs).map_err(|e| e.to_string())?;
    write_immutable(output, &patched)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn application_validation_rejects_driver_and_truncated_images() {
        for n in [0, 2, 64, 128] {
            assert!(validate_application(&vec![0; n]).is_err());
        }
        let mut b = vec![0; 256];
        b[..2].copy_from_slice(b"MZ");
        b[0x3c..0x40].copy_from_slice(&64u32.to_le_bytes());
        b[64..68].copy_from_slice(b"PE\0\0");
        b[68..70].copy_from_slice(&0x8664u16.to_le_bytes());
        b[88..90].copy_from_slice(&0x20bu16.to_le_bytes());
        b[156..158].copy_from_slice(&10u16.to_le_bytes());
        assert!(validate_application(&b).is_ok());
        b[156] = 11;
        assert!(validate_application(&b).is_err());
    }
    #[test]
    fn immutable_conflict_preserves_the_existing_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "nvstraps-external-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let file = dir.join("artifact");
        write_immutable(&file, b"first").unwrap();
        write_immutable(&file, b"first").unwrap();
        assert!(write_immutable(&file, b"second").is_err());
        assert_eq!(fs::read(&file).unwrap(), b"first");
    }
}
