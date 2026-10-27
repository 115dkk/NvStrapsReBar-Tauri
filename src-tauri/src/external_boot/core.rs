use std::{
    fmt::Write as _,
    path::{Path, PathBuf},
};

use nvstraps_external::{
    Environment, Handoff, PlanError, Slot, WINDOWS_BOOT_MANAGER, digest, make_plan,
};
use nvstraps_external_tool::{
    boot_entries::{
        self, BootChange, BootEntry, BootState, EntryKind, loader_first, owned_entry, scheduled,
        windows_boot_manager,
    },
    candidates,
    load_option::{
        boot_variable_name, decode_load_option, encode_boot_order, hard_drive_node,
        parse_boot_order,
    },
    media::{self, Images, Medium, MediumState, Stage},
    read_bounded, validate_application,
};
use serde::{Deserialize, Serialize};

use crate::{
    devices::GpuDevice,
    error::{BackendError, BackendResult},
};

const MAX_SUCCESSOR_BYTES: u64 = 32 * 1024 * 1024;
const EXTERNAL_SECURE_BOOT_ON: &str = "externalSecureBootOn";
const EXTERNAL_NO_ESP: &str = "externalNoEsp";
const EXTERNAL_FOREIGN_BOOT_FILE: &str = "externalForeignBootFile";
const EXTERNAL_NOT_FAT: &str = "externalNotFat";
const EXTERNAL_NO_REPORT: &str = "externalNoReport";
const EXTERNAL_PLAN: &str = "externalPlan";
const EXTERNAL_NOT_PHYSICAL: &str = "externalNotPhysical";
const EXTERNAL_BITLOCKER_SUSPENSION_REQUIRED: &str = "externalBitLockerSuspensionRequired";
const EXTERNAL_NO_RECEIPT: &str = "externalNoReceipt";
const EXTERNAL_MEDIUM_UNAVAILABLE: &str = "externalMediumUnavailable";
const EXTERNAL_WRITE: &str = "externalWrite";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EspVolume {
    pub partition_guid: String,
    pub root: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UsbVolume {
    pub root: String,
    pub path: PathBuf,
    pub label: String,
    pub file_system: String,
    pub total_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BitLocker {
    Off,
    On,
    Unknown,
}

pub(crate) trait ExternalPlatform {
    fn uefi(&self) -> bool;
    fn elevated(&self) -> bool;
    fn read_global(&self, name: &str) -> BackendResult<Option<Vec<u8>>>;
    fn write_global(&self, name: &str, value: &[u8]) -> BackendResult<()>;
    fn esp_volumes(&self) -> BackendResult<Vec<EspVolume>>;
    fn usb_volumes(&self) -> BackendResult<Vec<UsbVolume>>;
    fn bitlocker(&self) -> BitLocker;
    fn suspend_bitlocker_once(&self) -> BackendResult<()>;
    fn now_unix_ms(&self) -> u64;
    fn boot_time_unix_ms(&self) -> BackendResult<u64>;
    fn gpus(&self) -> Vec<GpuDevice>;
    fn reboot(&self) -> BackendResult<()>;
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ExternalMedium {
    Usb { root: String },
    Esp,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalReceipt {
    pub target: Option<String>,
    pub size_bytes: Option<u64>,
    pub bar1_base: String,
    pub measured_bytes: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalPlanSummary {
    pub target: Slot,
    pub size_bytes: u64,
    pub destination_start: String,
    pub successor_sha256: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalMediumState {
    pub stage: Option<Stage>,
    pub stage_written_unix_ms: Option<u64>,
    pub restarted_since_stage: bool,
    pub report: bool,
    pub plan: Option<ExternalPlanSummary>,
    pub receipt: Option<ExternalReceipt>,
    pub last_error: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExternalUsbProblem {
    NotFat,
    ForeignBootFile,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalUsbDrive {
    pub root: String,
    pub label: String,
    pub file_system: String,
    pub total_bytes: u64,
    pub usable: bool,
    pub problem: Option<ExternalUsbProblem>,
    pub state: Option<ExternalMediumState>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalInstallState {
    #[serde(flatten)]
    pub state: ExternalMediumState,
    pub diagnostic_entry: bool,
    pub loader_entry: bool,
    pub loader_first: bool,
    pub next_scheduled: Option<Stage>,
    pub successor_changed: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExternalEspReason {
    NoWindowsBootManager,
    VolumeNotFound,
    Unreadable,
    NotElevated,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalEspState {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub successor_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ExternalEspReason>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalBootStatus {
    pub uefi: bool,
    pub elevated: bool,
    pub secure_boot: Option<bool>,
    pub bit_locker: BitLocker,
    pub esp: ExternalEspState,
    pub install: Option<ExternalInstallState>,
    pub usb_drives: Vec<ExternalUsbDrive>,
    pub boot_time_unix_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalSizeOption {
    pub bytes: u64,
    pub error: Option<PlanError>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalCandidate {
    pub slot: Slot,
    pub name: Option<String>,
    pub product: u16,
    pub current_bar1_bytes: u64,
    pub recommended_bytes: Option<u64>,
    pub refusal: Option<PlanError>,
    pub sizes: Vec<ExternalSizeOption>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalReport {
    pub environment: Environment,
    pub firmware: String,
    pub secure_boot: Option<bool>,
    pub complete: bool,
    pub errors: Vec<String>,
    pub candidates: Vec<ExternalCandidate>,
}

pub(crate) fn inspect(platform: &impl ExternalPlatform) -> BackendResult<ExternalBootStatus> {
    let uefi = platform.uefi();
    let elevated = platform.elevated();
    let boot_time_unix_ms = platform.boot_time_unix_ms()?;
    let secure_boot = if uefi && elevated {
        read_secure_boot(platform).ok().flatten()
    } else {
        None
    };

    let boot = if uefi && elevated {
        read_boot_state(platform).ok()
    } else {
        None
    };
    let (esp, install) = inspect_esp(platform, elevated, boot.as_ref(), boot_time_unix_ms)?;
    let usb_drives = inspect_usb_drives(platform, boot_time_unix_ms)?;

    Ok(ExternalBootStatus {
        uefi,
        elevated,
        secure_boot,
        bit_locker: platform.bitlocker(),
        esp,
        install,
        usb_drives,
        boot_time_unix_ms,
    })
}

pub(crate) fn prepare_diagnostic(
    platform: &impl ExternalPlatform,
    medium: &ExternalMedium,
    images: &Images<'_>,
) -> BackendResult<ExternalBootStatus> {
    require_ready(platform, "prepare external boot media")?;
    refuse_secure_boot(platform)?;
    let resolved = resolve_medium(platform, medium)?;
    media::write_diagnostic_stage(
        &resolved.path,
        resolved.kind,
        images,
        platform.now_unix_ms(),
    )
    .map_err(media_error)?;
    if resolved.kind == Medium::Esp {
        let state = read_boot_state(platform)?;
        let (_, change) = boot_entries::schedule(&state, EntryKind::Diagnostic)
            .map_err(|error| external_error(EXTERNAL_WRITE, error))?;
        apply_boot_change(platform, &change)?;
    }
    inspect(platform)
}

pub(crate) fn read_report(
    platform: &impl ExternalPlatform,
    medium: &ExternalMedium,
) -> BackendResult<ExternalReport> {
    require_ready(platform, "read the external diagnostic report")?;
    let resolved = resolve_medium(platform, medium)?;
    let medium_state = media::inspect(&resolved.path, resolved.kind).map_err(media_error)?;
    if medium_state.report.is_none() {
        return Err(external_error(
            EXTERNAL_NO_REPORT,
            "the selected medium has no external diagnostic report",
        ));
    }
    let snapshot = media::read_report(&resolved.path).map_err(media_error)?;
    let (_, successor_hash) = resolve_successor(platform)?;
    let handoff = Handoff {
        path: WINDOWS_BOOT_MANAGER.to_owned(),
        sha256: successor_hash,
    };
    let windows_gpus = platform.gpus();
    let candidates = candidates::evaluate(&snapshot, &handoff)
        .into_iter()
        .map(|candidate| {
            let windows_gpu = windows_gpus.iter().find(|gpu| {
                candidate.slot.segment == 0
                    && candidate.slot.bus == gpu.bus
                    && candidate.slot.device == gpu.device
                    && candidate.slot.function == gpu.function
            });
            let selector = windows_gpu
                .and_then(|gpu| gpu.recommended_bar_size_selector)
                .or_else(|| nvstraps_core::registry::automatic_bar_size(candidate.product));
            ExternalCandidate {
                slot: candidate.slot,
                name: windows_gpu.map(|gpu| gpu.name.clone()),
                product: candidate.product,
                current_bar1_bytes: candidate.current_bar1_bytes,
                recommended_bytes: selector.and_then(nvstraps_core::registry::bar_size_bytes),
                refusal: candidate.refusal,
                sizes: candidate
                    .sizes
                    .into_iter()
                    .map(|size| ExternalSizeOption {
                        bytes: size.bytes,
                        error: size.error,
                    })
                    .collect(),
            }
        })
        .collect();
    Ok(ExternalReport {
        environment: snapshot.environment,
        firmware: snapshot.firmware,
        secure_boot: snapshot.secure_boot,
        complete: snapshot.enumeration_complete && snapshot.errors.is_empty(),
        errors: snapshot.errors,
        candidates,
    })
}

pub(crate) fn write_loader(
    platform: &impl ExternalPlatform,
    medium: &ExternalMedium,
    target: Slot,
    size_bytes: u64,
    images: &Images<'_>,
) -> BackendResult<ExternalBootStatus> {
    require_ready(platform, "write the external loader")?;
    refuse_secure_boot(platform)?;
    let resolved = resolve_medium(platform, medium)?;
    let state = media::inspect(&resolved.path, resolved.kind).map_err(media_error)?;
    if state.report.is_none() {
        return Err(external_error(
            EXTERNAL_NO_REPORT,
            "the selected medium has no external diagnostic report",
        ));
    }
    let snapshot = media::read_report(&resolved.path).map_err(media_error)?;
    if snapshot.environment != Environment::Physical {
        return Err(external_error(
            EXTERNAL_NOT_PHYSICAL,
            "only a physical diagnostic report can be used for external boot",
        ));
    }
    let (_, successor_hash) = resolve_successor(platform)?;
    let plan = make_plan(
        &snapshot,
        target,
        size_bytes,
        Handoff {
            path: WINDOWS_BOOT_MANAGER.to_owned(),
            sha256: successor_hash,
        },
    )
    .map_err(plan_error)?;
    media::write_loader_stage(
        &resolved.path,
        resolved.kind,
        images,
        &plan,
        platform.now_unix_ms(),
    )
    .map_err(media_error)?;
    if resolved.kind == Medium::Esp {
        let boot = read_boot_state(platform)?;
        let (_, change) = boot_entries::schedule(&boot, EntryKind::Loader)
            .map_err(|error| external_error(EXTERNAL_WRITE, error))?;
        apply_boot_change(platform, &change)?;
    }
    inspect(platform)
}

pub(crate) fn make_permanent(
    platform: &impl ExternalPlatform,
) -> BackendResult<ExternalBootStatus> {
    require_ready(platform, "make external boot permanent")?;
    let boot = read_boot_state(platform)?;
    let root = resolve_esp_root(platform, &boot)?;
    let medium = media::inspect(&root, Medium::Esp).map_err(media_error)?;
    if !matches!(medium.owner.as_ref(), Some(owner) if owner.medium == Medium::Esp && owner.stage == Stage::Loader)
    {
        return Err(external_error(
            EXTERNAL_WRITE,
            "the EFI System Partition is not in the external loader stage",
        ));
    }
    if medium.receipt.is_none() {
        return Err(external_error(
            EXTERNAL_NO_RECEIPT,
            "the external loader has not written a receipt",
        ));
    }

    let mut change =
        boot_entries::make_first(&boot).map_err(|error| external_error(EXTERNAL_WRITE, error))?;
    if let Some(diagnostic) = owned_entry(&boot, EntryKind::Diagnostic) {
        change.delete.push(diagnostic);
        let mut order = change.order.take().unwrap_or_else(|| boot.order.clone());
        order.retain(|number| *number != diagnostic);
        if order != boot.order {
            change.order = Some(order);
        }
        if boot.next == Some(diagnostic) {
            change.next = Some(None);
        }
    }
    apply_boot_change(platform, &change)?;
    inspect(platform)
}

pub(crate) fn remove(
    platform: &impl ExternalPlatform,
    medium: &ExternalMedium,
) -> BackendResult<ExternalBootStatus> {
    require_ready(platform, "remove external boot files")?;
    match medium {
        ExternalMedium::Esp => {
            let boot = read_boot_state(platform)?;
            let root = resolve_esp_root(platform, &boot)?;
            let change = boot_entries::remove_owned(&boot);
            apply_boot_change(platform, &change)?;
            media::remove(&root, Medium::Esp).map_err(media_error)?;
        }
        ExternalMedium::Usb { .. } => {
            let resolved = resolve_medium(platform, medium)?;
            media::remove(&resolved.path, Medium::Usb).map_err(media_error)?;
        }
    }
    inspect(platform)
}

pub(crate) fn restart(
    platform: &impl ExternalPlatform,
    suspend_bit_locker: bool,
) -> BackendResult<()> {
    require_ready(platform, "restart for external boot")?;
    if platform.bitlocker() == BitLocker::On {
        if !suspend_bit_locker {
            return Err(external_error(
                EXTERNAL_BITLOCKER_SUSPENSION_REQUIRED,
                "BitLocker protection must be suspended for this one restart",
            ));
        }
        platform.suspend_bitlocker_once()?;
    }
    platform.reboot()
}

struct ResolvedMedium {
    path: PathBuf,
    kind: Medium,
}

fn resolve_medium(
    platform: &impl ExternalPlatform,
    medium: &ExternalMedium,
) -> BackendResult<ResolvedMedium> {
    match medium {
        ExternalMedium::Esp => {
            let boot = read_boot_state(platform)?;
            Ok(ResolvedMedium {
                path: resolve_esp_root(platform, &boot)?,
                kind: Medium::Esp,
            })
        }
        ExternalMedium::Usb { root } => {
            let volume = platform
                .usb_volumes()?
                .into_iter()
                .find(|volume| volume.root.eq_ignore_ascii_case(root))
                .ok_or_else(|| {
                    external_error(
                        EXTERNAL_MEDIUM_UNAVAILABLE,
                        format!("USB drive {root} is unavailable"),
                    )
                })?;
            if !fat_file_system(&volume.file_system) {
                return Err(external_error(
                    EXTERNAL_NOT_FAT,
                    format!(
                        "USB drive {} uses {}; FAT or FAT32 is required",
                        volume.root, volume.file_system
                    ),
                ));
            }
            Ok(ResolvedMedium {
                path: volume.path,
                kind: Medium::Usb,
            })
        }
    }
}

fn resolve_esp_root(platform: &impl ExternalPlatform, boot: &BootState) -> BackendResult<PathBuf> {
    let windows = windows_boot_manager(boot).ok_or_else(|| {
        external_error(
            EXTERNAL_NO_ESP,
            "Windows Boot Manager is unavailable in BootOrder",
        )
    })?;
    let partition_guid = hard_drive_node(&windows.option.device_path)
        .and_then(|drive| drive.partition_guid())
        .ok_or_else(|| {
            external_error(
                EXTERNAL_NO_ESP,
                "Windows Boot Manager has no GPT partition GUID",
            )
        })?;
    platform
        .esp_volumes()?
        .into_iter()
        .find(|volume| volume.partition_guid.eq_ignore_ascii_case(&partition_guid))
        .map(|volume| volume.root)
        .ok_or_else(|| {
            external_error(
                EXTERNAL_NO_ESP,
                format!("the Windows EFI partition {partition_guid} is not mounted"),
            )
        })
}

fn resolve_successor(platform: &impl ExternalPlatform) -> BackendResult<(PathBuf, [u8; 32])> {
    let boot = read_boot_state(platform)?;
    let root = resolve_esp_root(platform, &boot)?;
    let bytes = read_successor(&root)?;
    Ok((root, digest(&bytes)))
}

fn inspect_esp(
    platform: &impl ExternalPlatform,
    elevated: bool,
    boot: Option<&BootState>,
    boot_time_unix_ms: u64,
) -> BackendResult<(ExternalEspState, Option<ExternalInstallState>)> {
    if !elevated {
        return Ok((esp_missing(ExternalEspReason::NotElevated), None));
    }
    let Some(boot) = boot else {
        return Ok((esp_missing(ExternalEspReason::Unreadable), None));
    };
    let Some(windows) = windows_boot_manager(boot) else {
        return Ok((esp_missing(ExternalEspReason::NoWindowsBootManager), None));
    };
    let Some(partition_guid) =
        hard_drive_node(&windows.option.device_path).and_then(|drive| drive.partition_guid())
    else {
        return Ok((esp_missing(ExternalEspReason::NoWindowsBootManager), None));
    };
    let volumes = match platform.esp_volumes() {
        Ok(volumes) => volumes,
        Err(_) => return Ok((esp_missing(ExternalEspReason::Unreadable), None)),
    };
    let Some(volume) = volumes
        .into_iter()
        .find(|volume| volume.partition_guid.eq_ignore_ascii_case(&partition_guid))
    else {
        return Ok((esp_missing(ExternalEspReason::VolumeNotFound), None));
    };
    let medium = media::inspect(&volume.root, Medium::Esp).map_err(media_error)?;
    let successor_hash = read_successor(&volume.root)
        .ok()
        .map(|bytes| digest(&bytes));
    let esp = successor_hash.map_or_else(
        || esp_missing(ExternalEspReason::Unreadable),
        |hash| ExternalEspState {
            found: true,
            successor_sha256: Some(hex(&hash)),
            reason: None,
        },
    );
    let has_owned_entry = owned_entry(boot, EntryKind::Diagnostic).is_some()
        || owned_entry(boot, EntryKind::Loader).is_some();
    let install = (medium_has_state(&medium) || has_owned_entry).then(|| {
        let successor_changed = medium
            .plan
            .as_ref()
            .is_some_and(|plan| successor_hash.is_some_and(|hash| plan.handoff.sha256 != hash));
        ExternalInstallState {
            state: external_medium_state(&medium, Medium::Esp, boot_time_unix_ms),
            diagnostic_entry: owned_entry(boot, EntryKind::Diagnostic).is_some(),
            loader_entry: owned_entry(boot, EntryKind::Loader).is_some(),
            loader_first: loader_first(boot),
            next_scheduled: scheduled(boot).map(entry_stage),
            successor_changed,
        }
    });
    Ok((esp, install))
}

fn inspect_usb_drives(
    platform: &impl ExternalPlatform,
    boot_time_unix_ms: u64,
) -> BackendResult<Vec<ExternalUsbDrive>> {
    platform
        .usb_volumes()?
        .into_iter()
        .map(|volume| {
            let state = media::inspect(&volume.path, Medium::Usb).map_err(media_error)?;
            let problem = if !fat_file_system(&volume.file_system) {
                Some(ExternalUsbProblem::NotFat)
            } else if state.foreign_boot_file {
                Some(ExternalUsbProblem::ForeignBootFile)
            } else {
                None
            };
            Ok(ExternalUsbDrive {
                root: volume.root,
                label: volume.label,
                file_system: volume.file_system,
                total_bytes: volume.total_bytes,
                usable: problem.is_none(),
                problem,
                state: medium_has_state(&state)
                    .then(|| external_medium_state(&state, Medium::Usb, boot_time_unix_ms)),
            })
        })
        .collect()
}

fn external_medium_state(
    state: &MediumState,
    expected_medium: Medium,
    boot_time_unix_ms: u64,
) -> ExternalMediumState {
    let owner = state
        .owner
        .as_ref()
        .filter(|owner| owner.medium == expected_medium);
    ExternalMediumState {
        stage: owner.map(|owner| owner.stage),
        stage_written_unix_ms: owner.map(|owner| owner.stage_written_unix_ms),
        restarted_since_stage: owner
            .is_some_and(|owner| boot_time_unix_ms > owner.stage_written_unix_ms),
        report: state.report.is_some(),
        plan: state.plan.as_ref().map(|plan| ExternalPlanSummary {
            target: plan.target,
            size_bytes: plan.size,
            destination_start: hex_u64(plan.destination.start),
            successor_sha256: hex(&plan.handoff.sha256),
        }),
        receipt: state.receipt.as_ref().map(|receipt| ExternalReceipt {
            target: receipt.target.map(slot_string),
            size_bytes: receipt.size_bytes,
            bar1_base: hex_u64(receipt.bar1_base),
            measured_bytes: receipt.measured_bytes,
        }),
        last_error: state.last_error.clone(),
    }
}

fn medium_has_state(state: &MediumState) -> bool {
    state.owner.is_some()
        || state.report.is_some()
        || state.plan.is_some()
        || state.receipt.is_some()
        || state.last_error.is_some()
}

fn read_boot_state(platform: &impl ExternalPlatform) -> BackendResult<BootState> {
    let order = match read_global(platform, "BootOrder")? {
        Some(bytes) => {
            parse_boot_order(&bytes).map_err(|error| external_error(EXTERNAL_WRITE, error))?
        }
        None => Vec::new(),
    };
    let mut entries = Vec::new();
    for number in &order {
        let name = boot_variable_name(*number);
        let Some(bytes) = read_global(platform, &name)? else {
            continue;
        };
        let option = decode_load_option(&bytes)
            .map_err(|error| external_error(EXTERNAL_WRITE, format!("{name}: {error}")))?;
        entries.push(BootEntry {
            number: *number,
            option,
        });
    }
    Ok(BootState {
        order,
        next: read_optional_u16(platform, "BootNext")?,
        current: read_optional_u16(platform, "BootCurrent")?,
        entries,
    })
}

fn apply_boot_change(platform: &impl ExternalPlatform, change: &BootChange) -> BackendResult<()> {
    for (number, value) in &change.write {
        let name = boot_variable_name(*number);
        write_global(platform, &name, value)?;
        verify_global(platform, &name, Some(value.as_slice()))?;
    }
    for number in &change.delete {
        let name = boot_variable_name(*number);
        write_global(platform, &name, &[])?;
        verify_global(platform, &name, None)?;
    }
    if let Some(order) = &change.order {
        let value = encode_boot_order(order);
        write_global(platform, "BootOrder", &value)?;
        verify_global(platform, "BootOrder", Some(&value))?;
    }
    if let Some(next) = change.next {
        match next {
            Some(number) => {
                let value = number.to_le_bytes();
                write_global(platform, "BootNext", &value)?;
                verify_global(platform, "BootNext", Some(&value))?;
            }
            None => {
                write_global(platform, "BootNext", &[])?;
                verify_global(platform, "BootNext", None)?;
            }
        }
    }
    Ok(())
}

fn verify_global(
    platform: &impl ExternalPlatform,
    name: &str,
    expected: Option<&[u8]>,
) -> BackendResult<()> {
    let actual = read_global(platform, name)?;
    if actual.as_deref() != expected {
        return Err(external_error(
            EXTERNAL_WRITE,
            format!("firmware variable {name} failed readback verification"),
        ));
    }
    Ok(())
}

fn read_optional_u16(platform: &impl ExternalPlatform, name: &str) -> BackendResult<Option<u16>> {
    read_global(platform, name)?
        .map(|bytes| {
            let bytes: [u8; 2] = bytes.try_into().map_err(|bytes: Vec<u8>| {
                external_error(
                    EXTERNAL_WRITE,
                    format!("firmware variable {name} is {} bytes, not 2", bytes.len()),
                )
            })?;
            Ok(u16::from_le_bytes(bytes))
        })
        .transpose()
}

fn read_secure_boot(platform: &impl ExternalPlatform) -> BackendResult<Option<bool>> {
    read_global(platform, "SecureBoot")?
        .map(|bytes| match bytes.as_slice() {
            [0] => Ok(false),
            [1] => Ok(true),
            _ => Err(external_error(
                EXTERNAL_WRITE,
                "SecureBoot is not a one-byte Boolean",
            )),
        })
        .transpose()
}

fn refuse_secure_boot(platform: &impl ExternalPlatform) -> BackendResult<()> {
    if read_secure_boot(platform)? == Some(true) {
        Err(external_error(
            EXTERNAL_SECURE_BOOT_ON,
            "Secure Boot is on; the external EFI applications are unsigned",
        ))
    } else {
        Ok(())
    }
}

fn read_global(platform: &impl ExternalPlatform, name: &str) -> BackendResult<Option<Vec<u8>>> {
    if !read_name_allowed(name) {
        return Err(external_error(
            EXTERNAL_WRITE,
            format!("firmware variable read is not allowed: {name}"),
        ));
    }
    platform.read_global(name)
}

fn write_global(platform: &impl ExternalPlatform, name: &str, value: &[u8]) -> BackendResult<()> {
    if !write_name_allowed(name) {
        return Err(external_error(
            EXTERNAL_WRITE,
            format!("firmware variable write is not allowed: {name}"),
        ));
    }
    platform.write_global(name, value)
}

pub(crate) fn read_name_allowed(name: &str) -> bool {
    matches!(
        name,
        "BootOrder" | "BootNext" | "BootCurrent" | "SecureBoot"
    ) || boot_entry_name(name)
}

pub(crate) fn write_name_allowed(name: &str) -> bool {
    matches!(name, "BootOrder" | "BootNext") || boot_entry_name(name)
}

fn boot_entry_name(name: &str) -> bool {
    name.len() == 8
        && name.starts_with("Boot")
        && name[4..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
}

fn read_successor(root: &Path) -> BackendResult<Vec<u8>> {
    let path = uefi_path(root, WINDOWS_BOOT_MANAGER)?;
    let bytes = read_bounded(&path, MAX_SUCCESSOR_BYTES).map_err(|error| {
        external_error(
            EXTERNAL_NO_ESP,
            format!(
                "Windows Boot Manager could not be read at {}: {error}",
                path.display()
            ),
        )
    })?;
    validate_application(&bytes).map_err(|error| {
        external_error(
            EXTERNAL_NO_ESP,
            format!(
                "Windows Boot Manager is invalid at {}: {error}",
                path.display()
            ),
        )
    })?;
    Ok(bytes)
}

fn uefi_path(root: &Path, path: &str) -> BackendResult<PathBuf> {
    let relative = path
        .strip_prefix('\\')
        .ok_or_else(|| external_error(EXTERNAL_WRITE, "UEFI path is not absolute"))?;
    let mut output = root.to_path_buf();
    for component in relative.split('\\') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(external_error(
                EXTERNAL_WRITE,
                "UEFI path contains an invalid component",
            ));
        }
        output.push(component);
    }
    Ok(output)
}

fn require_ready(platform: &impl ExternalPlatform, operation: &'static str) -> BackendResult<()> {
    if !platform.uefi() {
        return Err(BackendError::UnsupportedPlatform);
    }
    if !platform.elevated() {
        return Err(BackendError::AdministratorRequired(operation));
    }
    Ok(())
}

fn fat_file_system(file_system: &str) -> bool {
    file_system.eq_ignore_ascii_case("FAT") || file_system.eq_ignore_ascii_case("FAT32")
}

fn entry_stage(kind: EntryKind) -> Stage {
    match kind {
        EntryKind::Diagnostic => Stage::Diagnostic,
        EntryKind::Loader => Stage::Loader,
    }
}

fn esp_missing(reason: ExternalEspReason) -> ExternalEspState {
    ExternalEspState {
        found: false,
        successor_sha256: None,
        reason: Some(reason),
    }
}

fn slot_string(slot: Slot) -> String {
    format!(
        "{:04x}:{:02x}:{:02x}.{:x}",
        slot.segment, slot.bus, slot.device, slot.function
    )
}

fn hex_u64(value: u64) -> String {
    format!("0x{value:x}")
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn plan_error(error: PlanError) -> BackendError {
    let message = serde_json::to_value(error)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("{error:?}"));
    external_error(EXTERNAL_PLAN, message)
}

fn media_error(message: String) -> BackendError {
    let code = if message.starts_with("foreign boot file:") {
        EXTERNAL_FOREIGN_BOOT_FILE
    } else {
        EXTERNAL_WRITE
    };
    external_error(code, message)
}

fn external_error(code: &'static str, message: impl Into<String>) -> BackendError {
    BackendError::External {
        code,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        cell::{Cell, RefCell},
        collections::BTreeMap,
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    use nvstraps_external::{ESP_DIAGNOSTIC, ESP_LOADER, REMOVABLE_BOOT, REPORT};
    use nvstraps_external_tool::load_option::{
        HardDrive, LOAD_OPTION_ACTIVE, LoadOption, encode_load_option, partition_file_device_path,
    };

    use crate::devices::PciBridge;

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    const PARTITION_GUID: &str = "02d5d49a-d31c-11eb-9de1-d850e6dcccd2";
    const USB_ROOT: &str = "U:\\";
    const NOW: u64 = 1_793_000_000_000;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "nvstraps-external-core-{name}-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct FakePlatform {
        uefi: Cell<bool>,
        elevated: Cell<bool>,
        variables: RefCell<BTreeMap<String, Vec<u8>>>,
        variable_writes: RefCell<Vec<(String, Vec<u8>)>>,
        esp_volumes: RefCell<Vec<EspVolume>>,
        usb_volumes: RefCell<Vec<UsbVolume>>,
        bit_locker: Cell<BitLocker>,
        bit_locker_suspensions: Cell<u64>,
        now: Cell<u64>,
        boot_time: Cell<u64>,
        gpus: Vec<GpuDevice>,
        reboots: Cell<u64>,
    }

    impl ExternalPlatform for FakePlatform {
        fn uefi(&self) -> bool {
            self.uefi.get()
        }

        fn elevated(&self) -> bool {
            self.elevated.get()
        }

        fn read_global(&self, name: &str) -> BackendResult<Option<Vec<u8>>> {
            Ok(self.variables.borrow().get(name).cloned())
        }

        fn write_global(&self, name: &str, value: &[u8]) -> BackendResult<()> {
            self.variable_writes
                .borrow_mut()
                .push((name.to_owned(), value.to_vec()));
            if value.is_empty() {
                self.variables.borrow_mut().remove(name);
            } else {
                self.variables
                    .borrow_mut()
                    .insert(name.to_owned(), value.to_vec());
            }
            Ok(())
        }

        fn esp_volumes(&self) -> BackendResult<Vec<EspVolume>> {
            Ok(self.esp_volumes.borrow().clone())
        }

        fn usb_volumes(&self) -> BackendResult<Vec<UsbVolume>> {
            Ok(self.usb_volumes.borrow().clone())
        }

        fn bitlocker(&self) -> BitLocker {
            self.bit_locker.get()
        }

        fn suspend_bitlocker_once(&self) -> BackendResult<()> {
            self.bit_locker_suspensions
                .set(self.bit_locker_suspensions.get() + 1);
            Ok(())
        }

        fn now_unix_ms(&self) -> u64 {
            self.now.get()
        }

        fn boot_time_unix_ms(&self) -> BackendResult<u64> {
            Ok(self.boot_time.get())
        }

        fn gpus(&self) -> Vec<GpuDevice> {
            self.gpus.clone()
        }

        fn reboot(&self) -> BackendResult<()> {
            self.reboots.set(self.reboots.get() + 1);
            Ok(())
        }
    }

    struct Fixture {
        _directory: TestDirectory,
        platform: FakePlatform,
        esp: PathBuf,
        usb: PathBuf,
        foreign_boot: Vec<u8>,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let directory = TestDirectory::new(name);
            let esp = directory.0.join("esp");
            let usb = directory.0.join("usb-u");
            fs::create_dir_all(uefi_path_for_test(&esp, WINDOWS_BOOT_MANAGER)).unwrap();
            fs::create_dir(&usb).unwrap();
            fs::write(
                uefi_file_for_test(&esp, WINDOWS_BOOT_MANAGER),
                application_image(1),
            )
            .unwrap();

            let foreign_option = encode_load_option(&LoadOption {
                attributes: LOAD_OPTION_ACTIVE,
                description: "Foreign entry".into(),
                device_path: partition_file_device_path(&drive(), "\\EFI\\Other\\foreign.efi"),
                optional_data: vec![7, 8, 9],
            });
            let windows_option = encode_load_option(&LoadOption {
                attributes: LOAD_OPTION_ACTIVE,
                description: "Windows Boot Manager".into(),
                device_path: partition_file_device_path(&drive(), WINDOWS_BOOT_MANAGER),
                optional_data: vec![1, 2, 3],
            });
            let variables = BTreeMap::from([
                ("BootOrder".into(), encode_boot_order(&[0, 4])),
                ("Boot0000".into(), foreign_option.clone()),
                ("Boot0004".into(), windows_option),
                ("BootCurrent".into(), 4_u16.to_le_bytes().to_vec()),
                ("SecureBoot".into(), vec![0]),
            ]);
            let platform = FakePlatform {
                uefi: Cell::new(true),
                elevated: Cell::new(true),
                variables: RefCell::new(variables),
                variable_writes: RefCell::new(Vec::new()),
                esp_volumes: RefCell::new(vec![EspVolume {
                    partition_guid: PARTITION_GUID.into(),
                    root: esp.clone(),
                }]),
                usb_volumes: RefCell::new(vec![UsbVolume {
                    root: USB_ROOT.into(),
                    path: usb.clone(),
                    label: "NVSTRAPS".into(),
                    file_system: "FAT32".into(),
                    total_bytes: 8_000_000_000,
                }]),
                bit_locker: Cell::new(BitLocker::Off),
                bit_locker_suspensions: Cell::new(0),
                now: Cell::new(NOW),
                boot_time: Cell::new(NOW - 10_000),
                gpus: vec![windows_gpu()],
                reboots: Cell::new(0),
            };
            Self {
                _directory: directory,
                platform,
                esp,
                usb,
                foreign_boot: foreign_option,
            }
        }

        fn images(&self) -> Images<'static> {
            Images {
                diagnostic: b"diagnostic-image",
                loader: b"loader-image",
            }
        }

        fn write_report(&self, root: &Path) {
            let target = uefi_file_for_test(root, REPORT);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::copy(report_fixture(), target).unwrap();
        }

        fn consume_boot_next(&self) {
            self.platform.variables.borrow_mut().remove("BootNext");
        }

        fn write_receipt(&self, root: &Path) {
            let target = root.join("EFI/NvStraps/receipt-00000001.txt");
            fs::write(
                target,
                format!(
                    "schema=1\nenvironment=Physical\nsource={}\ntarget=0000:01:00.0\nsizeBytes=8589934592\nbar1Base=0x400000000\nmeasuredBytes=8589934592\nphase=before-handoff\n",
                    "11".repeat(32)
                ),
            )
            .unwrap();
        }

        fn assert_foreign_untouched(&self) {
            assert_eq!(
                self.platform.variables.borrow().get("Boot0000"),
                Some(&self.foreign_boot)
            );
            assert!(
                self.platform
                    .variable_writes
                    .borrow()
                    .iter()
                    .all(|(name, _)| name != "Boot0000")
            );
        }
    }

    fn drive() -> HardDrive {
        HardDrive {
            partition_number: 1,
            start_lba: 2048,
            size_lba: 1_000_000,
            signature: [
                0x9a, 0xd4, 0xd5, 0x02, 0x1c, 0xd3, 0xeb, 0x11, 0x9d, 0xe1, 0xd8, 0x50, 0xe6, 0xdc,
                0xcc, 0xd2,
            ],
            mbr_type: 2,
            signature_type: 2,
        }
    }

    fn windows_gpu() -> GpuDevice {
        GpuDevice {
            id: "pci-01-00-0".into(),
            name: "NVIDIA GeForce RTX 2080 SUPER".into(),
            vendor_id: 0x10de,
            device_id: 0x1e81,
            subsystem_vendor_id: 0x1462,
            subsystem_device_id: 0x3755,
            bus: 1,
            device: 0,
            function: 0,
            bridge: PciBridge {
                vendor_id: 0x8086,
                device_id: 1,
                bus: 0,
                device: 1,
                function: 0,
            },
            bar0_base: 0x8000_0000,
            bar0_top: 0x80ff_ffff,
            current_bar_size: 256 << 20,
            dedicated_video_memory: 8 << 30,
            is_turing: true,
            recommended_bar_size_selector: Some(7),
            registry_bar_size_selector: Some(7),
            effective_bar_size_selector: None,
        }
    }

    fn report_fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/real-app/fixtures/external-diagnostic.json")
    }

    fn application_image(marker: u8) -> Vec<u8> {
        let mut bytes = vec![0; 256];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&64_u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        bytes[68..70].copy_from_slice(&0x8664_u16.to_le_bytes());
        bytes[88..90].copy_from_slice(&0x20b_u16.to_le_bytes());
        bytes[156..158].copy_from_slice(&10_u16.to_le_bytes());
        bytes[255] = marker;
        bytes
    }

    fn uefi_file_for_test(root: &Path, uefi: &str) -> PathBuf {
        let mut path = root.to_path_buf();
        for component in uefi.trim_start_matches('\\').split('\\') {
            path.push(component);
        }
        path
    }

    fn uefi_path_for_test(root: &Path, uefi: &str) -> PathBuf {
        uefi_file_for_test(root, uefi)
            .parent()
            .unwrap()
            .to_path_buf()
    }

    fn variable_u16(platform: &FakePlatform, name: &str) -> Option<u16> {
        platform.variables.borrow().get(name).map(|bytes| {
            u16::from_le_bytes(bytes.as_slice().try_into().expect("two-byte variable"))
        })
    }

    fn boot_order(platform: &FakePlatform) -> Vec<u16> {
        parse_boot_order(
            platform
                .variables
                .borrow()
                .get("BootOrder")
                .expect("BootOrder"),
        )
        .unwrap()
    }

    fn error_code(error: BackendError) -> &'static str {
        match error {
            BackendError::External { code, .. } => code,
            other => panic!("expected external error, got {other}"),
        }
    }

    #[test]
    fn firmware_variable_allow_lists_are_exact() {
        for name in [
            "BootOrder",
            "BootNext",
            "BootCurrent",
            "SecureBoot",
            "Boot0000",
            "Boot09AF",
        ] {
            assert!(read_name_allowed(name));
        }
        for name in ["BootCurrent", "SecureBoot"] {
            assert!(!write_name_allowed(name));
        }
        for name in ["Boot000", "Boot00000", "Boot00af", "Other0000"] {
            assert!(!read_name_allowed(name));
            assert!(!write_name_allowed(name));
        }
    }

    #[test]
    fn inspect_reports_no_esp_secure_boot_and_missing_elevation_without_writing() {
        let fixture = Fixture::new("inspect-conditions");
        fixture.platform.esp_volumes.borrow_mut().clear();
        let status = inspect(&fixture.platform).unwrap();
        assert_eq!(status.esp.reason, Some(ExternalEspReason::VolumeNotFound));
        assert!(!status.esp.found);

        fixture
            .platform
            .variables
            .borrow_mut()
            .insert("SecureBoot".into(), vec![1]);
        let status = inspect(&fixture.platform).unwrap();
        assert_eq!(status.secure_boot, Some(true));
        assert_eq!(
            error_code(
                prepare_diagnostic(
                    &fixture.platform,
                    &ExternalMedium::Usb {
                        root: USB_ROOT.into(),
                    },
                    &fixture.images(),
                )
                .unwrap_err()
            ),
            EXTERNAL_SECURE_BOOT_ON
        );

        fixture.platform.elevated.set(false);
        let status = inspect(&fixture.platform).unwrap();
        assert_eq!(status.esp.reason, Some(ExternalEspReason::NotElevated));
        assert!(matches!(
            prepare_diagnostic(&fixture.platform, &ExternalMedium::Esp, &fixture.images()),
            Err(BackendError::AdministratorRequired(_))
        ));
        assert!(fixture.platform.variable_writes.borrow().is_empty());
    }

    #[test]
    fn full_install_sequence_preserves_foreign_boot_configuration_and_removes_ours() {
        let fixture = Fixture::new("install-sequence");
        let medium = ExternalMedium::Esp;

        let prepared = prepare_diagnostic(&fixture.platform, &medium, &fixture.images()).unwrap();
        assert_eq!(boot_order(&fixture.platform), [0, 4, 1]);
        assert_eq!(variable_u16(&fixture.platform, "BootNext"), Some(1));
        assert!(fixture.platform.variables.borrow().contains_key("Boot0001"));
        assert_eq!(
            fs::read(uefi_file_for_test(&fixture.esp, ESP_DIAGNOSTIC)).unwrap(),
            b"diagnostic-image"
        );
        assert_eq!(
            prepared.install.as_ref().unwrap().state.stage,
            Some(Stage::Diagnostic)
        );
        fixture.assert_foreign_untouched();

        fixture.consume_boot_next();
        fixture.write_report(&fixture.esp);
        fixture.platform.boot_time.set(NOW + 1);
        let report = read_report(&fixture.platform, &medium).unwrap();
        assert_eq!(report.environment, Environment::Physical);
        assert!(report.complete);
        assert_eq!(report.candidates.len(), 1);
        assert_eq!(
            report.candidates[0].name.as_deref(),
            Some("NVIDIA GeForce RTX 2080 SUPER")
        );
        assert_eq!(report.candidates[0].recommended_bytes, Some(8 << 30));

        fixture.platform.now.set(NOW + 2);
        let loader = write_loader(
            &fixture.platform,
            &medium,
            Slot {
                segment: 0,
                bus: 1,
                device: 0,
                function: 0,
            },
            8 << 30,
            &fixture.images(),
        )
        .unwrap();
        assert_eq!(boot_order(&fixture.platform), [0, 4, 1, 2]);
        assert_eq!(variable_u16(&fixture.platform, "BootNext"), Some(2));
        assert!(fixture.platform.variables.borrow().contains_key("Boot0001"));
        assert!(fixture.platform.variables.borrow().contains_key("Boot0002"));
        assert_eq!(
            fs::read(uefi_file_for_test(&fixture.esp, ESP_LOADER)).unwrap(),
            b"loader-image"
        );
        assert_eq!(
            loader.install.as_ref().unwrap().state.stage,
            Some(Stage::Loader)
        );
        fixture.assert_foreign_untouched();

        fixture.consume_boot_next();
        fixture.write_receipt(&fixture.esp);
        fixture.platform.boot_time.set(NOW + 3);
        let permanent = make_permanent(&fixture.platform).unwrap();
        assert_eq!(boot_order(&fixture.platform), [2, 0, 4]);
        assert_eq!(variable_u16(&fixture.platform, "BootNext"), None);
        assert!(!fixture.platform.variables.borrow().contains_key("Boot0001"));
        assert!(fixture.platform.variables.borrow().contains_key("Boot0002"));
        let install = permanent.install.unwrap();
        assert!(install.loader_first);
        assert!(install.state.receipt.is_some());
        fixture.assert_foreign_untouched();

        let removed = remove(&fixture.platform, &medium).unwrap();
        assert_eq!(boot_order(&fixture.platform), [0, 4]);
        assert_eq!(variable_u16(&fixture.platform, "BootNext"), None);
        assert!(!fixture.platform.variables.borrow().contains_key("Boot0001"));
        assert!(!fixture.platform.variables.borrow().contains_key("Boot0002"));
        assert!(removed.install.is_none());
        assert!(!uefi_file_for_test(&fixture.esp, ESP_DIAGNOSTIC).exists());
        assert!(!uefi_file_for_test(&fixture.esp, ESP_LOADER).exists());
        assert!(!fixture.esp.join("EFI/NvStraps").exists());
        fixture.assert_foreign_untouched();
    }

    #[test]
    fn usb_sequence_never_writes_a_firmware_variable() {
        let fixture = Fixture::new("usb-sequence");
        let medium = ExternalMedium::Usb {
            root: USB_ROOT.into(),
        };
        prepare_diagnostic(&fixture.platform, &medium, &fixture.images()).unwrap();
        assert_eq!(
            fs::read(uefi_file_for_test(&fixture.usb, REMOVABLE_BOOT)).unwrap(),
            b"diagnostic-image"
        );
        fixture.write_report(&fixture.usb);
        read_report(&fixture.platform, &medium).unwrap();
        write_loader(
            &fixture.platform,
            &medium,
            Slot {
                segment: 0,
                bus: 1,
                device: 0,
                function: 0,
            },
            8 << 30,
            &fixture.images(),
        )
        .unwrap();
        assert_eq!(
            fs::read(uefi_file_for_test(&fixture.usb, REMOVABLE_BOOT)).unwrap(),
            b"loader-image"
        );
        fixture.write_receipt(&fixture.usb);
        remove(&fixture.platform, &medium).unwrap();
        assert!(!uefi_file_for_test(&fixture.usb, REMOVABLE_BOOT).exists());
        assert!(fixture.platform.variable_writes.borrow().is_empty());
    }

    #[test]
    fn foreign_usb_boot_file_maps_to_the_typed_refusal() {
        let fixture = Fixture::new("foreign-usb");
        let boot = uefi_file_for_test(&fixture.usb, REMOVABLE_BOOT);
        fs::create_dir_all(boot.parent().unwrap()).unwrap();
        fs::write(&boot, b"foreign").unwrap();
        let error = prepare_diagnostic(
            &fixture.platform,
            &ExternalMedium::Usb {
                root: USB_ROOT.into(),
            },
            &fixture.images(),
        )
        .unwrap_err();
        assert_eq!(error_code(error), EXTERNAL_FOREIGN_BOOT_FILE);
        assert_eq!(fs::read(boot).unwrap(), b"foreign");
        assert!(fixture.platform.variable_writes.borrow().is_empty());
    }

    #[test]
    fn restart_refuses_bitlocker_without_consent_and_suspends_exactly_once_with_it() {
        let fixture = Fixture::new("bitlocker");
        fixture.platform.bit_locker.set(BitLocker::On);

        let error = restart(&fixture.platform, false).unwrap_err();
        assert_eq!(error_code(error), EXTERNAL_BITLOCKER_SUSPENSION_REQUIRED);
        assert_eq!(fixture.platform.bit_locker_suspensions.get(), 0);
        assert_eq!(fixture.platform.reboots.get(), 0);

        restart(&fixture.platform, true).unwrap();
        assert_eq!(fixture.platform.bit_locker_suspensions.get(), 1);
        assert_eq!(fixture.platform.reboots.get(), 1);
    }

    #[test]
    fn successor_change_is_reported_after_the_plan_is_written() {
        let fixture = Fixture::new("successor-change");
        let medium = ExternalMedium::Esp;
        prepare_diagnostic(&fixture.platform, &medium, &fixture.images()).unwrap();
        fixture.write_report(&fixture.esp);
        let status = write_loader(
            &fixture.platform,
            &medium,
            Slot {
                segment: 0,
                bus: 1,
                device: 0,
                function: 0,
            },
            8 << 30,
            &fixture.images(),
        )
        .unwrap();
        assert!(!status.install.unwrap().successor_changed);

        fs::write(
            uefi_file_for_test(&fixture.esp, WINDOWS_BOOT_MANAGER),
            application_image(2),
        )
        .unwrap();
        assert!(
            inspect(&fixture.platform)
                .unwrap()
                .install
                .unwrap()
                .successor_changed
        );
    }

    #[test]
    fn status_json_matches_the_frontend_contract_shape() {
        let fixture = Fixture::new("status-json");
        prepare_diagnostic(&fixture.platform, &ExternalMedium::Esp, &fixture.images()).unwrap();
        let value = serde_json::to_value(inspect(&fixture.platform).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "uefi": true,
                "elevated": true,
                "secureBoot": false,
                "bitLocker": "off",
                "esp": {
                    "found": true,
                    "successorSha256": "da78fe72754830a6478d7fb4091669d08cd1ff1aeb7c1468c784e769c081460a"
                },
                "install": {
                    "stage": "diagnostic",
                    "stageWrittenUnixMs": NOW,
                    "restartedSinceStage": false,
                    "report": false,
                    "plan": null,
                    "receipt": null,
                    "lastError": null,
                    "diagnosticEntry": true,
                    "loaderEntry": false,
                    "loaderFirst": false,
                    "nextScheduled": "diagnostic",
                    "successorChanged": false
                },
                "usbDrives": [{
                    "root": USB_ROOT,
                    "label": "NVSTRAPS",
                    "fileSystem": "FAT32",
                    "totalBytes": 8_000_000_000_u64,
                    "usable": true,
                    "problem": null,
                    "state": null
                }],
                "bootTimeUnixMs": NOW - 10_000
            })
        );
    }
}
