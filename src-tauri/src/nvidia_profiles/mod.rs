//! Per-game Resizable BAR in the NVIDIA driver settings database.
//!
//! The app reads every driver profile, turns Resizable BAR on or off in one game profile or in
//! the profile that applies to all programs, and keeps a copy of the whole database from before
//! its first change. A change counts only after a new session reads the requested state back.

mod drs;
#[cfg(test)]
mod fake;
mod nvapi;
mod policy;

use std::{
    fs::{self, OpenOptions},
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use nvstraps_deploy::Sha256Digest;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    error::{ApiError, BackendError, BackendResult, CommandResult},
    firmware::inspect_access,
};
use drs::{DrsDriver, DrsError, DrsSession, ProfileHandle, driver_version_text};
use nvapi::NvapiDriver;
use policy::{RebarState, Write, app_setting_supported, rebar_state};

/// One driver settings session at a time in this process.
static DRS_LOCK: Mutex<()> = Mutex::new(());
static BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const BACKUP_SCHEMA_VERSION: u8 = 1;
const MAX_BACKUP_BYTES: usize = 64 * 1024 * 1024;
/// More profiles than any driver ships; stops a driver that never ends the enumeration.
const MAX_PROFILES: u32 = 100_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverInfo {
    pub version: String,
    /// The driver reads the NVIDIA app's per-program Resizable BAR setting.
    pub app_setting: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProfile {
    pub name: String,
    pub apps: Vec<String>,
    pub state: RebarState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSettingsCatalog {
    pub driver: DriverInfo,
    pub all_games: RebarState,
    pub games: Vec<GameProfile>,
    pub backup: Option<DriverSettingsBackup>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    schema_version: u8,
    file_name: String,
    sha256: Sha256Digest,
    byte_length: u64,
    driver_version: String,
    created_at_unix_ms: String,
}

/// The driver settings database as it was before the app's first change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverSettingsBackup {
    pub path: PathBuf,
    pub sha256: Sha256Digest,
    pub byte_length: u64,
    pub driver_version: String,
    pub created_at_unix_ms: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRebarReceipt {
    /// The game profile, or `None` for all games.
    pub profile_name: Option<String>,
    /// The state a new session read back after the save.
    pub state: RebarState,
    pub backup: DriverSettingsBackup,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGameRebarRequest {
    pub profile_name: String,
    pub on: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAllGamesRebarRequest {
    pub on: bool,
    /// The user agreed to turn it on for every program.
    pub consented: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreDriverSettingsRequest {
    pub backup_sha256: String,
}

impl From<DrsError> for BackendError {
    fn from(error: DrsError) -> Self {
        if error.driver_missing() {
            Self::NvidiaDriverUnavailable(error.to_string())
        } else if error.needs_administrator() {
            Self::AdministratorRequired("change NVIDIA driver settings")
        } else {
            Self::NvidiaDriverSettings(error.to_string())
        }
    }
}

#[tauri::command]
pub async fn load_nvidia_game_settings(app: AppHandle) -> CommandResult<GameSettingsCatalog> {
    blocking(move || {
        let backups = backup_root(&app)?;
        with_driver(|driver| load_catalog(driver, &backups))
    })
    .await
}

#[tauri::command]
pub async fn set_nvidia_game_rebar(
    app: AppHandle,
    request: SetGameRebarRequest,
) -> CommandResult<GameRebarReceipt> {
    blocking(move || {
        require_administrator(inspect_access().is_elevated)?;
        let backups = backup_root(&app)?;
        with_driver(|driver| {
            change(
                driver,
                Target::Game(&request.profile_name),
                request.on,
                &backups,
            )
        })
    })
    .await
}

#[tauri::command]
pub async fn set_nvidia_all_games_rebar(
    app: AppHandle,
    request: SetAllGamesRebarRequest,
) -> CommandResult<GameRebarReceipt> {
    blocking(move || {
        require_consent(&request)?;
        require_administrator(inspect_access().is_elevated)?;
        let backups = backup_root(&app)?;
        with_driver(|driver| change(driver, Target::AllGames, request.on, &backups))
    })
    .await
}

#[tauri::command]
pub async fn restore_nvidia_driver_settings(
    app: AppHandle,
    request: RestoreDriverSettingsRequest,
) -> CommandResult<GameSettingsCatalog> {
    blocking(move || {
        require_administrator(inspect_access().is_elevated)?;
        let backups = backup_root(&app)?;
        with_driver(|driver| {
            restore(driver, &backups, &request.backup_sha256)?;
            load_catalog(driver, &backups)
        })
    })
    .await
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> BackendResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| {
            ApiError::from(BackendError::NvidiaDriverSettings(format!(
                "driver settings worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

fn with_driver<T>(action: impl FnOnce(&NvapiDriver<'_>) -> BackendResult<T>) -> BackendResult<T> {
    let _guard = DRS_LOCK.lock().map_err(|_| BackendError::StatePoisoned)?;
    let api = nvapi::system_api()?;
    action(&NvapiDriver::new(api))
}

fn backup_root(app: &AppHandle) -> BackendResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("nvidia-driver-settings").join("backups"))
        .map_err(|error| {
            BackendError::NvidiaDriverSettings(format!("local data path failed: {error}"))
        })
}

fn require_administrator(elevated: bool) -> BackendResult<()> {
    if elevated {
        Ok(())
    } else {
        Err(BackendError::AdministratorRequired(
            "change NVIDIA driver settings",
        ))
    }
}

fn require_consent(request: &SetAllGamesRebarRequest) -> BackendResult<()> {
    if request.on && !request.consented {
        return Err(BackendError::NvidiaDriverSettings(
            "turning Resizable BAR on for all programs needs the user's consent".into(),
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum Target<'a> {
    Game(&'a str),
    AllGames,
}

fn load_catalog<D: DrsDriver>(driver: &D, backups: &Path) -> BackendResult<GameSettingsCatalog> {
    let version = driver.driver_version()?;
    let mut session = driver.open()?;
    let global = session.global_profile()?;
    let global_name = session.profile_info(global)?.name;
    let all_games = rebar_state(&session.rebar_settings(global)?, version);
    let mut games = Vec::new();
    for index in 0..MAX_PROFILES {
        let Some(profile) = session.profile(index)? else {
            break;
        };
        let info = session.profile_info(profile)?;
        if info.name == global_name || info.app_count == 0 {
            continue;
        }
        let mut apps = session.applications(profile, info.app_count)?;
        apps.dedup();
        if apps.is_empty() {
            continue;
        }
        let state = rebar_state(&session.rebar_settings(profile)?, version);
        games.push(GameProfile {
            name: info.name,
            apps,
            state,
        });
    }
    games.sort_by_cached_key(|game| game.name.to_lowercase());
    Ok(GameSettingsCatalog {
        driver: DriverInfo {
            version: driver_version_text(version),
            app_setting: app_setting_supported(version),
        },
        all_games,
        games,
        backup: read_backup(backups)?,
    })
}

fn resolve<S: DrsSession>(session: &mut S, target: Target<'_>) -> BackendResult<ProfileHandle> {
    let global = session.global_profile()?;
    let Target::Game(name) = target else {
        return Ok(global);
    };
    let profile = session.find_profile(name)?.ok_or_else(|| {
        BackendError::NvidiaDriverSettings(format!("the driver has no profile named {name:?}"))
    })?;
    // A game request never changes the all-programs profile; that needs consent.
    if session.profile_info(profile)?.name == session.profile_info(global)?.name {
        return Err(BackendError::NvidiaDriverSettings(
            "the all-programs profile is changed only through the all-games switch".into(),
        ));
    }
    Ok(profile)
}

fn apply<S: DrsSession>(
    session: &mut S,
    profile: ProfileHandle,
    writes: &[Write],
) -> BackendResult<()> {
    for write in writes {
        match write {
            Write::Set { id, value } => session.set_setting(profile, *id, value)?,
            Write::Delete { id } => session.delete_setting(profile, *id)?,
        }
    }
    Ok(())
}

/// Backs up the database once, applies the writes, saves, and reads the state back in a new
/// session.
fn change<D: DrsDriver>(
    driver: &D,
    target: Target<'_>,
    on: bool,
    backups: &Path,
) -> BackendResult<GameRebarReceipt> {
    let version = driver.driver_version()?;
    let mut session = driver.open()?;
    let backup = ensure_backup(&mut session, backups, version)?;
    let profile = resolve(&mut session, target)?;
    let settings = session.rebar_settings(profile)?;
    if on {
        apply(&mut session, profile, &policy::turn_on(&settings, version))?;
    } else {
        apply(&mut session, profile, &policy::clear(&settings))?;
        let cleared = session.rebar_settings(profile)?;
        apply(&mut session, profile, &policy::force_off(&cleared, version))?;
    }
    if rebar_state(&session.rebar_settings(profile)?, version).on != on {
        return Err(BackendError::NvidiaDriverReadback);
    }
    session.save()?;
    drop(session);

    let mut fresh = driver.open()?;
    let profile = resolve(&mut fresh, target)?;
    let state = rebar_state(&fresh.rebar_settings(profile)?, version);
    if state.on != on {
        return Err(BackendError::NvidiaDriverReadback);
    }
    Ok(GameRebarReceipt {
        profile_name: match target {
            Target::Game(name) => Some(name.to_owned()),
            Target::AllGames => None,
        },
        state,
        backup,
    })
}

/// Loads the backed-up database into the driver and saves it.
fn restore<D: DrsDriver>(driver: &D, backups: &Path, sha256: &str) -> BackendResult<()> {
    let backup = read_backup(backups)?.ok_or_else(|| {
        BackendError::NvidiaDriverSettings("there is no NVIDIA settings backup".into())
    })?;
    if backup.sha256.as_str() != sha256.to_ascii_lowercase() {
        return Err(BackendError::NvidiaDriverSettings(
            "the NVIDIA settings backup changed after it was shown".into(),
        ));
    }
    let mut session = driver.open_empty()?;
    session.load_from_file(&backup.path)?;
    session.save()?;
    Ok(())
}

/// The earliest intact backup. Manifests and backups are never rewritten; a damaged one is
/// skipped and stays on disk.
fn read_backup(root: &Path) -> BackendResult<Option<DriverSettingsBackup>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(root, error)),
    };
    let mut intact = Vec::new();
    for entry in entries {
        let path = entry.map_err(|error| io_error(root, error))?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        if let Some(backup) = intact_backup(root, &path) {
            intact.push(backup);
        }
    }
    intact.sort_by(|left, right| {
        (left.created_at_unix_ms.len(), &left.created_at_unix_ms)
            .cmp(&(right.created_at_unix_ms.len(), &right.created_at_unix_ms))
    });
    Ok(intact.into_iter().next())
}

fn intact_backup(root: &Path, manifest_path: &Path) -> Option<DriverSettingsBackup> {
    let manifest: BackupManifest = serde_json::from_slice(&fs::read(manifest_path).ok()?).ok()?;
    if manifest.schema_version != BACKUP_SCHEMA_VERSION
        || manifest.file_name != format!("{}.nvdrs", manifest.sha256.as_str())
    {
        return None;
    }
    let path = root.join(&manifest.file_name);
    let bytes = fs::read(&path).ok()?;
    if bytes.len() as u64 != manifest.byte_length
        || Sha256Digest::from_bytes(&bytes) != manifest.sha256
    {
        return None;
    }
    Some(DriverSettingsBackup {
        path,
        sha256: manifest.sha256,
        byte_length: manifest.byte_length,
        driver_version: manifest.driver_version,
        created_at_unix_ms: manifest.created_at_unix_ms,
    })
}

fn ensure_backup<S: DrsSession>(
    session: &mut S,
    root: &Path,
    version: u32,
) -> BackendResult<DriverSettingsBackup> {
    if let Some(backup) = read_backup(root)? {
        return Ok(backup);
    }
    fs::create_dir_all(root).map_err(|error| io_error(root, error))?;
    let pending = root.join(format!(
        "pending-{}-{}.tmp",
        std::process::id(),
        BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    session.save_to_file(&pending)?;
    let bytes = fs::read(&pending).map_err(|error| io_error(&pending, error));
    let _ = fs::remove_file(&pending);
    let bytes = bytes?;
    if bytes.is_empty() || bytes.len() > MAX_BACKUP_BYTES {
        return Err(BackendError::NvidiaDriverSettings(
            "the NVIDIA settings backup is empty or exceeds the 64 MiB guard".into(),
        ));
    }
    let sha256 = Sha256Digest::from_bytes(&bytes);
    let file_name = format!("{}.nvdrs", sha256.as_str());
    write_new_or_same(&root.join(&file_name), &bytes)?;
    let manifest = BackupManifest {
        schema_version: BACKUP_SCHEMA_VERSION,
        file_name,
        sha256,
        byte_length: bytes.len() as u64,
        driver_version: driver_version_text(version),
        created_at_unix_ms: unix_timestamp_ms(),
    };
    let json = serde_json::to_vec_pretty(&manifest).map_err(|error| {
        BackendError::NvidiaDriverSettings(format!("backup manifest failed: {error}"))
    })?;
    write_new_or_same(
        &root.join(format!("{}.json", manifest.sha256.as_str())),
        &json,
    )?;
    read_backup(root)?.ok_or_else(|| {
        BackendError::NvidiaDriverSettings("the NVIDIA settings backup failed read-back".into())
    })
}

/// Writes a new file; an existing file must already hold the same bytes.
fn write_new_or_same(path: &Path, bytes: &[u8]) -> BackendResult<()> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(bytes)
                .map_err(|error| io_error(path, error))?;
            file.sync_all().map_err(|error| io_error(path, error))?;
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(io_error(path, error)),
    }
    if fs::read(path).map_err(|error| io_error(path, error))? != bytes {
        return Err(BackendError::NvidiaDriverSettings(format!(
            "{} holds different bytes and is never overwritten",
            path.display()
        )));
    }
    Ok(())
}

fn io_error(path: &Path, error: io::Error) -> BackendError {
    BackendError::NvidiaDriverSettings(format!("failed to access {}: {error}", path.display()))
}

fn unix_timestamp_ms() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use fake::{FakeDriver, sample_db};
    use policy::{
        APP_SETTING_ID, ENABLE_ID, OPTIONS_ID, RebarSource, SIZE_LIMIT_ID, SIZE_LIMIT_ON, Value,
    };

    const DRIVER: u32 = 61_664;
    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "nvstraps-driver-settings-{}-{}-{}",
                std::process::id(),
                unix_timestamp_ms(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            assert!(self.0.starts_with(std::env::temp_dir()));
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn game<'a>(catalog: &'a GameSettingsCatalog, name: &str) -> &'a GameProfile {
        catalog
            .games
            .iter()
            .find(|game| game.name == name)
            .expect("listed game")
    }

    #[test]
    fn the_catalog_lists_games_with_programs_and_their_state() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let catalog = load_catalog(&driver, &directory.0).unwrap();
        let names: Vec<_> = catalog
            .games
            .iter()
            .map(|game| game.name.as_str())
            .collect();
        assert_eq!(names, ["Counter-Strike 2", "Cyberpunk 2077", "Elden Ring"]);
        assert_eq!(
            catalog.driver,
            DriverInfo {
                version: "616.64".into(),
                app_setting: true
            }
        );
        assert!(!catalog.all_games.on);
        let cyberpunk = game(&catalog, "Cyberpunk 2077");
        assert!(cyberpunk.state.on);
        assert_eq!(cyberpunk.state.source, RebarSource::Nvidia);
        assert_eq!(
            game(&catalog, "Elden Ring").apps,
            ["eldenring.exe", "start_protected_game.exe"]
        );
        assert!(catalog.backup.is_none());
    }

    #[test]
    fn turning_a_game_on_backs_up_first_and_reads_back() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let before = format!("{:?}", driver.system.borrow());
        let receipt = change(&driver, Target::Game("Elden Ring"), true, &directory.0).unwrap();
        assert_eq!(receipt.profile_name.as_deref(), Some("Elden Ring"));
        assert!(receipt.state.on && receipt.state.changed);
        assert_eq!(receipt.state.source, RebarSource::ThisPc);
        assert_eq!(fs::read_to_string(&receipt.backup.path).unwrap(), before);
        let system = driver.system.borrow();
        let elden = &system.profiles[system.find("Elden Ring").unwrap()];
        assert_eq!(elden.user.get(&APP_SETTING_ID), Some(&Value::Dword(2)));
        assert_eq!(elden.user.get(&ENABLE_ID), Some(&Value::Dword(1)));
        assert_eq!(elden.user.get(&OPTIONS_ID), Some(&Value::Dword(1)));
        assert_eq!(
            elden.user.get(&SIZE_LIMIT_ID),
            Some(&Value::Qword(SIZE_LIMIT_ON))
        );
    }

    #[test]
    fn the_first_backup_is_kept_across_changes() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let first = change(&driver, Target::Game("Elden Ring"), true, &directory.0).unwrap();
        let second = change(
            &driver,
            Target::Game("Counter-Strike 2"),
            true,
            &directory.0,
        )
        .unwrap();
        assert_eq!(first.backup, second.backup);
        let catalog = load_catalog(&driver, &directory.0).unwrap();
        assert_eq!(catalog.backup, Some(first.backup));
    }

    #[test]
    fn turning_off_restores_nvidia_defaults_or_writes_explicit_off() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        change(&driver, Target::Game("Elden Ring"), true, &directory.0).unwrap();
        let off = change(&driver, Target::Game("Elden Ring"), false, &directory.0).unwrap();
        assert!(!off.state.on && !off.state.changed);
        assert_eq!(driver.system.borrow().profiles[2].user.len(), 0);

        let cyberpunk =
            change(&driver, Target::Game("Cyberpunk 2077"), false, &directory.0).unwrap();
        assert!(!cyberpunk.state.on && cyberpunk.state.changed);
        let system = driver.system.borrow();
        // NVIDIA's own options and size stay; only the on/off values are written.
        assert_eq!(
            system.profiles[1].user.keys().copied().collect::<Vec<_>>(),
            [APP_SETTING_ID, ENABLE_ID]
        );
    }

    #[test]
    fn all_games_follow_the_all_programs_profile() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let receipt = change(&driver, Target::AllGames, true, &directory.0).unwrap();
        assert_eq!(receipt.profile_name, None);
        assert!(receipt.state.on);
        let catalog = load_catalog(&driver, &directory.0).unwrap();
        assert!(catalog.all_games.on);
        let counter_strike = game(&catalog, "Counter-Strike 2");
        assert!(counter_strike.state.on);
        assert_eq!(counter_strike.state.source, RebarSource::AllGames);
        // A game can still be turned off under the all-games value.
        let off = change(
            &driver,
            Target::Game("Counter-Strike 2"),
            false,
            &directory.0,
        )
        .unwrap();
        assert!(!off.state.on);
        change(&driver, Target::AllGames, false, &directory.0).unwrap();
        assert!(!load_catalog(&driver, &directory.0).unwrap().all_games.on);
    }

    #[test]
    fn a_game_request_never_changes_the_all_programs_profile() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let error = change(&driver, Target::Game("Base Profile"), true, &directory.0).unwrap_err();
        assert!(matches!(error, BackendError::NvidiaDriverSettings(_)));
        assert!(driver.system.borrow().profiles[0].user.is_empty());
    }

    #[test]
    fn all_games_on_needs_consent_and_writes_need_administrator() {
        assert!(
            require_consent(&SetAllGamesRebarRequest {
                on: true,
                consented: false
            })
            .is_err()
        );
        assert!(
            require_consent(&SetAllGamesRebarRequest {
                on: true,
                consented: true
            })
            .is_ok()
        );
        assert!(
            require_consent(&SetAllGamesRebarRequest {
                on: false,
                consented: false
            })
            .is_ok()
        );
        assert!(matches!(
            require_administrator(false),
            Err(BackendError::AdministratorRequired(_))
        ));

        let driver = FakeDriver::new(sample_db(), DRIVER);
        driver.administrator.set(false);
        let directory = TestDirectory::new();
        let error = change(&driver, Target::Game("Elden Ring"), true, &directory.0).unwrap_err();
        assert!(matches!(error, BackendError::AdministratorRequired(_)));
        assert!(driver.system.borrow().profiles[2].user.is_empty());
    }

    #[test]
    fn a_save_the_driver_does_not_keep_is_a_readback_failure() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        driver.ignore_saves.set(true);
        let directory = TestDirectory::new();
        let error = change(&driver, Target::Game("Elden Ring"), true, &directory.0).unwrap_err();
        assert!(matches!(error, BackendError::NvidiaDriverReadback));
    }

    #[test]
    fn unknown_games_are_refused() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        assert!(change(&driver, Target::Game("Not A Game"), true, &directory.0).is_err());
    }

    #[test]
    fn restore_brings_back_the_backed_up_database() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let receipt = change(&driver, Target::Game("Elden Ring"), true, &directory.0).unwrap();
        change(&driver, Target::AllGames, true, &directory.0).unwrap();
        let wrong = "0".repeat(64);
        assert!(restore(&driver, &directory.0, &wrong).is_err());
        restore(&driver, &directory.0, receipt.backup.sha256.as_str()).unwrap();
        assert_eq!(*driver.system.borrow(), sample_db());
    }

    #[test]
    fn damaged_backups_are_skipped_and_kept() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let first = change(&driver, Target::Game("Elden Ring"), true, &directory.0).unwrap();
        fs::write(&first.backup.path, b"damaged").unwrap();
        assert!(read_backup(&directory.0).unwrap().is_none());
        // The next change makes a new backup without touching the damaged files.
        let second = change(
            &driver,
            Target::Game("Counter-Strike 2"),
            true,
            &directory.0,
        )
        .unwrap();
        assert_ne!(second.backup.sha256, first.backup.sha256);
        assert_eq!(fs::read(&first.backup.path).unwrap(), b"damaged");
    }

    #[test]
    fn existing_files_with_other_bytes_are_never_overwritten() {
        let directory = TestDirectory::new();
        fs::create_dir_all(&directory.0).unwrap();
        let path = directory.0.join("file");
        write_new_or_same(&path, b"one").unwrap();
        write_new_or_same(&path, b"one").unwrap();
        assert!(write_new_or_same(&path, b"two").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"one");
    }

    #[test]
    fn driver_errors_keep_typed_codes() {
        let missing =
            BackendError::from(DrsError::new("nvapi64.dll", drs::NVAPI_LIBRARY_NOT_FOUND));
        assert_eq!(ApiError::from(missing).code, "nvidia_driver_unavailable");
        let privilege = BackendError::from(DrsError::new(
            "NvAPI_DRS_SaveSettings",
            drs::NVAPI_INVALID_USER_PRIVILEGE,
        ));
        assert_eq!(ApiError::from(privilege).code, "administrator_required");
        let failed = BackendError::from(DrsError::new("NvAPI_DRS_SetSetting", drs::NVAPI_ERROR));
        assert_eq!(ApiError::from(failed).code, "nvidia_driver_settings_failed");
        assert_eq!(
            ApiError::from(BackendError::NvidiaDriverReadback).code,
            "nvidia_driver_readback_mismatch"
        );
    }
}
