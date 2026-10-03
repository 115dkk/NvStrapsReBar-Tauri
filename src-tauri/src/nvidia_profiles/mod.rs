//! Per-game Resizable BAR in the NVIDIA driver settings database.
//!
//! The app reads every driver profile, turns Resizable BAR on or off in one game profile or in
//! the profile that applies to all programs, and keeps a copy of the whole database from before
//! its first change. A change counts only after a new session reads the requested state back.
//! Every command writes what it read, wrote, and skipped to a diagnostic log (`journal`).

mod drs;
#[cfg(test)]
mod fake;
mod journal;
mod logged;
mod nvapi;
mod policy;
mod undo;

use std::{
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use nvstraps_deploy::Sha256Digest;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    error::{ApiError, BackendError, BackendResult, CommandResult},
    firmware::inspect_access,
};
use drs::{DrsDriver, DrsError, DrsSession, ProfileHandle, driver_version_text};
use journal::Journal;
pub use journal::install_panic_log;
use logged::LoggedDriver;
use nvapi::NvapiDriver;
use policy::{
    REBAR_SETTING_IDS, RebarSettings, RebarSource, RebarState, Write, app_setting_supported,
    rebar_state,
};

/// One driver settings session at a time in this process.
static DRS_LOCK: Mutex<()> = Mutex::new(());
static BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const BACKUP_SCHEMA_VERSION: u8 = 1;
const MAX_BACKUP_BYTES: usize = 64 * 1024 * 1024;
/// More profiles than any driver ships; stops a driver that never ends the enumeration.
const MAX_PROFILES: u32 = 100_000;
/// A driver that refuses this many profiles in a row is not answering; the list stops there.
const MAX_FAILURES_IN_A_ROW: u32 = 50;

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
    /// Profiles the driver refused to read; each one has a line in the log.
    pub skipped_profiles: u32,
    pub log_path: Option<PathBuf>,
    /// The profiles the app changed, which the undo returns to their earlier values.
    pub undo: Option<undo::UndoSummary>,
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
    /// The undo record after this change.
    pub undo: Option<undo::UndoSummary>,
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
pub struct UndoGameChangesRequest {
    /// The record revision the screen showed.
    pub revision: String,
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

/// The full database copies and the record of the values the app changed.
#[derive(Clone, Debug)]
struct Store {
    backups: PathBuf,
    originals: PathBuf,
}

impl Store {
    fn under(root: &Path) -> Self {
        Self {
            backups: root.join("backups"),
            originals: root.join("originals.json"),
        }
    }
}

/// Where the commands keep their files.
#[derive(Clone, Debug)]
struct Paths {
    store: Store,
    log: PathBuf,
}

impl Paths {
    fn of(app: &AppHandle) -> BackendResult<Self> {
        let root = app.path().app_local_data_dir().map_err(|error| {
            BackendError::NvidiaDriverSettings(format!("local data path failed: {error}"))
        })?;
        Ok(Self {
            store: Store::under(&root.join("nvidia-driver-settings")),
            log: root.join("logs").join("driver-settings.log"),
        })
    }
}

#[tauri::command]
pub async fn load_nvidia_game_settings(app: AppHandle) -> CommandResult<GameSettingsCatalog> {
    let paths = Paths::of(&app).map_err(ApiError::from)?;
    run(
        paths,
        "load_nvidia_game_settings".into(),
        |paths, journal| {
            with_driver(journal, |driver| {
                load_catalog(driver, &paths.store, journal)
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn set_nvidia_game_rebar(
    app: AppHandle,
    request: SetGameRebarRequest,
) -> CommandResult<GameRebarReceipt> {
    let paths = Paths::of(&app).map_err(ApiError::from)?;
    let label = format!(
        "set_nvidia_game_rebar profile={:?} on={}",
        request.profile_name, request.on
    );
    run(paths, label, move |paths, journal| {
        require_administrator(inspect_access().is_elevated)?;
        with_driver(journal, |driver| {
            change(
                driver,
                Target::Game(&request.profile_name),
                request.on,
                &paths.store,
                journal,
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
    let paths = Paths::of(&app).map_err(ApiError::from)?;
    let label = format!(
        "set_nvidia_all_games_rebar on={} consented={}",
        request.on, request.consented
    );
    run(paths, label, move |paths, journal| {
        require_consent(&request)?;
        require_administrator(inspect_access().is_elevated)?;
        with_driver(journal, |driver| {
            change(driver, Target::AllGames, request.on, &paths.store, journal)
        })
    })
    .await
}

#[tauri::command]
pub async fn undo_nvidia_game_changes(
    app: AppHandle,
    request: UndoGameChangesRequest,
) -> CommandResult<GameSettingsCatalog> {
    let paths = Paths::of(&app).map_err(ApiError::from)?;
    let label = format!("undo_nvidia_game_changes revision={}", request.revision);
    run(paths, label, move |paths, journal| {
        require_administrator(inspect_access().is_elevated)?;
        with_driver(journal, |driver| {
            undo::undo(driver, &paths.store.originals, &request.revision, journal)?;
            load_catalog(driver, &paths.store, journal)
        })
    })
    .await
}

/// Runs a command off the event loop and logs its start, duration, and result. A failure
/// reaches the screen with the log path in its message.
async fn run<T: Send + 'static>(
    paths: Paths,
    label: String,
    work: impl FnOnce(&Paths, &Journal) -> BackendResult<T> + Send + 'static,
) -> CommandResult<T> {
    let journal = Arc::new(Journal::file(paths.log.clone()));
    let worker = Arc::clone(&journal);
    let command = label.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        worker.info("command.start", &command);
        let result = work(&paths, &worker);
        let ms = started.elapsed().as_millis();
        match &result {
            Ok(_) => worker.info("command.done", format_args!("{command} ms={ms}")),
            Err(error) => worker.error("command.failed", format_args!("{command} ms={ms} {error}")),
        }
        if let Some(status) = nvapi::take_destroy_failure() {
            worker.warn("drs.destroy_session", format_args!("NvAPI status {status}"));
        }
        result
    })
    .await;
    let result = outcome.unwrap_or_else(|error| {
        journal.error("command.worker", format_args!("{label} stopped: {error}"));
        Err(BackendError::NvidiaDriverSettings(format!(
            "driver settings worker stopped: {error}"
        )))
    });
    result.map_err(|error| api_error(error, &journal))
}

fn api_error(error: BackendError, journal: &Journal) -> ApiError {
    let mut api = ApiError::from(error);
    if let Some(path) = journal.path() {
        api.message = format!("{} (log: {})", api.message, path.display());
    }
    api
}

fn with_driver<T>(
    journal: &Journal,
    action: impl FnOnce(&LoggedDriver<'_, NvapiDriver<'_>>) -> BackendResult<T>,
) -> BackendResult<T> {
    let _guard = DRS_LOCK.lock().unwrap_or_else(|poisoned| {
        journal.warn(
            "drs.lock",
            "a previous command stopped while holding the driver settings lock",
        );
        poisoned.into_inner()
    });
    let api = nvapi::system_api().inspect_err(|error| journal.error("drs.load_nvapi", error))?;
    journal.info("drs.accessors", api.accessors());
    let driver = NvapiDriver::new(api);
    action(&LoggedDriver::new(&driver, journal))
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

impl fmt::Display for Target<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Game(name) => write!(formatter, "game={name:?}"),
            Self::AllGames => formatter.write_str("all-programs"),
        }
    }
}

/// `0x000F00BA=Dword(1)@Profile/nvidia` per setting: value, location, and whether the current
/// value or the profile carries NVIDIA's predefined value.
fn describe_settings(settings: &RebarSettings) -> String {
    REBAR_SETTING_IDS
        .iter()
        .map(|id| match settings.get(*id) {
            Some(setting) => format!(
                "{id:#010x}={:?}@{:?}{}{}",
                setting.value,
                setting.location,
                if setting.current_predefined {
                    "/nvidia"
                } else {
                    ""
                },
                if setting.predefined && !setting.current_predefined {
                    "/has-nvidia"
                } else {
                    ""
                },
            ),
            None => format!("{id:#010x}=unset"),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn describe_writes(writes: &[Write]) -> String {
    if writes.is_empty() {
        return "none".into();
    }
    writes
        .iter()
        .map(|write| match write {
            Write::Set { id, value } => format!("set {id:#010x}={value:?}"),
            Write::Delete { id } => format!("delete {id:#010x}"),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn describe_state(state: &RebarState) -> String {
    format!(
        "on={} source={:?} changed={}",
        state.on, state.source, state.changed
    )
}

fn load_catalog<D: DrsDriver>(
    driver: &D,
    store: &Store,
    journal: &Journal,
) -> BackendResult<GameSettingsCatalog> {
    let started = Instant::now();
    let version = driver.driver_version()?;
    journal.info(
        "catalog.driver",
        format_args!(
            "version={} app_setting={}",
            driver_version_text(version),
            app_setting_supported(version)
        ),
    );
    let mut session = driver.open()?;
    let global = session.global_profile()?;
    let global_name = session.profile_info(global)?.name;
    let global_settings = session.rebar_settings(global)?;
    let all_games = rebar_state(&global_settings, version);
    journal.info(
        "catalog.all_games",
        format_args!(
            "profile={global_name:?} {} {}",
            describe_state(&all_games),
            describe_settings(&global_settings)
        ),
    );
    let mut games = Vec::new();
    let (mut profiles, mut skipped, mut in_a_row) = (0_u32, 0_u32, 0_u32);
    let mut ended = false;
    for index in 0..MAX_PROFILES {
        let Some(profile) = session.profile(index)? else {
            ended = true;
            break;
        };
        profiles += 1;
        match read_game(&mut session, profile, &global_name, version) {
            Ok(game) => {
                in_a_row = 0;
                games.extend(game);
            }
            Err(error) => {
                skipped += 1;
                in_a_row += 1;
                journal.warn("catalog.skip", format_args!("index={index} {error}"));
                if in_a_row >= MAX_FAILURES_IN_A_ROW {
                    return Err(BackendError::NvidiaDriverSettings(format!(
                        "the driver refused {in_a_row} profiles in a row; last: {error}"
                    )));
                }
            }
        }
    }
    if !ended {
        journal.warn(
            "catalog.limit",
            format_args!("stopped after {MAX_PROFILES} profiles"),
        );
    }
    games.sort_by_cached_key(|game| game.name.to_lowercase());
    let count = |source: RebarSource| {
        games
            .iter()
            .filter(|game| game.state.on && game.state.source == source)
            .count()
    };
    journal.info(
        "catalog.done",
        format_args!(
            "profiles={profiles} games={} skipped={skipped} on_by_nvidia={} on_by_this_pc={} on_by_all_games={} ms={}",
            games.len(),
            count(RebarSource::Nvidia),
            count(RebarSource::ThisPc),
            count(RebarSource::AllGames),
            started.elapsed().as_millis()
        ),
    );
    Ok(GameSettingsCatalog {
        driver: DriverInfo {
            version: driver_version_text(version),
            app_setting: app_setting_supported(version),
        },
        all_games,
        games,
        backup: read_backup(&store.backups, journal)?,
        skipped_profiles: skipped,
        log_path: journal.path().map(Path::to_path_buf),
        undo: undo::summary(&store.originals, journal),
    })
}

/// One profile with programs, or `None` for the all-programs profile and profiles without
/// programs.
fn read_game<S: DrsSession>(
    session: &mut S,
    profile: ProfileHandle,
    global_name: &str,
    version: u32,
) -> Result<Option<GameProfile>, DrsError> {
    let info = session.profile_info(profile)?;
    if info.name == global_name || info.app_count == 0 {
        return Ok(None);
    }
    let mut apps = session.applications(profile, info.app_count)?;
    apps.dedup();
    if apps.is_empty() {
        return Ok(None);
    }
    let state = rebar_state(&session.rebar_settings(profile)?, version);
    Ok(Some(GameProfile {
        name: info.name,
        apps,
        state,
    }))
}

fn resolve<S: DrsSession>(session: &mut S, target: Target<'_>) -> BackendResult<ProfileHandle> {
    let global = session.global_profile()?;
    let Target::Game(name) = target else {
        return Ok(global);
    };
    let profile = session.find_profile(name)?.ok_or_else(|| {
        BackendError::NvidiaDriverSettings(format!("the driver has no profile named {name:?}"))
    })?;
    // A game request never changes the all-programs profile, the base profile, or a global
    // preset: those have no programs and change only through the consented all-games switch.
    let info = session.profile_info(profile)?;
    if info.name == session.profile_info(global)?.name || info.app_count == 0 {
        return Err(BackendError::NvidiaDriverSettings(format!(
            "{name:?} has no programs; profiles that apply to all programs change only through the all-games switch"
        )));
    }
    Ok(profile)
}

fn apply<S: DrsSession>(
    session: &mut S,
    profile: ProfileHandle,
    writes: &[Write],
    journal: &Journal,
) -> BackendResult<()> {
    for write in writes {
        match write {
            Write::Set { id, value } => session.set_setting(profile, *id, value)?,
            Write::Delete { id } => {
                // Deletes target values just read as written on this PC.
                if !session.delete_setting(profile, *id)? {
                    journal.warn(
                        "change.delete",
                        format_args!("{id:#010x} was read as set on this PC but the driver had nothing to delete"),
                    );
                }
            }
        }
    }
    Ok(())
}

/// Backs up the database once, applies the writes, saves, and reads the state back in a new
/// session. The log gets the values before, the writes, the staged state, and the read-back.
fn change<D: DrsDriver>(
    driver: &D,
    target: Target<'_>,
    on: bool,
    store: &Store,
    journal: &Journal,
) -> BackendResult<GameRebarReceipt> {
    let version = driver.driver_version()?;
    journal.info(
        "change.start",
        format_args!("{target} on={on} driver={}", driver_version_text(version)),
    );
    let mut session = driver.open()?;
    let backup = ensure_backup(&mut session, &store.backups, version, journal)?;
    let profile = resolve(&mut session, target)?;
    let settings = session.rebar_settings(profile)?;
    // The earlier values are on disk before anything changes in the driver.
    let name = match target {
        Target::Game(name) => name.to_owned(),
        Target::AllGames => session.profile_info(profile)?.name,
    };
    undo::record(
        &store.originals,
        &name,
        matches!(target, Target::AllGames),
        &settings,
        version,
        journal,
    )?;
    journal.info(
        "change.before",
        format_args!(
            "{target} {} {}",
            describe_state(&rebar_state(&settings, version)),
            describe_settings(&settings)
        ),
    );
    if on {
        let writes = policy::turn_on(&settings, version);
        journal.info(
            "change.plan",
            format_args!("{target} turn on: {}", describe_writes(&writes)),
        );
        apply(&mut session, profile, &writes, journal)?;
    } else {
        let writes = policy::clear(&settings);
        journal.info(
            "change.plan",
            format_args!("{target} clear: {}", describe_writes(&writes)),
        );
        apply(&mut session, profile, &writes, journal)?;
        let cleared = session.rebar_settings(profile)?;
        let writes = policy::force_off(&cleared, version);
        journal.info(
            "change.plan",
            format_args!(
                "{target} after clear {}; force off: {}",
                describe_settings(&cleared),
                describe_writes(&writes)
            ),
        );
        apply(&mut session, profile, &writes, journal)?;
    }
    let staged_settings = session.rebar_settings(profile)?;
    let staged = rebar_state(&staged_settings, version);
    if staged.on != on {
        journal.error(
            "change.staged",
            format_args!(
                "{target} wanted on={on} but the session reads {} {}",
                describe_state(&staged),
                describe_settings(&staged_settings)
            ),
        );
        return Err(BackendError::NvidiaDriverReadback);
    }
    session.save()?;
    drop(session);

    let mut fresh = driver.open()?;
    let profile = resolve(&mut fresh, target)?;
    let read_back = fresh.rebar_settings(profile)?;
    let state = rebar_state(&read_back, version);
    let line = format!(
        "{target} {} {}",
        describe_state(&state),
        describe_settings(&read_back)
    );
    if state.on != on {
        journal.error("change.readback", format_args!("wanted on={on}; {line}"));
        return Err(BackendError::NvidiaDriverReadback);
    }
    journal.info("change.readback", &line);
    Ok(GameRebarReceipt {
        profile_name: match target {
            Target::Game(name) => Some(name.to_owned()),
            Target::AllGames => None,
        },
        state,
        backup,
        undo: undo::summary(&store.originals, journal),
    })
}

/// The earliest intact backup. Manifests and backups are never rewritten; a damaged one is
/// skipped with its reason in the log and stays on disk.
fn read_backup(root: &Path, journal: &Journal) -> BackendResult<Option<DriverSettingsBackup>> {
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
        match intact_backup(root, &path) {
            Ok(backup) => intact.push(backup),
            Err(reason) => {
                journal.warn("backup.skip", format_args!("{}: {reason}", path.display()))
            }
        }
    }
    intact.sort_by(|left, right| {
        (left.created_at_unix_ms.len(), &left.created_at_unix_ms)
            .cmp(&(right.created_at_unix_ms.len(), &right.created_at_unix_ms))
    });
    Ok(intact.into_iter().next())
}

fn intact_backup(root: &Path, manifest_path: &Path) -> Result<DriverSettingsBackup, String> {
    let bytes = fs::read(manifest_path).map_err(|error| format!("unreadable manifest: {error}"))?;
    let manifest: BackupManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("not a backup manifest: {error}"))?;
    if manifest.schema_version != BACKUP_SCHEMA_VERSION {
        return Err(format!("schema version {}", manifest.schema_version));
    }
    if manifest.file_name != format!("{}.nvdrs", manifest.sha256.as_str()) {
        return Err(format!(
            "file name {} does not match its hash",
            manifest.file_name
        ));
    }
    let path = root.join(&manifest.file_name);
    let bytes =
        fs::read(&path).map_err(|error| format!("unreadable {}: {error}", path.display()))?;
    if bytes.len() as u64 != manifest.byte_length {
        return Err(format!(
            "{} has {} bytes, the manifest says {}",
            path.display(),
            bytes.len(),
            manifest.byte_length
        ));
    }
    if Sha256Digest::from_bytes(&bytes) != manifest.sha256 {
        return Err(format!("{} no longer matches its hash", path.display()));
    }
    Ok(DriverSettingsBackup {
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
    journal: &Journal,
) -> BackendResult<DriverSettingsBackup> {
    if let Some(backup) = read_backup(root, journal)? {
        journal.info(
            "backup.reuse",
            format_args!("path={}", backup.path.display()),
        );
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
    if let Err(error) = fs::remove_file(&pending) {
        journal.warn(
            "backup.pending",
            format_args!("{} stays on disk: {error}", pending.display()),
        );
    }
    let bytes = bytes?;
    if bytes.is_empty() || bytes.len() > MAX_BACKUP_BYTES {
        return Err(BackendError::NvidiaDriverSettings(format!(
            "the NVIDIA settings backup has {} bytes; it must be 1 byte to 64 MiB",
            bytes.len()
        )));
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
    let backup = read_backup(root, journal)?.ok_or_else(|| {
        BackendError::NvidiaDriverSettings("the NVIDIA settings backup failed read-back".into())
    })?;
    journal.info(
        "backup.created",
        format_args!(
            "path={} bytes={} sha256={}",
            backup.path.display(),
            backup.byte_length,
            backup.sha256.as_str()
        ),
    );
    Ok(backup)
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
        .unwrap_or(0)
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
        let catalog =
            load_catalog(&driver, &Store::under(&directory.0), &Journal::memory()).unwrap();
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
        let receipt = change(
            &driver,
            Target::Game("Elden Ring"),
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap();
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
        let first = change(
            &driver,
            Target::Game("Elden Ring"),
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap();
        let second = change(
            &driver,
            Target::Game("Counter-Strike 2"),
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap();
        assert_eq!(first.backup, second.backup);
        let catalog =
            load_catalog(&driver, &Store::under(&directory.0), &Journal::memory()).unwrap();
        assert_eq!(catalog.backup, Some(first.backup));
    }

    #[test]
    fn turning_off_restores_nvidia_defaults_or_writes_explicit_off() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        change(
            &driver,
            Target::Game("Elden Ring"),
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap();
        let off = change(
            &driver,
            Target::Game("Elden Ring"),
            false,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap();
        assert!(!off.state.on && !off.state.changed);
        assert_eq!(driver.system.borrow().profiles[2].user.len(), 0);

        let cyberpunk = change(
            &driver,
            Target::Game("Cyberpunk 2077"),
            false,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap();
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
        let receipt = change(
            &driver,
            Target::AllGames,
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap();
        assert_eq!(receipt.profile_name, None);
        assert!(receipt.state.on);
        let catalog =
            load_catalog(&driver, &Store::under(&directory.0), &Journal::memory()).unwrap();
        assert!(catalog.all_games.on);
        let counter_strike = game(&catalog, "Counter-Strike 2");
        assert!(counter_strike.state.on);
        assert_eq!(counter_strike.state.source, RebarSource::AllGames);
        // A game can still be turned off under the all-games value.
        let off = change(
            &driver,
            Target::Game("Counter-Strike 2"),
            false,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap();
        assert!(!off.state.on);
        change(
            &driver,
            Target::AllGames,
            false,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap();
        assert!(
            !load_catalog(&driver, &Store::under(&directory.0), &Journal::memory())
                .unwrap()
                .all_games
                .on
        );
    }

    #[test]
    fn a_game_request_never_changes_the_all_programs_profile() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let error = change(
            &driver,
            Target::Game("Base Profile"),
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap_err();
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
        let error = change(
            &driver,
            Target::Game("Elden Ring"),
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap_err();
        assert!(matches!(error, BackendError::AdministratorRequired(_)));
        assert!(driver.system.borrow().profiles[2].user.is_empty());
    }

    #[test]
    fn a_save_the_driver_does_not_keep_is_a_readback_failure() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        driver.ignore_saves.set(true);
        let directory = TestDirectory::new();
        let error = change(
            &driver,
            Target::Game("Elden Ring"),
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap_err();
        assert!(matches!(error, BackendError::NvidiaDriverReadback));
    }

    #[test]
    fn unknown_games_are_refused() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        assert!(
            change(
                &driver,
                Target::Game("Not A Game"),
                true,
                &Store::under(&directory.0),
                &Journal::memory()
            )
            .is_err()
        );
    }

    fn undo_summary(directory: &TestDirectory) -> undo::UndoSummary {
        undo::summary(&Store::under(&directory.0).originals, &Journal::memory())
            .expect("changes were recorded")
    }

    #[test]
    fn undo_returns_every_changed_profile_to_its_earlier_values() {
        let mut db = sample_db();
        // A value set earlier by another tool must come back too.
        db.profiles[2].user.insert(ENABLE_ID, Value::Dword(1));
        db.profiles[2]
            .user
            .insert(SIZE_LIMIT_ID, Value::Qword(4 << 30));
        let original = db.clone();
        let driver = FakeDriver::new(db, DRIVER);
        let directory = TestDirectory::new();
        let store = Store::under(&directory.0);
        let journal = Journal::memory();
        change(&driver, Target::Game("Elden Ring"), false, &store, &journal).unwrap();
        change(&driver, Target::Game("Elden Ring"), true, &store, &journal).unwrap();
        change(
            &driver,
            Target::Game("Cyberpunk 2077"),
            false,
            &store,
            &journal,
        )
        .unwrap();
        change(&driver, Target::AllGames, true, &store, &journal).unwrap();
        let summary = undo_summary(&directory);
        assert_eq!(summary.profiles, 3);
        let catalog = load_catalog(&driver, &store, &journal).unwrap();
        assert_eq!(catalog.undo, Some(summary.clone()));

        undo::undo(&driver, &store.originals, &summary.revision, &journal).unwrap();
        assert_eq!(*driver.system.borrow(), original);
        assert!(
            journal
                .lines()
                .iter()
                .any(|line| line.contains("INFO undo.done"))
        );
    }

    #[test]
    fn undo_keeps_what_a_driver_update_changed_since() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let store = Store::under(&directory.0);
        let journal = Journal::memory();
        change(
            &driver,
            Target::Game("Counter-Strike 2"),
            true,
            &store,
            &journal,
        )
        .unwrap();
        // A driver update turns another game on and adds a profile.
        {
            let mut system = driver.system.borrow_mut();
            system.profiles[2].nvidia.insert(ENABLE_ID, Value::Dword(1));
            system.profiles.push(fake::FakeProfile {
                name: "New Game".into(),
                predefined: true,
                apps: vec!["new.exe".into()],
                ..Default::default()
            });
        }
        let expected = {
            let mut system = driver.system.borrow().clone();
            system.profiles[3].user.clear();
            system
        };
        undo::undo(
            &driver,
            &store.originals,
            &undo_summary(&directory).revision,
            &journal,
        )
        .unwrap();
        assert_eq!(*driver.system.borrow(), expected);
    }

    #[test]
    fn the_first_record_of_a_profile_is_kept() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let store = Store::under(&directory.0);
        let journal = Journal::memory();
        change(&driver, Target::Game("Elden Ring"), true, &store, &journal).unwrap();
        let first = undo_summary(&directory);
        change(&driver, Target::Game("Elden Ring"), false, &store, &journal).unwrap();
        change(&driver, Target::Game("Elden Ring"), true, &store, &journal).unwrap();
        assert_eq!(undo_summary(&directory), first);
    }

    #[test]
    fn a_stale_or_empty_undo_is_refused() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let store = Store::under(&directory.0);
        let journal = Journal::memory();
        assert!(undo::undo(&driver, &store.originals, "any", &journal).is_err());
        change(&driver, Target::Game("Elden Ring"), true, &store, &journal).unwrap();
        let shown = undo_summary(&directory);
        change(
            &driver,
            Target::Game("Counter-Strike 2"),
            true,
            &store,
            &journal,
        )
        .unwrap();
        let error = undo::undo(&driver, &store.originals, &shown.revision, &journal).unwrap_err();
        assert!(
            error.to_string().contains("changed after it was shown"),
            "{error}"
        );
    }

    #[test]
    fn a_damaged_record_is_moved_aside_and_logged() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let store = Store::under(&directory.0);
        fs::create_dir_all(&directory.0).unwrap();
        fs::write(&store.originals, b"{ not json").unwrap();
        let journal = Journal::memory();
        assert!(
            load_catalog(&driver, &store, &journal)
                .unwrap()
                .undo
                .is_none()
        );
        change(&driver, Target::Game("Elden Ring"), true, &store, &journal).unwrap();
        assert_eq!(undo_summary(&directory).profiles, 1);
        let aside: Vec<_> = fs::read_dir(&directory.0)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("originals.json.damaged-")
            })
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(fs::read(aside[0].path()).unwrap(), b"{ not json");
        let log = journal.lines().join("\n");
        assert!(log.contains("ERROR undo.record"), "{log}");
        assert!(log.contains("moved to"), "{log}");
    }

    #[test]
    fn game_requests_need_a_profile_with_programs() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let error = change(
            &driver,
            Target::Game("Driver Telemetry"),
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("has no programs"), "{error}");
    }

    #[test]
    fn damaged_backups_are_skipped_and_kept() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let directory = TestDirectory::new();
        let first = change(
            &driver,
            Target::Game("Elden Ring"),
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
        )
        .unwrap();
        fs::write(&first.backup.path, b"damaged").unwrap();
        let journal = Journal::memory();
        assert!(
            read_backup(&Store::under(&directory.0).backups, &journal)
                .unwrap()
                .is_none()
        );
        let lines = journal.lines();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains(" WARN backup.skip "));
        assert!(lines[0].contains("has 7 bytes, the manifest says"));
        // The next change makes a new backup without touching the damaged files.
        let second = change(
            &driver,
            Target::Game("Counter-Strike 2"),
            true,
            &Store::under(&directory.0),
            &Journal::memory(),
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

    #[test]
    fn changes_log_the_values_before_the_writes_and_the_read_back() {
        let fake = FakeDriver::new(sample_db(), DRIVER);
        let journal = Journal::memory();
        let driver = LoggedDriver::new(&fake, &journal);
        let directory = TestDirectory::new();
        change(
            &driver,
            Target::Game("Elden Ring"),
            true,
            &Store::under(&directory.0),
            &journal,
        )
        .unwrap();
        let log = journal.lines().join("\n");
        for expected in [
            "INFO change.start game=\"Elden Ring\" on=true driver=616.64",
            "INFO backup.created path=",
            "INFO change.before game=\"Elden Ring\" on=false source=Driver changed=false 0x000bfa21=Dword(1)@Default",
            "INFO change.plan game=\"Elden Ring\" turn on: set 0x000bfa21=Dword(2), set 0x000f00ba=Dword(1)",
            "INFO drs.set_setting profile=0x3 id=0x000f00ba value=Dword(1) -> ok",
            "INFO drs.save  -> ok",
            "INFO change.readback game=\"Elden Ring\" on=true source=ThisPc changed=true",
        ] {
            assert!(log.contains(expected), "missing {expected:?} in\n{log}");
        }
    }

    #[test]
    fn failed_driver_calls_are_logged_with_their_arguments() {
        let fake = FakeDriver::new(sample_db(), DRIVER);
        fake.administrator.set(false);
        let journal = Journal::memory();
        let driver = LoggedDriver::new(&fake, &journal);
        let directory = TestDirectory::new();
        assert!(
            change(
                &driver,
                Target::Game("Elden Ring"),
                true,
                &Store::under(&directory.0),
                &journal
            )
            .is_err()
        );
        assert!(
            change(
                &driver,
                Target::Game("Missing Game"),
                true,
                &Store::under(&directory.0),
                &journal
            )
            .is_err()
        );
        let log = journal.lines().join("\n");
        assert!(
            log.contains("ERROR drs.save  -> NvAPI_DRS_SaveSettings returned NvAPI status -137"),
            "{log}"
        );
        assert!(
            log.contains("WARN drs.find_profile name=\"Missing Game\" -> not found"),
            "{log}"
        );
    }

    #[test]
    fn unreadable_profiles_are_skipped_counted_and_logged() {
        let fake = FakeDriver::new(sample_db(), DRIVER);
        fake.broken.borrow_mut().push("Elden Ring".into());
        let journal = Journal::memory();
        let driver = LoggedDriver::new(&fake, &journal);
        let directory = TestDirectory::new();
        let catalog = load_catalog(&driver, &Store::under(&directory.0), &journal).unwrap();
        assert_eq!(catalog.skipped_profiles, 1);
        assert!(catalog.games.iter().all(|game| game.name != "Elden Ring"));
        let log = journal.lines().join("\n");
        assert!(log.contains("ERROR drs.profile_info profile=0x3 -> NvAPI_DRS_GetProfileInfo returned NvAPI status -1"), "{log}");
        assert!(
            log.contains(
                "WARN catalog.skip index=2 NvAPI_DRS_GetProfileInfo returned NvAPI status -1"
            ),
            "{log}"
        );
        assert!(
            log.contains("INFO catalog.done profiles=5 games=2 skipped=1 on_by_nvidia=1"),
            "{log}"
        );
    }

    #[test]
    fn a_driver_that_refuses_every_profile_stops_the_list() {
        let mut db = sample_db();
        for index in 0..60 {
            db.profiles.push(fake::FakeProfile {
                name: format!("Game {index}"),
                predefined: true,
                apps: vec![format!("game{index}.exe")],
                ..Default::default()
            });
        }
        let fake = FakeDriver::new(db, DRIVER);
        fake.break_games.set(true);
        let journal = Journal::memory();
        let directory = TestDirectory::new();
        let error = load_catalog(
            &LoggedDriver::new(&fake, &journal),
            &Store::under(&directory.0),
            &journal,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("refused 50 profiles in a row"),
            "{error}"
        );
    }

    #[test]
    fn command_errors_name_the_log_file() {
        let directory = TestDirectory::new();
        let journal = Journal::file(directory.0.join("driver-settings.log"));
        let api = api_error(BackendError::NvidiaDriverReadback, &journal);
        assert_eq!(api.code, "nvidia_driver_readback_mismatch");
        assert!(api.message.ends_with(&format!(
            "(log: {})",
            directory.0.join("driver-settings.log").display()
        )));
    }
}
