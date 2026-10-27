use std::{
    collections::HashMap,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};

use nvstraps_external::{
    ESP_DIAGNOSTIC, ESP_LOADER, LAST_ERROR, MAX_REPORT_BYTES, OWNER, PLAN, Plan, RECEIPT_PREFIX,
    RECEIPT_SUFFIX, REMOVABLE_BOOT, REPORT, SCHEMA, Slot, Snapshot, digest, validate_plan,
};
use serde::{Deserialize, Serialize};

use crate::reject_link;

const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_OWNER_BYTES: u64 = 16 * 1024;
const MAX_RECEIPT_BYTES: u64 = 16 * 1024;
const MAX_ERROR_BYTES: u64 = 64 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Medium {
    Usb,
    Esp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Diagnostic,
    Loader,
}

pub struct Images<'a> {
    pub diagnostic: &'a [u8],
    pub loader: &'a [u8],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub medium: Medium,
    pub stage: Stage,
    pub stage_written_unix_ms: u64,
    pub boot_file_sha256: Option<[u8; 32]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub target: Option<Slot>,
    pub size_bytes: Option<u64>,
    pub bar1_base: u64,
    pub measured_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediumState {
    pub owner: Option<Owner>,
    pub foreign_boot_file: bool,
    pub report: Option<Vec<u8>>,
    pub plan: Option<Plan>,
    pub receipt: Option<Receipt>,
    pub last_error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OwnerFile {
    schema: u32,
    app: String,
    medium: Medium,
    stage: Stage,
    stage_written_unix_ms: u64,
    boot_file_sha256: Option<String>,
}

pub fn inspect(root: &Path, medium: Medium) -> Result<MediumState, String> {
    require_root(root)?;
    let owner = read_owner(root)?;
    let foreign_boot_file = if medium == Medium::Usb {
        usb_boot_is_foreign(root, owner.as_ref())?
    } else {
        false
    };
    let report = read_optional(root, REPORT, MAX_REPORT_BYTES as u64)?;
    let plan = read_optional(root, PLAN, MAX_REPORT_BYTES as u64)?
        .map(|bytes| {
            let plan: Plan = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            validate_plan(&plan, &plan.source)
                .map_err(|error| format!("invalid plan: {error:?}"))?;
            Ok::<Plan, String>(plan)
        })
        .transpose()?;
    let receipt = newest_receipt(root)?;
    let last_error = read_optional(root, LAST_ERROR, MAX_ERROR_BYTES)?
        .map(|bytes| String::from_utf8(bytes).map_err(|_| "last error is not UTF-8".to_owned()))
        .transpose()?;
    Ok(MediumState {
        owner,
        foreign_boot_file,
        report,
        plan,
        receipt,
        last_error,
    })
}

/// Writes the diagnostic image and starts a fresh diagnostic stage.
pub fn write_diagnostic_stage(
    root: &Path,
    medium: Medium,
    images: &Images<'_>,
    now_unix_ms: u64,
) -> Result<(), String> {
    require_root(root)?;
    let previous_owner = read_owner(root)?;
    refuse_foreign_usb_boot(root, medium, previous_owner.as_ref())?;
    ensure_layout(root, medium == Medium::Usb)?;
    remove_file_if_exists(root, REPORT)?;
    remove_file_if_exists(root, PLAN)?;
    delete_receipts(root)?;
    remove_file_if_exists(root, LAST_ERROR)?;
    let boot_file_sha256 = match medium {
        Medium::Usb => {
            atomic_write(root, REMOVABLE_BOOT, images.diagnostic)?;
            Some(digest(images.diagnostic))
        }
        Medium::Esp => {
            atomic_write(root, ESP_DIAGNOSTIC, images.diagnostic)?;
            None
        }
    };
    write_owner(
        root,
        &Owner {
            medium,
            stage: Stage::Diagnostic,
            stage_written_unix_ms: now_unix_ms,
            boot_file_sha256,
        },
    )
}

pub fn read_report(root: &Path) -> Result<Snapshot, String> {
    let bytes = read_required(root, REPORT, MAX_REPORT_BYTES as u64)?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

/// Writes a validated plan and the loader image, then records the loader stage.
pub fn write_loader_stage(
    root: &Path,
    medium: Medium,
    images: &Images<'_>,
    plan: &Plan,
    now_unix_ms: u64,
) -> Result<(), String> {
    validate_plan(plan, &plan.source).map_err(|error| format!("invalid plan: {error:?}"))?;
    require_root(root)?;
    let previous_owner = read_owner(root)?;
    refuse_foreign_usb_boot(root, medium, previous_owner.as_ref())?;
    ensure_layout(root, medium == Medium::Usb)?;
    let plan_bytes = serde_json::to_vec_pretty(plan).map_err(|error| error.to_string())?;
    atomic_write(root, PLAN, &plan_bytes)?;
    delete_receipts(root)?;
    remove_file_if_exists(root, LAST_ERROR)?;
    let boot_file_sha256 = match medium {
        Medium::Usb => {
            atomic_write(root, REMOVABLE_BOOT, images.loader)?;
            Some(digest(images.loader))
        }
        Medium::Esp => {
            atomic_write(root, ESP_LOADER, images.loader)?;
            None
        }
    };
    write_owner(
        root,
        &Owner {
            medium,
            stage: Stage::Loader,
            stage_written_unix_ms: now_unix_ms,
            boot_file_sha256,
        },
    )
}

/// Removes known NvStrapsReBar files while preserving every unrecognized file.
pub fn remove(root: &Path, medium: Medium) -> Result<(), String> {
    require_root(root)?;
    let owner = read_owner(root)?;
    let remove_boot = medium == Medium::Usb && usb_boot_is_owned(root, owner.as_ref())?;

    for path in [REPORT, PLAN, LAST_ERROR, ESP_DIAGNOSTIC, ESP_LOADER, OWNER] {
        remove_file_if_exists(root, path)?;
    }
    delete_receipts(root)?;
    remove_directory_if_empty(root, nvstraps_external::FOLDER)?;

    if medium == Medium::Usb {
        if remove_boot {
            remove_file_if_exists(root, REMOVABLE_BOOT)?;
        }
        let boot_directory = uefi_path(root, "\\EFI\\BOOT")?;
        reject_tree_path(root, &boot_directory)?;
        remove_directory_if_empty_path(&boot_directory)?;
    }
    Ok(())
}

fn write_owner(root: &Path, owner: &Owner) -> Result<(), String> {
    let wire = OwnerFile {
        schema: SCHEMA,
        app: "NvStrapsReBar".to_owned(),
        medium: owner.medium,
        stage: owner.stage,
        stage_written_unix_ms: owner.stage_written_unix_ms,
        boot_file_sha256: owner.boot_file_sha256.as_ref().map(|bytes| hex(bytes)),
    };
    let bytes = serde_json::to_vec_pretty(&wire).map_err(|error| error.to_string())?;
    atomic_write(root, OWNER, &bytes)
}

fn read_owner(root: &Path) -> Result<Option<Owner>, String> {
    read_optional(root, OWNER, MAX_OWNER_BYTES)?
        .map(|bytes| {
            let wire: OwnerFile =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            if wire.schema != SCHEMA || wire.app != "NvStrapsReBar" {
                return Err("owner record has an unsupported identity".to_owned());
            }
            let boot_file_sha256 = wire
                .boot_file_sha256
                .map(|value| decode_hash(&value))
                .transpose()?;
            if (wire.medium == Medium::Usb) != boot_file_sha256.is_some() {
                return Err("owner record has an inconsistent boot-file hash".to_owned());
            }
            Ok(Owner {
                medium: wire.medium,
                stage: wire.stage,
                stage_written_unix_ms: wire.stage_written_unix_ms,
                boot_file_sha256,
            })
        })
        .transpose()
}

fn refuse_foreign_usb_boot(
    root: &Path,
    medium: Medium,
    owner: Option<&Owner>,
) -> Result<(), String> {
    if medium == Medium::Usb && usb_boot_is_foreign(root, owner)? {
        return Err(format!(
            "foreign boot file: {} is not proven to belong to NvStrapsReBar",
            uefi_path(root, REMOVABLE_BOOT)?.display()
        ));
    }
    Ok(())
}

fn usb_boot_is_foreign(root: &Path, owner: Option<&Owner>) -> Result<bool, String> {
    let boot = uefi_path(root, REMOVABLE_BOOT)?;
    reject_tree_path(root, &boot)?;
    if fs::symlink_metadata(&boot).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(false);
    }
    if !boot.exists() {
        return Err(format!("cannot inspect {}", boot.display()));
    }
    Ok(!usb_boot_is_owned(root, owner)?)
}

fn usb_boot_is_owned(root: &Path, owner: Option<&Owner>) -> Result<bool, String> {
    let Some(expected) = owner
        .filter(|owner| owner.medium == Medium::Usb)
        .and_then(|owner| owner.boot_file_sha256)
    else {
        return Ok(false);
    };
    let boot = uefi_path(root, REMOVABLE_BOOT)?;
    let Some(actual) = file_digest(root, &boot)? else {
        return Ok(false);
    };
    Ok(actual == expected)
}

fn file_digest(root: &Path, path: &Path) -> Result<Option<[u8; 32]>, String> {
    reject_tree_path(root, path)?;
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Ok(None);
    }
    Ok(Some(digest(
        &fs::read(path).map_err(|error| error.to_string())?,
    )))
}

fn ensure_layout(root: &Path, boot_directory: bool) -> Result<(), String> {
    ensure_directory(root, "\\EFI")?;
    ensure_directory(root, nvstraps_external::FOLDER)?;
    if boot_directory {
        ensure_directory(root, "\\EFI\\BOOT")?;
    }
    Ok(())
}

fn ensure_directory(root: &Path, uefi: &str) -> Result<(), String> {
    let path = uefi_path(root, uefi)?;
    reject_tree_path(root, &path)?;
    match fs::create_dir(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn atomic_write(root: &Path, uefi: &str, bytes: &[u8]) -> Result<(), String> {
    let target = uefi_path(root, uefi)?;
    reject_tree_path(root, &target)?;
    let parent = target.parent().ok_or("output has no parent directory")?;
    if !parent.is_dir() {
        return Err(format!("output directory is missing: {}", parent.display()));
    }
    let name = target.file_name().ok_or("output has no file name")?;
    let mut temporary_name = OsString::from(".");
    temporary_name.push(name);
    temporary_name.push(format!(
        ".nvstraps-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let temporary = parent.join(temporary_name);
    reject_tree_path(root, &temporary)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, &target).map_err(|error| error.to_string())?;
        let readback = read_path(root, &target, bytes.len() as u64)?;
        if readback != bytes {
            return Err(format!("output readback mismatch: {}", target.display()));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_required(root: &Path, uefi: &str, limit: u64) -> Result<Vec<u8>, String> {
    let path = uefi_path(root, uefi)?;
    read_path(root, &path, limit)
}

fn read_optional(root: &Path, uefi: &str, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let path = uefi_path(root, uefi)?;
    reject_tree_path(root, &path)?;
    match fs::File::open(&path) {
        Ok(file) => read_open_file(file, &path, limit).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn read_path(root: &Path, path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    reject_tree_path(root, path)?;
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    read_open_file(file, path, limit)
}

fn read_open_file(file: fs::File, path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err(format!("not a regular file: {}", path.display()));
    }
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("file exceeds limit: {}", path.display()));
    }
    Ok(bytes)
}

fn delete_receipts(root: &Path) -> Result<(), String> {
    let folder = uefi_path(root, nvstraps_external::FOLDER)?;
    reject_tree_path(root, &folder)?;
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let mut receipts = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if is_receipt_name(&name) {
            receipts.push(entry.path());
        }
    }
    for receipt in receipts {
        reject_tree_path(root, &receipt)?;
        remove_file_path_if_exists(&receipt)?;
    }
    Ok(())
}

fn newest_receipt(root: &Path) -> Result<Option<Receipt>, String> {
    let folder = uefi_path(root, nvstraps_external::FOLDER)?;
    reject_tree_path(root, &folder)?;
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut newest: Option<(SystemTime, String, Receipt)> = None;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_receipt_name(&name) {
            continue;
        }
        let path = entry.path();
        reject_tree_path(root, &path)?;
        let modified = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .map_err(|error| error.to_string())?;
        let receipt = parse_receipt(&read_path(root, &path, MAX_RECEIPT_BYTES)?)?;
        let replace = newest
            .as_ref()
            .is_none_or(|(time, old_name, _)| (modified, &name) > (*time, old_name));
        if replace {
            newest = Some((modified, name, receipt));
        }
    }
    Ok(newest.map(|(_, _, receipt)| receipt))
}

fn parse_receipt(bytes: &[u8]) -> Result<Receipt, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "receipt is not UTF-8")?;
    let mut fields = HashMap::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .ok_or("receipt line has no equals sign")?;
        if fields.insert(key, value).is_some() {
            return Err(format!("receipt repeats {key}"));
        }
    }
    let known = [
        "schema",
        "environment",
        "source",
        "target",
        "sizeBytes",
        "bar1Base",
        "measuredBytes",
        "phase",
    ];
    if fields.keys().any(|key| !known.contains(key)) {
        return Err("receipt contains an unknown field".to_owned());
    }
    if fields.get("schema") != Some(&"1")
        || !matches!(
            fields.get("environment"),
            Some(&"Physical") | Some(&"QemuModel")
        )
        || fields.get("phase") != Some(&"before-handoff")
    {
        return Err("receipt header is invalid".to_owned());
    }
    decode_hash(required(&fields, "source")?)?;
    let target = fields
        .get("target")
        .map(|value| parse_slot(value))
        .transpose()?;
    let size_bytes = fields
        .get("sizeBytes")
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| "invalid receipt size".to_owned())
        })
        .transpose()?;
    let bar1_base = parse_prefixed_u64(required(&fields, "bar1Base")?)?;
    let measured_bytes = required(&fields, "measuredBytes")?
        .parse::<u64>()
        .map_err(|_| "invalid measured byte count".to_owned())?;
    Ok(Receipt {
        target,
        size_bytes,
        bar1_base,
        measured_bytes,
    })
}

fn required<'a>(fields: &'a HashMap<&str, &str>, key: &str) -> Result<&'a str, String> {
    fields
        .get(key)
        .copied()
        .ok_or_else(|| format!("receipt is missing {key}"))
}

fn parse_slot(value: &str) -> Result<Slot, String> {
    if value.len() != 12
        || value.as_bytes()[4] != b':'
        || value.as_bytes()[7] != b':'
        || value.as_bytes()[10] != b'.'
    {
        return Err("invalid receipt target".to_owned());
    }
    Ok(Slot {
        segment: parse_hex(&value[0..4])?,
        bus: u8::try_from(parse_hex(&value[5..7])?)
            .map_err(|_| "invalid receipt bus".to_owned())?,
        device: u8::try_from(parse_hex(&value[8..10])?)
            .map_err(|_| "invalid receipt device".to_owned())?,
        function: u8::try_from(parse_hex(&value[11..12])?)
            .map_err(|_| "invalid receipt function".to_owned())?,
    })
}

fn parse_hex(value: &str) -> Result<u32, String> {
    u32::from_str_radix(value, 16).map_err(|_| "invalid hexadecimal value".to_owned())
}

fn parse_prefixed_u64(value: &str) -> Result<u64, String> {
    let value = value
        .strip_prefix("0x")
        .ok_or("hexadecimal value has no 0x prefix")?;
    u64::from_str_radix(value, 16).map_err(|_| "invalid hexadecimal value".to_owned())
}

fn is_receipt_name(name: &str) -> bool {
    let prefix = RECEIPT_PREFIX.rsplit('\\').next().unwrap_or(RECEIPT_PREFIX);
    let Some(middle) = name
        .strip_prefix(prefix)
        .and_then(|name| name.strip_suffix(RECEIPT_SUFFIX))
    else {
        return false;
    };
    middle.len() == 8
        && middle
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn remove_file_if_exists(root: &Path, uefi: &str) -> Result<(), String> {
    let path = uefi_path(root, uefi)?;
    reject_tree_path(root, &path)?;
    remove_file_path_if_exists(&path)
}

fn remove_file_path_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_directory_if_empty(root: &Path, uefi: &str) -> Result<(), String> {
    let path = uefi_path(root, uefi)?;
    reject_tree_path(root, &path)?;
    remove_directory_if_empty_path(&path)
}

fn remove_directory_if_empty_path(path: &Path) -> Result<(), String> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn require_root(root: &Path) -> Result<(), String> {
    reject_link(root)?;
    if !root.is_dir() {
        return Err(format!(
            "medium root is not a directory: {}",
            root.display()
        ));
    }
    Ok(())
}

fn uefi_path(root: &Path, uefi: &str) -> Result<PathBuf, String> {
    let relative = uefi.strip_prefix('\\').ok_or("UEFI path is not absolute")?;
    let mut path = root.to_path_buf();
    for component in relative.split('\\') {
        if component.is_empty() || component == "." || component == ".." {
            return Err("UEFI path has an invalid component".to_owned());
        }
        path.push(component);
    }
    Ok(path)
}

fn reject_tree_path(root: &Path, path: &Path) -> Result<(), String> {
    reject_link(root)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "path escapes the medium root")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        reject_link(&current)?;
    }
    Ok(())
}

fn decode_hash(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("SHA-256 value must contain 64 hexadecimal digits".to_owned());
    }
    let mut bytes = [0; 32];
    for (index, output) in bytes.iter_mut().enumerate() {
        *output = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "invalid SHA-256 value")?;
    }
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use std::{thread, time::Duration};

    use nvstraps_external::{Handoff, make_plan};

    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "nvstraps-media-{name}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn images() -> Images<'static> {
        Images {
            diagnostic: b"diagnostic-image",
            loader: b"loader-image",
        }
    }

    fn fixture_plan() -> Plan {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/real-app/fixtures/external-diagnostic.json");
        let snapshot: Snapshot = serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
        make_plan(
            &snapshot,
            Slot {
                segment: 0,
                bus: 1,
                device: 0,
                function: 0,
            },
            8 << 30,
            Handoff {
                path: nvstraps_external::WINDOWS_BOOT_MANAGER.to_owned(),
                sha256: [1; 32],
            },
        )
        .unwrap()
    }

    #[test]
    fn writes_usb_and_esp_stages_with_atomic_owner_records() {
        let usb = TestRoot::new("usb-stages");
        write_diagnostic_stage(&usb.0, Medium::Usb, &images(), 10).unwrap();
        assert_eq!(
            fs::read(uefi_path(&usb.0, REMOVABLE_BOOT).unwrap()).unwrap(),
            images().diagnostic
        );
        let state = inspect(&usb.0, Medium::Usb).unwrap();
        assert_eq!(state.owner.unwrap().stage, Stage::Diagnostic);
        write_loader_stage(&usb.0, Medium::Usb, &images(), &fixture_plan(), 20).unwrap();
        assert_eq!(
            fs::read(uefi_path(&usb.0, REMOVABLE_BOOT).unwrap()).unwrap(),
            images().loader
        );
        assert_eq!(
            inspect(&usb.0, Medium::Usb).unwrap().owner.unwrap().stage,
            Stage::Loader
        );

        let esp = TestRoot::new("esp-stages");
        write_diagnostic_stage(&esp.0, Medium::Esp, &images(), 30).unwrap();
        assert_eq!(
            fs::read(uefi_path(&esp.0, ESP_DIAGNOSTIC).unwrap()).unwrap(),
            images().diagnostic
        );
        write_loader_stage(&esp.0, Medium::Esp, &images(), &fixture_plan(), 40).unwrap();
        assert_eq!(
            fs::read(uefi_path(&esp.0, ESP_LOADER).unwrap()).unwrap(),
            images().loader
        );
        assert_eq!(
            inspect(&esp.0, Medium::Esp)
                .unwrap()
                .owner
                .unwrap()
                .boot_file_sha256,
            None
        );
    }

    #[test]
    fn refuses_a_foreign_removable_boot_file_without_changing_it() {
        let root = TestRoot::new("foreign-refusal");
        fs::create_dir_all(root.0.join("EFI/BOOT")).unwrap();
        fs::write(root.0.join("EFI/BOOT/BOOTX64.EFI"), b"foreign").unwrap();
        let error = write_diagnostic_stage(&root.0, Medium::Usb, &images(), 10).unwrap_err();
        assert!(error.starts_with("foreign boot file:"));
        assert_eq!(
            fs::read(root.0.join("EFI/BOOT/BOOTX64.EFI")).unwrap(),
            b"foreign"
        );
    }

    #[test]
    fn owner_proof_allows_removing_the_usb_boot_file() {
        let root = TestRoot::new("owned-removal");
        write_diagnostic_stage(&root.0, Medium::Usb, &images(), 10).unwrap();
        remove(&root.0, Medium::Usb).unwrap();
        assert!(!root.0.join("EFI/BOOT/BOOTX64.EFI").exists());
        assert!(!root.0.join("EFI/NvStraps").exists());
    }

    #[test]
    fn removal_leaves_foreign_files_alone() {
        let root = TestRoot::new("foreign-removal");
        fs::create_dir_all(root.0.join("EFI/BOOT")).unwrap();
        fs::create_dir_all(root.0.join("EFI/NvStraps")).unwrap();
        fs::write(root.0.join("EFI/BOOT/BOOTX64.EFI"), b"foreign boot").unwrap();
        fs::write(root.0.join("EFI/NvStraps/notes.txt"), b"foreign notes").unwrap();
        fs::write(root.0.join("EFI/NvStraps/diagnostic.json"), b"ours").unwrap();
        remove(&root.0, Medium::Usb).unwrap();
        assert_eq!(
            fs::read(root.0.join("EFI/BOOT/BOOTX64.EFI")).unwrap(),
            b"foreign boot"
        );
        assert_eq!(
            fs::read(root.0.join("EFI/NvStraps/notes.txt")).unwrap(),
            b"foreign notes"
        );
        assert!(!root.0.join("EFI/NvStraps/diagnostic.json").exists());
    }

    #[test]
    fn selects_and_parses_the_newest_receipt() {
        let root = TestRoot::new("receipts");
        fs::create_dir_all(root.0.join("EFI/NvStraps")).unwrap();
        let source = "11".repeat(32);
        let old = format!(
            "schema=1\nenvironment=Physical\nsource={source}\ntarget=0000:01:00.0\nsizeBytes=4294967296\nbar1Base=0x200000000\nmeasuredBytes=4294967296\nphase=before-handoff\n"
        );
        fs::write(root.0.join("EFI/NvStraps/receipt-00000001.txt"), old).unwrap();
        thread::sleep(Duration::from_millis(20));
        let new = format!(
            "schema=1\nenvironment=Physical\nsource={source}\ntarget=0000:01:00.0\nsizeBytes=8589934592\nbar1Base=0x400000000\nmeasuredBytes=8589934592\nphase=before-handoff\n"
        );
        fs::write(root.0.join("EFI/NvStraps/receipt-00000002.txt"), new).unwrap();
        let receipt = inspect(&root.0, Medium::Esp).unwrap().receipt.unwrap();
        assert_eq!(
            receipt.target,
            Some(Slot {
                segment: 0,
                bus: 1,
                device: 0,
                function: 0
            })
        );
        assert_eq!(receipt.size_bytes, Some(8 << 30));
        assert_eq!(receipt.bar1_base, 0x4_0000_0000);
        assert_eq!(receipt.measured_bytes, 8 << 30);
    }

    #[test]
    fn receipt_parser_accepts_the_pre_target_format_and_rejects_bad_headers() {
        let source = "22".repeat(32);
        let receipt = parse_receipt(
            format!(
                "schema=1\nenvironment=Physical\nsource={source}\nbar1Base=0x200000000\nmeasuredBytes=8589934592\nphase=before-handoff\n"
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(receipt.target, None);
        assert_eq!(receipt.size_bytes, None);
        assert!(parse_receipt(b"schema=2\n").is_err());
    }
}
