//! The values a profile held before the app first changed it, and the undo that writes them
//! back. Unlike loading the full database copy, an undo touches only the Resizable BAR values
//! of the profiles the app changed, so it stays correct after a driver update and keeps every
//! other change made in the NVIDIA app or control panel.

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

use nvstraps_deploy::Sha256Digest;
use serde::{Deserialize, Serialize};

use super::{
    describe_settings,
    drs::{DrsDriver, DrsSession, driver_version_text},
    io_error,
    journal::Journal,
    policy::{Location, REBAR_SETTING_IDS, RebarSettings, Setting, Value},
    unix_timestamp_ms,
};
use crate::error::{BackendError, BackendResult};

const ORIGINALS_SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
enum StoredValue {
    Dword(u32),
    Qword(u64),
    Binary(Vec<u8>),
}

impl StoredValue {
    fn of(value: &Value) -> Option<Self> {
        match value {
            Value::Dword(value) => Some(Self::Dword(*value)),
            Value::Qword(value) => Some(Self::Qword(*value)),
            Value::Binary(bytes) => Some(Self::Binary(bytes.clone())),
            Value::Text => None,
        }
    }

    fn value(&self) -> Value {
        match self {
            Self::Dword(value) => Value::Dword(*value),
            Self::Qword(value) => Value::Qword(*value),
            Self::Binary(bytes) => Value::Binary(bytes.clone()),
        }
    }
}

fn key(id: u32) -> String {
    format!("{id:#010x}")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginalProfile {
    name: String,
    all_programs: bool,
    driver_version: String,
    recorded_at_unix_ms: String,
    /// Per setting ID: the value written on this PC before the app's first change, or `None`
    /// when the profile had no value of its own (NVIDIA's or the inherited value applied).
    values: BTreeMap<String, Option<StoredValue>>,
    /// Settings for which the profile carried NVIDIA's predefined value when recorded.
    #[serde(default)]
    nvidia: Vec<String>,
    /// Settings whose earlier value the app cannot write back (a text value).
    #[serde(default)]
    unrestorable: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Originals {
    schema_version: u8,
    profiles: Vec<OriginalProfile>,
}

/// What the screen shows for the undo: how many profiles, and the file revision a request must
/// name so it never undoes a list the user did not see.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoSummary {
    pub profiles: u32,
    pub revision: String,
}

/// The recorded originals and their revision; a missing file is an empty record.
fn read(path: &Path) -> Result<(Originals, Option<String>), String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((
                Originals {
                    schema_version: ORIGINALS_SCHEMA_VERSION,
                    profiles: Vec::new(),
                },
                None,
            ));
        }
        Err(error) => return Err(format!("unreadable: {error}")),
    };
    let originals: Originals = serde_json::from_slice(&bytes)
        .map_err(|error| format!("not an originals record: {error}"))?;
    if originals.schema_version != ORIGINALS_SCHEMA_VERSION {
        return Err(format!("schema version {}", originals.schema_version));
    }
    Ok((
        originals,
        Some(Sha256Digest::from_bytes(&bytes).as_str().to_owned()),
    ))
}

/// The profile itself carries NVIDIA's predefined value; an inherited value is not restored here.
fn nvidia_value(setting: &Setting) -> bool {
    setting.location == Location::Profile && setting.predefined
}

pub fn summary(path: &Path, journal: &Journal) -> Option<UndoSummary> {
    match read(path) {
        Ok((originals, Some(revision))) if !originals.profiles.is_empty() => Some(UndoSummary {
            profiles: originals.profiles.len() as u32,
            revision,
        }),
        Ok(_) => None,
        Err(reason) => {
            journal.error("undo.record", format_args!("{}: {reason}", path.display()));
            None
        }
    }
}

/// Records a profile's own values the first time the app changes it. Later changes keep the
/// first record. A damaged record is moved aside, never overwritten.
pub fn record(
    path: &Path,
    name: &str,
    all_programs: bool,
    settings: &RebarSettings,
    version: u32,
    journal: &Journal,
) -> BackendResult<()> {
    let mut originals = match read(path) {
        Ok((originals, _)) => originals,
        Err(reason) => {
            let aside = PathBuf::from(format!(
                "{}.damaged-{}",
                path.display(),
                unix_timestamp_ms()
            ));
            fs::rename(path, &aside).map_err(|error| io_error(path, error))?;
            journal.error(
                "undo.record",
                format_args!(
                    "{}: {reason}; moved to {} and started a new record",
                    path.display(),
                    aside.display()
                ),
            );
            Originals {
                schema_version: ORIGINALS_SCHEMA_VERSION,
                profiles: Vec::new(),
            }
        }
    };
    if originals
        .profiles
        .iter()
        .any(|profile| profile.name == name && profile.all_programs == all_programs)
    {
        return Ok(());
    }
    let mut values = BTreeMap::new();
    let mut nvidia = Vec::new();
    let mut unrestorable = Vec::new();
    for id in REBAR_SETTING_IDS {
        if settings.get(id).is_some_and(nvidia_value) {
            nvidia.push(key(id));
        }
        let own = settings.get(id).filter(|setting| setting.user_set());
        match own.map(|setting| StoredValue::of(&setting.value)) {
            Some(Some(value)) => {
                values.insert(key(id), Some(value));
            }
            Some(None) => unrestorable.push(key(id)),
            None => {
                values.insert(key(id), None);
            }
        }
    }
    originals.profiles.push(OriginalProfile {
        name: name.to_owned(),
        all_programs,
        driver_version: driver_version_text(version),
        recorded_at_unix_ms: unix_timestamp_ms(),
        values,
        nvidia,
        unrestorable: unrestorable.clone(),
    });
    write(path, &originals)?;
    journal.info(
        "undo.recorded",
        format_args!(
            "profile={name:?} all_programs={all_programs} {} unrestorable={unrestorable:?}",
            describe_settings(settings)
        ),
    );
    Ok(())
}

/// Replaces the record through a temporary file, so a crash leaves the old or the new record.
fn write(path: &Path, originals: &Originals) -> BackendResult<()> {
    let json = serde_json::to_vec_pretty(originals).map_err(|error| {
        BackendError::NvidiaDriverSettings(format!("originals record failed: {error}"))
    })?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }
    let temporary = PathBuf::from(format!("{}.tmp", path.display()));
    fs::write(&temporary, &json).map_err(|error| io_error(&temporary, error))?;
    fs::rename(&temporary, path).map_err(|error| io_error(path, error))?;
    if fs::read(path).map_err(|error| io_error(path, error))? != json {
        return Err(BackendError::NvidiaDriverSettings(format!(
            "{} failed read-back",
            path.display()
        )));
    }
    Ok(())
}

/// Writes every recorded profile's earlier values back, saves, and checks them in a new
/// session. Profiles the driver no longer has are skipped and logged.
pub fn undo<D: DrsDriver>(
    driver: &D,
    path: &Path,
    revision: &str,
    journal: &Journal,
) -> BackendResult<()> {
    let (originals, current) = read(path).map_err(|reason| {
        BackendError::NvidiaDriverSettings(format!("{}: {reason}", path.display()))
    })?;
    let Some(current) = current.filter(|_| !originals.profiles.is_empty()) else {
        return Err(BackendError::NvidiaDriverSettings(
            "the app has not changed any NVIDIA profile".into(),
        ));
    };
    if current != revision.to_ascii_lowercase() {
        return Err(BackendError::NvidiaDriverSettings(
            "the list of changed profiles changed after it was shown".into(),
        ));
    }
    journal.info(
        "undo.start",
        format_args!("profiles={} revision={current}", originals.profiles.len()),
    );
    let mut session = driver.open()?;
    let mut restored = Vec::new();
    for original in &originals.profiles {
        let Some(profile) = session.find_profile(&original.name)? else {
            journal.warn(
                "undo.missing",
                format_args!("profile={:?} is no longer in the driver", original.name),
            );
            continue;
        };
        for id in REBAR_SETTING_IDS {
            if original.unrestorable.contains(&key(id)) {
                journal.warn(
                    "undo.unrestorable",
                    format_args!("profile={:?} id={}", original.name, key(id)),
                );
                continue;
            }
            let setting_key = key(id);
            match original.values.get(&setting_key).cloned().flatten() {
                Some(value) => session.set_setting(profile, id, &value.value())?,
                None if original.nvidia.contains(&setting_key)
                    || session
                        .setting(profile, id)?
                        .is_some_and(|setting| nvidia_value(&setting)) =>
                {
                    session.restore_setting(profile, id)?;
                }
                None => {
                    session.delete_setting(profile, id)?;
                }
            }
        }
        restored.push(original);
    }
    session.save()?;
    drop(session);

    let mut fresh = driver.open()?;
    let mut mismatched = 0;
    for original in restored {
        let Some(profile) = fresh.find_profile(&original.name)? else {
            mismatched += 1;
            continue;
        };
        let settings = fresh.rebar_settings(profile)?;
        let matches = REBAR_SETTING_IDS.iter().all(|id| {
            let setting_key = key(*id);
            original.unrestorable.contains(&setting_key) || {
                let expected = original.values.get(&setting_key).cloned().flatten();
                let actual = settings
                    .get(*id)
                    .filter(|setting| setting.user_set())
                    .and_then(|setting| StoredValue::of(&setting.value));
                let nvidia_matches = expected.is_some()
                    || !original.nvidia.contains(&setting_key)
                    || settings
                        .get(*id)
                        .is_some_and(|setting| setting.current_predefined);
                expected == actual && nvidia_matches
            }
        });
        let line = format!(
            "profile={:?} {}",
            original.name,
            describe_settings(&settings)
        );
        if matches {
            journal.info("undo.readback", &line);
        } else {
            mismatched += 1;
            journal.error(
                "undo.readback",
                format_args!("does not match the record: {line}"),
            );
        }
    }
    if mismatched > 0 {
        return Err(BackendError::NvidiaDriverReadback);
    }
    journal.info("undo.done", format_args!("revision={current}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nvidia_profiles::{
        fake::{FakeDriver, sample_db},
        policy::{ENABLE_ID, Location},
    };

    const DRIVER: u32 = 61_664;

    #[test]
    fn legacy_record_without_nvidia_still_parses_and_undoes() {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "nvstraps-legacy-originals-{}-{}-{}",
            std::process::id(),
            unix_timestamp_ms(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("originals.json");
        fs::write(
            &path,
            r#"{
  "schemaVersion": 1,
  "profiles": [
    {
      "name": "Elden Ring",
      "allPrograms": false,
      "driverVersion": "616.64",
      "recordedAtUnixMs": "0",
      "values": {
        "0x000bfa21": null,
        "0x000f00ba": null,
        "0x000f00bb": null,
        "0x000f00ff": null
      },
      "unrestorable": []
    }
  ]
}"#,
        )
        .unwrap();
        let mut db = sample_db();
        db.profiles[2].user.insert(ENABLE_ID, Value::Dword(0));
        let driver = FakeDriver::new(db, DRIVER);
        let revision = summary(&path, &Journal::memory()).unwrap().revision;

        undo(&driver, &path, &revision, &Journal::memory()).unwrap();

        let setting = driver.system.borrow().setting(2, ENABLE_ID).unwrap();
        assert_eq!(setting.location, Location::Default);
        assert_eq!(setting.value, Value::Dword(0));
        assert!(!setting.current_predefined);
        assert!(!setting.predefined);
        fs::remove_dir_all(root).unwrap();
    }
}
