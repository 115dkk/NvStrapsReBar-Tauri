use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::app::{AppState, ValidationReport, lock_backend_state, validation_report_for};
use crate::config::{ConfigDraft, draft_from_config};
use crate::error::{ApiError, BackendError, BackendResult, CommandResult};

const SNAPSHOT_APPLICATION: &str = "NvStrapsReBar";
const SNAPSHOT_SCHEMA: u32 = 1;
/// A settings snapshot is a few hundred bytes; anything larger is not ours.
const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSnapshotFile {
    application: String,
    schema: u32,
    saved_at_unix_ms: u64,
    draft: ConfigDraft,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshotExportReceipt {
    pub path: String,
    pub bytes_written: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshotInspection {
    pub draft: ConfigDraft,
    pub saved_at_unix_ms: u64,
    pub validation: ValidationReport,
}

#[tauri::command]
pub fn export_bar_settings_snapshot(
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<SettingsSnapshotExportReceipt> {
    let guard = lock_backend_state(&state).map_err(ApiError::from)?;
    let config = guard.config.as_ref().ok_or_else(|| {
        ApiError::from(BackendError::SettingsSnapshot(
            "there is no saved configuration to export".into(),
        ))
    })?;
    let draft = draft_from_config(config);
    drop(guard);
    export_snapshot(&draft, Path::new(&path)).map_err(ApiError::from)
}

#[tauri::command]
pub fn inspect_bar_settings_snapshot(
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<SettingsSnapshotInspection> {
    let file = read_snapshot(Path::new(&path)).map_err(ApiError::from)?;
    let guard = lock_backend_state(&state).map_err(ApiError::from)?;
    let validation = validation_report_for(&file.draft, &guard)?;
    Ok(SettingsSnapshotInspection {
        draft: file.draft,
        saved_at_unix_ms: file.saved_at_unix_ms,
        validation,
    })
}

fn export_snapshot(
    draft: &ConfigDraft,
    path: &Path,
) -> BackendResult<SettingsSnapshotExportReceipt> {
    let file = SettingsSnapshotFile {
        application: SNAPSHOT_APPLICATION.into(),
        schema: SNAPSHOT_SCHEMA,
        saved_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default(),
        draft: draft.clone(),
    };
    let body = serde_json::to_vec_pretty(&file)
        .map_err(|error| BackendError::SettingsSnapshot(error.to_string()))?;
    fs::write(path, &body).map_err(|error| {
        BackendError::SettingsSnapshot(format!("could not write {}: {error}", path.display()))
    })?;
    Ok(SettingsSnapshotExportReceipt {
        path: path.display().to_string(),
        bytes_written: body.len(),
    })
}

fn read_snapshot(path: &Path) -> BackendResult<SettingsSnapshotFile> {
    let metadata = fs::metadata(path).map_err(|error| {
        BackendError::SettingsSnapshot(format!("could not read {}: {error}", path.display()))
    })?;
    if metadata.len() > MAX_SNAPSHOT_BYTES {
        return Err(BackendError::SettingsSnapshot(format!(
            "{} is {} bytes, which is larger than any settings snapshot",
            path.display(),
            metadata.len()
        )));
    }
    let body = fs::read(path).map_err(|error| {
        BackendError::SettingsSnapshot(format!("could not read {}: {error}", path.display()))
    })?;
    let file: SettingsSnapshotFile = serde_json::from_slice(&body).map_err(|error| {
        BackendError::SettingsSnapshot(format!(
            "{} is not a BAR settings snapshot: {error}",
            path.display()
        ))
    })?;
    if file.application != SNAPSHOT_APPLICATION || file.schema != SNAPSHOT_SCHEMA {
        return Err(BackendError::SettingsSnapshot(format!(
            "{} is not a schema-{SNAPSHOT_SCHEMA} {SNAPSHOT_APPLICATION} settings snapshot",
            path.display()
        )));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{GpuRule, MatchScope};

    fn draft() -> ConfigDraft {
        ConfigDraft {
            global_mode: 2,
            target_pci_bar_size: 0,
            skip_s3_resume: false,
            override_bar_size_mask: false,
            guard_setup_changes: true,
            rules: vec![GpuRule {
                match_scope: MatchScope::Device,
                device_id: 0x1e81,
                subsystem_vendor_id: 0xffff,
                subsystem_device_id: 0xffff,
                bus: 0xff,
                device: 0xff,
                function: 0xff,
                bar_size_selector: Some(7),
                override_bar_size_mask: None,
            }],
        }
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "nvstraps-snapshot-test-{}-{name}",
            std::process::id()
        ));
        path
    }

    #[test]
    fn snapshot_round_trips_the_draft() {
        let path = temp_path("roundtrip.json");
        let receipt = export_snapshot(&draft(), &path).unwrap();
        assert!(receipt.bytes_written > 0);
        let file = read_snapshot(&path).unwrap();
        assert_eq!(file.draft, draft());
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn foreign_or_oversized_files_are_rejected_with_the_path_in_the_error() {
        let path = temp_path("foreign.json");
        fs::write(&path, b"{\"application\":\"other\"}").unwrap();
        let error = read_snapshot(&path).unwrap_err().to_string();
        assert!(error.contains("not a"), "{error}");
        fs::remove_file(&path).unwrap();

        let path = temp_path("oversized.json");
        fs::write(&path, vec![b' '; (MAX_SNAPSHOT_BYTES + 1) as usize]).unwrap();
        let error = read_snapshot(&path).unwrap_err().to_string();
        assert!(error.contains("larger"), "{error}");
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn missing_files_fail_with_a_typed_error() {
        let error = read_snapshot(Path::new("Z:/does/not/exist.json")).unwrap_err();
        assert!(matches!(error, BackendError::SettingsSnapshot(_)));
    }
}
