use std::{
    fs::{self, OpenOptions},
    io::{self, Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

use nvstraps_deploy::Sha256Digest;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    deployment::load_exact_deployment,
    error::{ApiError, BackendError, BackendResult, CommandResult},
    firmware::inspect_access,
};

const VERSION: &str = "v3.0.2.1";
const SOURCE_COMMIT: &str = "bedb800569384eda737cb7aa596fbd97b5d6863c";
const REPOSITORY_URL: &str = "https://github.com/Orbmu2k/nvidiaProfileInspector";
const RELEASE_URL: &str = "https://github.com/Orbmu2k/nvidiaProfileInspector/releases/tag/v3.0.2.1";
const ASSET_URL: &str = "https://github.com/Orbmu2k/nvidiaProfileInspector/releases/download/v3.0.2.1/nvidiaProfileInspector.zip";
const ASSET_BYTE_LENGTH: u64 = 433_354;
const ASSET_SHA256: &str = "88dcf3514111e8de630688467c03c36d8c2a8ad9ebc8073f27c069f82b75bb40";
const MANIFEST_FILE_NAME: &str = "installation-manifest.json";
const EXECUTABLE_FILE_NAME: &str = "nvidiaProfileInspector.exe";
const MAX_ASSET_BYTES: usize = 2 * 1024 * 1024;

static INSTALL_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
struct ArchivePin<'a> {
    name: &'a str,
    byte_length: u64,
    sha256: &'a str,
    install: bool,
}

const ARCHIVE_PINS: [ArchivePin<'static>; 4] = [
    ArchivePin {
        name: "Reference.xml",
        byte_length: 873_663,
        sha256: "0ea7b055aee5c543047243d2dd7abdd1b8c6d96f5d2b7bb5fe17be8130e005ef",
        install: true,
    },
    ArchivePin {
        name: "nvidiaProfileInspector.exe",
        byte_length: 1_043_456,
        sha256: "1ebd8129b3c564bf226291fb3344819fd59668066f0c5e03334a69a04a62859e",
        install: true,
    },
    ArchivePin {
        name: "nvidiaProfileInspector.exe.config",
        byte_length: 174,
        sha256: "051099983b896673909e01a1f631b6652abb88da95c9f06f3efef4be033091fa",
        install: true,
    },
    ArchivePin {
        name: "nvidiaProfileInspector.pdb",
        byte_length: 174_352,
        sha256: "030ad196f65455d900d82fd3942ba9fadb815ef9c457f3eb69cb94c5540cf0b4",
        install: false,
    },
];

struct DecodedFile {
    name: String,
    bytes: Vec<u8>,
    install: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInspectorFile {
    pub relative_path: String,
    pub byte_length: u64,
    pub sha256: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInspectorManifest {
    pub schema_version: u8,
    pub repository_url: &'static str,
    pub version: &'static str,
    pub source_commit: &'static str,
    pub release_url: &'static str,
    pub asset_url: &'static str,
    pub asset_byte_length: u64,
    pub asset_sha256: Sha256Digest,
    pub files: Vec<ProfileInspectorFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInspectorInstallation {
    pub install_path: PathBuf,
    pub executable_path: PathBuf,
    pub manifest: ProfileInspectorManifest,
    pub manifest_sha256: Sha256Digest,
    pub installed_now: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfileInspectorRequest {
    pub profile_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInspectorLaunch {
    pub profile_id: String,
    pub process_id: u32,
    pub executable_path: PathBuf,
    pub executable_sha256: Sha256Digest,
    pub elevated: bool,
    pub backup: NvidiaProfileBackupReceipt,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaProfileBackupManifest {
    pub schema_version: u8,
    pub profile_id: String,
    pub tool_version: &'static str,
    pub tool_manifest_sha256: Sha256Digest,
    pub nip_sha256: Sha256Digest,
    pub nip_byte_length: u64,
    pub profile_count: usize,
    pub executable_count: usize,
    pub setting_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaProfileBackupReceipt {
    pub backup_path: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: NvidiaProfileBackupManifest,
    pub manifest_sha256: Sha256Digest,
}

#[tauri::command]
pub async fn install_nvidia_profile_inspector(
    app: AppHandle,
) -> CommandResult<ProfileInspectorInstallation> {
    tauri::async_runtime::spawn_blocking(move || install_command(&app))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "NVIDIA Profile Inspector install worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn get_nvidia_profile_inspector_installation(
    app: AppHandle,
) -> CommandResult<Option<ProfileInspectorInstallation>> {
    let root = installation_root(&app).map_err(ApiError::from)?;
    let version_path = root.join(VERSION);
    if !version_path.exists() {
        return Ok(None);
    }
    verify_installation(&version_path, false)
        .map(Some)
        .map_err(ApiError::from)
}

#[tauri::command]
pub async fn launch_nvidia_profile_inspector(
    app: AppHandle,
    request: LaunchProfileInspectorRequest,
) -> CommandResult<ProfileInspectorLaunch> {
    tauri::async_runtime::spawn_blocking(move || launch_command(&app, request))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "Profile Inspector launch worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

#[tauri::command]
pub async fn backup_nvidia_profiles(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<NvidiaProfileBackupReceipt> {
    tauri::async_runtime::spawn_blocking(move || backup_command(&app, &profile_id))
        .await
        .map_err(|error| {
            ApiError::from(BackendError::Deployment(format!(
                "NVIDIA profile backup worker failed: {error}"
            )))
        })?
        .map_err(ApiError::from)
}

fn launch_command(
    app: &AppHandle,
    request: LaunchProfileInspectorRequest,
) -> BackendResult<ProfileInspectorLaunch> {
    let exact = load_exact_deployment(app, &request.profile_id, "Profile Inspector launch")?;
    let access = inspect_access();
    if !access.is_elevated {
        return Err(BackendError::Elevation(
            "relaunch NvStrapsReBar as administrator before opening Profile Inspector".into(),
        ));
    }
    let installation = verify_installation(&installation_root(app)?.join(VERSION), false)?;
    let executable = installation
        .manifest
        .files
        .iter()
        .find(|file| file.relative_path == EXECUTABLE_FILE_NAME)
        .ok_or_else(|| {
            BackendError::Deployment(
                "Profile Inspector manifest does not contain the executable".into(),
            )
        })?;
    let backup = backup_with_installation(app, &exact.profile.profile_id, &installation)?;
    let child = std::process::Command::new(&installation.executable_path)
        .current_dir(&installation.install_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| {
            BackendError::Deployment(format!("failed to launch Profile Inspector: {error}"))
        })?;
    Ok(ProfileInspectorLaunch {
        profile_id: exact.profile.profile_id,
        process_id: child.id(),
        executable_path: installation.executable_path,
        executable_sha256: executable.sha256.clone(),
        elevated: true,
        backup,
        warnings: vec![
            "Profile Inspector can modify NVIDIA driver profiles only after you press Apply Changes in its own window.".into(),
            "A content-addressed backup of all customized NVIDIA profiles was created before this launch.".into(),
            "Close any other Profile Inspector instance first; its single-instance behavior can activate an already-running copy.".into(),
            "The pinned installation is reverified before every launch; in-place updater changes are refused on the next launch.".into(),
        ],
    })
}

fn backup_command(app: &AppHandle, profile_id: &str) -> BackendResult<NvidiaProfileBackupReceipt> {
    let exact = load_exact_deployment(app, profile_id, "NVIDIA profile backup")?;
    if !inspect_access().is_elevated {
        return Err(BackendError::Elevation(
            "relaunch NvStrapsReBar as administrator before backing up NVIDIA profiles".into(),
        ));
    }
    let installation = verify_installation(&installation_root(app)?.join(VERSION), false)?;
    backup_with_installation(app, &exact.profile.profile_id, &installation)
}

fn backup_with_installation(
    app: &AppHandle,
    profile_id: &str,
    installation: &ProfileInspectorInstallation,
) -> BackendResult<NvidiaProfileBackupReceipt> {
    let tool_root = installation_root(app)?;
    let sessions_root = tool_root.join("sessions");
    fs::create_dir_all(&sessions_root).map_err(|error| io_error(&sessions_root, error))?;
    let suffix = profile_id
        .strip_prefix("nvstraps-")
        .ok_or_else(|| BackendError::Deployment("deployment profile ID is malformed".into()))?;
    let session_path = sessions_root.join(format!(
        "{suffix}-{}-{}",
        std::process::id(),
        INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&session_path).map_err(|error| io_error(&session_path, error))?;
    let _cleanup = SessionCleanup(session_path.clone());

    for file in &installation.manifest.files {
        let source = installation.install_path.join(&file.relative_path);
        let bytes = fs::read(&source).map_err(|error| io_error(&source, error))?;
        if bytes.len() as u64 != file.byte_length || Sha256Digest::from_bytes(&bytes) != file.sha256
        {
            return Err(BackendError::Deployment(format!(
                "Profile Inspector changed before profile backup: {}",
                file.relative_path
            )));
        }
        write_new_synced(&session_path.join(&file.relative_path), &bytes)?;
    }
    run_profile_export(&session_path.join(EXECUTABLE_FILE_NAME), &session_path)?;

    let backups = fs::read_dir(&session_path)
        .map_err(|error| io_error(&session_path, error))?
        .map(|entry| entry.map_err(|error| io_error(&session_path, error)))
        .collect::<BackendResult<Vec<_>>>()?
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("nip"))
        })
        .collect::<Vec<_>>();
    if backups.len() != 1 {
        return Err(BackendError::Deployment(format!(
            "Profile Inspector produced {} backup files instead of exactly one",
            backups.len()
        )));
    }
    let nip_bytes = fs::read(&backups[0]).map_err(|error| io_error(&backups[0], error))?;
    if nip_bytes.is_empty() || nip_bytes.len() > 16 * 1024 * 1024 {
        return Err(BackendError::Deployment(
            "Profile Inspector backup is empty or exceeds the 16 MiB guard".into(),
        ));
    }
    let summary = inspect_nip(&nip_bytes)?;
    persist_backup(
        &tool_root.join("backups").join(profile_id),
        profile_id,
        &nip_bytes,
        installation.manifest_sha256.clone(),
        summary,
    )
}

struct SessionCleanup(PathBuf);

impl Drop for SessionCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NipSummary {
    profile_count: usize,
    executable_count: usize,
    setting_count: usize,
}

fn inspect_nip(bytes: &[u8]) -> BackendResult<NipSummary> {
    use quick_xml::events::Event;

    let text = decode_nip_text(bytes)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut reader = quick_xml::Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut root_seen = false;
    let mut profile_count = 0;
    let mut executable_count = 0;
    let mut setting_count = 0;
    loop {
        let event = reader.read_event().map_err(|error| {
            BackendError::Deployment(format!("Profile Inspector backup XML is invalid: {error}"))
        })?;
        match event {
            Event::Start(start) | Event::Empty(start) => {
                let name = start.name();
                let name = name.as_ref();
                if !root_seen {
                    if name != b"ArrayOfProfile" {
                        return Err(BackendError::Deployment(
                            "Profile Inspector backup has an unexpected XML root".into(),
                        ));
                    }
                    root_seen = true;
                } else if name == b"Profile" {
                    profile_count += 1;
                } else if name == b"string" {
                    executable_count += 1;
                } else if name == b"ProfileSetting" {
                    setting_count += 1;
                }
            }
            Event::DocType(_) => {
                return Err(BackendError::Deployment(
                    "Profile Inspector backup must not contain a document type declaration".into(),
                ));
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root_seen {
        return Err(BackendError::Deployment(
            "Profile Inspector backup has no XML root".into(),
        ));
    }
    Ok(NipSummary {
        profile_count,
        executable_count,
        setting_count,
    })
}

fn decode_nip_text(bytes: &[u8]) -> BackendResult<String> {
    if let Some(bytes) = bytes.strip_prefix(&[0xff, 0xfe]) {
        if bytes.len() % 2 != 0 {
            return Err(BackendError::Deployment(
                "Profile Inspector UTF-16 backup has an odd byte length".into(),
            ));
        }
        let words = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&words).map_err(|error| {
            BackendError::Deployment(format!(
                "Profile Inspector UTF-16 backup is invalid: {error}"
            ))
        });
    }
    if let Some(bytes) = bytes.strip_prefix(&[0xfe, 0xff]) {
        if bytes.len() % 2 != 0 {
            return Err(BackendError::Deployment(
                "Profile Inspector UTF-16 backup has an odd byte length".into(),
            ));
        }
        let words = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&words).map_err(|error| {
            BackendError::Deployment(format!(
                "Profile Inspector UTF-16 backup is invalid: {error}"
            ))
        });
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8(bytes.to_vec()).map_err(|error| {
        BackendError::Deployment(format!(
            "Profile Inspector backup is not valid UTF-8: {error}"
        ))
    })
}

fn persist_backup(
    backup_root: &Path,
    profile_id: &str,
    nip_bytes: &[u8],
    tool_manifest_sha256: Sha256Digest,
    summary: NipSummary,
) -> BackendResult<NvidiaProfileBackupReceipt> {
    fs::create_dir_all(backup_root).map_err(|error| io_error(backup_root, error))?;
    let nip_sha256 = Sha256Digest::from_bytes(nip_bytes);
    let stem = format!("CustomizedProfiles-{}", &nip_sha256.as_str()[..16]);
    let backup_path = backup_root.join(format!("{stem}.nip"));
    write_once_verified(&backup_path, nip_bytes)?;
    let manifest = NvidiaProfileBackupManifest {
        schema_version: 1,
        profile_id: profile_id.to_owned(),
        tool_version: VERSION,
        tool_manifest_sha256,
        nip_sha256,
        nip_byte_length: nip_bytes.len() as u64,
        profile_count: summary.profile_count,
        executable_count: summary.executable_count,
        setting_count: summary.setting_count,
    };
    let manifest_bytes = json_bytes(&manifest, "NVIDIA profile backup manifest")?;
    let manifest_path = backup_root.join(format!("{stem}.json"));
    write_once_verified(&manifest_path, &manifest_bytes)?;
    Ok(NvidiaProfileBackupReceipt {
        backup_path,
        manifest_path,
        manifest,
        manifest_sha256: Sha256Digest::from_bytes(&manifest_bytes),
    })
}

fn write_once_verified(path: &Path, bytes: &[u8]) -> BackendResult<()> {
    if path.exists() {
        let persisted = fs::read(path).map_err(|error| io_error(path, error))?;
        return if persisted == bytes {
            Ok(())
        } else {
            Err(BackendError::Deployment(format!(
                "immutable NVIDIA profile backup conflicts at {}",
                path.display()
            )))
        };
    }
    match write_new_synced(path, bytes) {
        Ok(()) => Ok(()),
        Err(error) if path.exists() => {
            let persisted = fs::read(path).map_err(|read_error| io_error(path, read_error))?;
            if persisted == bytes {
                Ok(())
            } else {
                Err(error)
            }
        }
        Err(error) => Err(error),
    }
}

fn json_bytes(value: &impl Serialize, description: &str) -> BackendResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        BackendError::Deployment(format!("{description} could not be encoded: {error}"))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(windows)]
fn run_profile_export(executable: &Path, working_directory: &Path) -> BackendResult<()> {
    let mut child = std::process::Command::new(executable)
        .arg("-exportCustomized")
        .current_dir(working_directory)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| {
            BackendError::Deployment(format!("failed to start NVIDIA profile backup: {error}"))
        })?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            BackendError::Deployment(format!("NVIDIA profile backup status failed: {error}"))
        })? {
            return if status.success() {
                Ok(())
            } else {
                Err(BackendError::Deployment(format!(
                    "NVIDIA profile backup failed with exit code {}",
                    status
                        .code()
                        .map_or_else(|| "unknown".into(), |code| code.to_string())
                )))
            };
        }
        if started.elapsed() >= Duration::from_secs(60) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(BackendError::Deployment(
                "NVIDIA profile backup exceeded the 60-second timeout".into(),
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(windows))]
fn run_profile_export(_executable: &Path, _working_directory: &Path) -> BackendResult<()> {
    Err(BackendError::UnsupportedPlatform)
}

fn install_command(app: &AppHandle) -> BackendResult<ProfileInspectorInstallation> {
    let root = installation_root(app)?;
    let version_path = root.join(VERSION);
    if version_path.exists() {
        return verify_installation(&version_path, false);
    }
    let asset = download_pinned_asset()?;
    install_asset(&root, &asset)
}

fn installation_root(app: &AppHandle) -> BackendResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("external-tools").join("nvidia-profile-inspector"))
        .map_err(|error| {
            BackendError::Deployment(format!("local external-tool path failed: {error}"))
        })
}

fn install_asset(root: &Path, asset: &[u8]) -> BackendResult<ProfileInspectorInstallation> {
    verify_asset(asset)?;
    let decoded = decode_archive(asset, &ARCHIVE_PINS)?;
    fs::create_dir_all(root).map_err(|error| io_error(root, error))?;
    let version_path = root.join(VERSION);
    if version_path.exists() {
        return verify_installation(&version_path, false);
    }
    let staging_path = root.join(format!(
        ".{VERSION}-{}-{}.tmp",
        std::process::id(),
        INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&staging_path).map_err(|error| io_error(&staging_path, error))?;

    let result = (|| {
        let mut files = Vec::new();
        for file in decoded.iter().filter(|file| file.install) {
            let path = staging_path.join(&file.name);
            write_new_synced(&path, &file.bytes)?;
            files.push(ProfileInspectorFile {
                relative_path: file.name.clone(),
                byte_length: file.bytes.len() as u64,
                sha256: Sha256Digest::from_bytes(&file.bytes),
            });
        }
        files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let manifest = expected_manifest(files)?;
        let manifest_bytes = manifest_bytes(&manifest)?;
        write_new_synced(&staging_path.join(MANIFEST_FILE_NAME), &manifest_bytes)?;
        let manifest_sha256 = Sha256Digest::from_bytes(&manifest_bytes);
        verify_installation_at(&staging_path, &manifest, &manifest_sha256)?;
        fs::rename(&staging_path, &version_path).map_err(|error| io_error(&version_path, error))?;
        Ok(ProfileInspectorInstallation {
            executable_path: version_path.join(EXECUTABLE_FILE_NAME),
            install_path: version_path.clone(),
            manifest,
            manifest_sha256,
            installed_now: true,
        })
    })();
    if result.is_err() && staging_path.exists() {
        let _ = fs::remove_dir_all(&staging_path);
    }
    result
}

fn verify_installation(
    version_path: &Path,
    installed_now: bool,
) -> BackendResult<ProfileInspectorInstallation> {
    if !version_path.is_dir() {
        return Err(BackendError::Deployment(format!(
            "Profile Inspector install path is not a directory: {}",
            version_path.display()
        )));
    }
    let files = ARCHIVE_PINS
        .iter()
        .filter(|pin| pin.install)
        .map(|pin| ProfileInspectorFile {
            relative_path: pin.name.into(),
            byte_length: pin.byte_length,
            sha256: Sha256Digest::parse(pin.sha256)
                .expect("pinned Profile Inspector hashes are valid"),
        })
        .collect();
    let manifest = expected_manifest(files)?;
    let bytes = manifest_bytes(&manifest)?;
    let manifest_sha256 = Sha256Digest::from_bytes(&bytes);
    verify_installation_at(version_path, &manifest, &manifest_sha256)?;
    Ok(ProfileInspectorInstallation {
        install_path: version_path.to_owned(),
        executable_path: version_path.join(EXECUTABLE_FILE_NAME),
        manifest,
        manifest_sha256,
        installed_now,
    })
}

fn verify_installation_at(
    version_path: &Path,
    manifest: &ProfileInspectorManifest,
    manifest_sha256: &Sha256Digest,
) -> BackendResult<()> {
    for file in &manifest.files {
        let path = version_path.join(&file.relative_path);
        let bytes = fs::read(&path).map_err(|error| io_error(&path, error))?;
        if bytes.len() as u64 != file.byte_length || Sha256Digest::from_bytes(&bytes) != file.sha256
        {
            return Err(BackendError::Deployment(format!(
                "pinned Profile Inspector file failed verification: {}",
                file.relative_path
            )));
        }
    }
    let manifest_path = version_path.join(MANIFEST_FILE_NAME);
    let bytes = fs::read(&manifest_path).map_err(|error| io_error(&manifest_path, error))?;
    if Sha256Digest::from_bytes(&bytes) != *manifest_sha256 || bytes != manifest_bytes(manifest)? {
        return Err(BackendError::Deployment(
            "Profile Inspector installation manifest failed verification".into(),
        ));
    }
    let mut names = fs::read_dir(version_path)
        .map_err(|error| io_error(version_path, error))?
        .map(|entry| {
            entry
                .map_err(|error| io_error(version_path, error))
                .and_then(|entry| {
                    entry.file_name().into_string().map_err(|_| {
                        BackendError::Deployment(
                            "Profile Inspector install contains a non-Unicode file name".into(),
                        )
                    })
                })
        })
        .collect::<BackendResult<Vec<_>>>()?;
    names.sort();
    let mut expected: Vec<_> = manifest
        .files
        .iter()
        .map(|file| file.relative_path.clone())
        .collect();
    expected.push(MANIFEST_FILE_NAME.into());
    expected.sort();
    if names != expected {
        return Err(BackendError::Deployment(
            "Profile Inspector install contains unexpected or missing files".into(),
        ));
    }
    Ok(())
}

fn expected_manifest(
    mut files: Vec<ProfileInspectorFile>,
) -> BackendResult<ProfileInspectorManifest> {
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(ProfileInspectorManifest {
        schema_version: 1,
        repository_url: REPOSITORY_URL,
        version: VERSION,
        source_commit: SOURCE_COMMIT,
        release_url: RELEASE_URL,
        asset_url: ASSET_URL,
        asset_byte_length: ASSET_BYTE_LENGTH,
        asset_sha256: Sha256Digest::parse(ASSET_SHA256).map_err(BackendError::from)?,
        files,
    })
}

fn manifest_bytes(manifest: &ProfileInspectorManifest) -> BackendResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(manifest).map_err(|error| {
        BackendError::Deployment(format!(
            "Profile Inspector manifest could not be encoded: {error}"
        ))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn verify_asset(asset: &[u8]) -> BackendResult<()> {
    if asset.len() as u64 != ASSET_BYTE_LENGTH
        || Sha256Digest::from_bytes(asset).as_str() != ASSET_SHA256
    {
        return Err(BackendError::Deployment(
            "downloaded Profile Inspector asset does not match the pinned GitHub release digest"
                .into(),
        ));
    }
    Ok(())
}

fn decode_archive(asset: &[u8], pins: &[ArchivePin<'_>]) -> BackendResult<Vec<DecodedFile>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(asset)).map_err(|error| {
        BackendError::Deployment(format!("Profile Inspector ZIP is invalid: {error}"))
    })?;
    if archive.len() != pins.len() {
        return Err(BackendError::Deployment(
            "Profile Inspector ZIP contains an unexpected file count".into(),
        ));
    }
    let mut seen = vec![false; pins.len()];
    let mut decoded = Vec::with_capacity(pins.len());
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            BackendError::Deployment(format!("Profile Inspector ZIP entry failed: {error}"))
        })?;
        let name = entry.name().to_owned();
        if entry.is_dir()
            || entry.enclosed_name() != Some(PathBuf::from(&name))
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(BackendError::Deployment(format!(
                "Profile Inspector ZIP entry path is unsafe: {name}"
            )));
        }
        let (pin_index, pin) = pins
            .iter()
            .enumerate()
            .find(|(_, pin)| pin.name == name)
            .ok_or_else(|| {
                BackendError::Deployment(format!(
                    "Profile Inspector ZIP contains an unexpected entry: {name}"
                ))
            })?;
        if seen[pin_index] || entry.size() != pin.byte_length {
            return Err(BackendError::Deployment(format!(
                "Profile Inspector ZIP entry metadata is invalid: {name}"
            )));
        }
        let mut bytes = Vec::with_capacity(pin.byte_length as usize);
        entry
            .by_ref()
            .take(pin.byte_length + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                BackendError::Deployment(format!(
                    "Profile Inspector ZIP entry could not be read: {name}: {error}"
                ))
            })?;
        if bytes.len() as u64 != pin.byte_length
            || Sha256Digest::from_bytes(&bytes).as_str() != pin.sha256
        {
            return Err(BackendError::Deployment(format!(
                "Profile Inspector ZIP entry failed its pinned digest: {name}"
            )));
        }
        seen[pin_index] = true;
        decoded.push(DecodedFile {
            name,
            bytes,
            install: pin.install,
        });
    }
    if seen.iter().any(|seen| !seen) {
        return Err(BackendError::Deployment(
            "Profile Inspector ZIP is missing a pinned entry".into(),
        ));
    }
    Ok(decoded)
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> BackendResult<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| io_error(path, error))?;
    file.write_all(bytes)
        .map_err(|error| io_error(path, error))?;
    file.sync_all().map_err(|error| io_error(path, error))?;
    drop(file);
    let persisted = fs::read(path).map_err(|error| io_error(path, error))?;
    if persisted != bytes {
        return Err(BackendError::Deployment(format!(
            "Profile Inspector file failed read-back verification: {}",
            path.display()
        )));
    }
    Ok(())
}

fn io_error(path: &Path, error: io::Error) -> BackendError {
    BackendError::Deployment(format!("failed to access {}: {error}", path.display()))
}

#[cfg(windows)]
fn download_pinned_asset() -> BackendResult<Vec<u8>> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, os::windows::process::CommandExt};

    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = [0_u16; 32_768];
    // SAFETY: the buffer is writable and its capacity is passed exactly.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 {
        return Err(BackendError::windows("GetSystemDirectoryW"));
    }
    if length >= buffer.len() {
        return Err(BackendError::Deployment(
            "Windows system directory path exceeded the guarded buffer".into(),
        ));
    }
    let executable = PathBuf::from(OsString::from_wide(&buffer[..length])).join("curl.exe");
    if !executable.is_file() {
        return Err(BackendError::Deployment(
            "Windows curl.exe is unavailable; the pinned external tool cannot be downloaded".into(),
        ));
    }

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new(&executable)
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--tlsv1.2",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            "--max-filesize",
            "2097152",
            "--user-agent",
            "NvStrapsReBar/0.1 pinned-external-tool-fetch",
            "--output",
            "-",
            ASSET_URL,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| {
            BackendError::Deployment(format!(
                "failed to launch Windows curl.exe from {}: {error}",
                executable.display()
            ))
        })?;
    if output.stdout.len() > MAX_ASSET_BYTES {
        return Err(BackendError::Deployment(
            "Profile Inspector download exceeded the 2 MiB guard".into(),
        ));
    }
    if !output.status.success() {
        let diagnostic: String = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1024)
            .collect();
        return Err(BackendError::Deployment(format!(
            "Windows curl.exe refused the pinned Profile Inspector asset with exit code {}: {}",
            output
                .status
                .code()
                .map_or_else(|| "unknown".into(), |code| code.to_string()),
            diagnostic.trim()
        )));
    }
    verify_asset(&output.stdout)?;
    Ok(output.stdout)
}

#[cfg(not(windows))]
fn download_pinned_asset() -> BackendResult<Vec<u8>> {
    Err(BackendError::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "nvstraps-profile-inspector-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            assert!(self.0.starts_with(std::env::temp_dir()));
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn synthetic_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        for (name, bytes) in files {
            writer
                .start_file(
                    *name,
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated),
                )
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn archive_decoder_rejects_traversal_duplicates_and_digest_changes() {
        let payload = b"verified";
        let digest = Sha256Digest::from_bytes(payload).to_string();
        let pin = ArchivePin {
            name: "tool.exe",
            byte_length: payload.len() as u64,
            sha256: &digest,
            install: true,
        };
        let decoded = decode_archive(&synthetic_zip(&[("tool.exe", payload)]), &[pin]).unwrap();
        assert_eq!(decoded[0].bytes, payload);
        assert!(
            decode_archive(
                &synthetic_zip(&[("../tool.exe", payload)]),
                &[ArchivePin {
                    name: "../tool.exe",
                    ..pin
                }]
            )
            .is_err()
        );
        assert!(
            decode_archive(
                &synthetic_zip(&[("tool.exe", payload), ("extra", b"extra")]),
                &[pin]
            )
            .is_err()
        );
        let wrong_digest = "00".repeat(32);
        assert!(
            decode_archive(
                &synthetic_zip(&[("tool.exe", payload)]),
                &[ArchivePin {
                    sha256: &wrong_digest,
                    ..pin
                }]
            )
            .is_err()
        );
    }

    #[test]
    fn corrupted_existing_installations_are_never_accepted() {
        let directory = TestDirectory::new();
        let version_path = directory.0.join(VERSION);
        fs::create_dir(&version_path).unwrap();
        let mut files = Vec::new();
        for pin in ARCHIVE_PINS.iter().filter(|pin| pin.install) {
            let bytes = vec![0_u8; pin.byte_length as usize];
            fs::write(version_path.join(pin.name), &bytes).unwrap();
            files.push(ProfileInspectorFile {
                relative_path: pin.name.into(),
                byte_length: pin.byte_length,
                sha256: Sha256Digest::from_bytes(&bytes),
            });
        }
        let manifest = expected_manifest(files).unwrap();
        fs::write(
            version_path.join(MANIFEST_FILE_NAME),
            manifest_bytes(&manifest).unwrap(),
        )
        .unwrap();
        assert!(verify_installation(&version_path, false).is_err());
    }

    #[test]
    fn profile_backup_xml_is_counted_and_persisted_by_content_digest() {
        let nip = br#"<?xml version="1.0" encoding="utf-8"?>
<ArrayOfProfile>
  <Profile>
    <ProfileName>Game profile</ProfileName>
    <Executeables><string>game.exe</string><string>launcher.exe</string></Executeables>
    <Settings><ProfileSetting/><ProfileSetting/></Settings>
  </Profile>
</ArrayOfProfile>"#;
        let summary = inspect_nip(nip).unwrap();
        assert_eq!(
            summary,
            NipSummary {
                profile_count: 1,
                executable_count: 2,
                setting_count: 2,
            }
        );
        let directory = TestDirectory::new();
        let profile_id = "nvstraps-0123456789abcdef01234567";
        let tool_manifest_sha256 = Sha256Digest::from_bytes(b"tool manifest");
        let first = persist_backup(
            &directory.0,
            profile_id,
            nip,
            tool_manifest_sha256.clone(),
            summary,
        )
        .unwrap();
        let repeated =
            persist_backup(&directory.0, profile_id, nip, tool_manifest_sha256, summary).unwrap();
        assert_eq!(first, repeated);
        assert_eq!(fs::read(&first.backup_path).unwrap(), nip);
        assert_eq!(first.manifest.profile_count, 1);
    }

    #[test]
    fn profile_backup_decoder_accepts_utf16_and_rejects_doctypes() {
        let xml = "<ArrayOfProfile><Profile><Executeables/><Settings/></Profile></ArrayOfProfile>";
        let mut utf16 = vec![0xff, 0xfe];
        for word in xml.encode_utf16() {
            utf16.extend_from_slice(&word.to_le_bytes());
        }
        assert_eq!(inspect_nip(&utf16).unwrap().profile_count, 1);
        assert!(inspect_nip(b"<!DOCTYPE x><ArrayOfProfile/>").is_err());
        assert!(inspect_nip(b"<Unexpected/>").is_err());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "network smoke test for the pinned official GitHub release"]
    fn official_release_asset_and_every_archive_entry_match_the_pins() {
        let asset = download_pinned_asset().unwrap();
        verify_asset(&asset).unwrap();
        let decoded = decode_archive(&asset, &ARCHIVE_PINS).unwrap();
        assert_eq!(decoded.len(), ARCHIVE_PINS.len());
        let directory = TestDirectory::new();
        let installed = install_asset(&directory.0, &asset).unwrap();
        assert!(installed.installed_now);
        assert_eq!(
            Sha256Digest::from_bytes(fs::read(&installed.executable_path).unwrap()).as_str(),
            ARCHIVE_PINS
                .iter()
                .find(|pin| pin.name == EXECUTABLE_FILE_NAME)
                .unwrap()
                .sha256
        );
        let repeated = install_asset(&directory.0, &asset).unwrap();
        assert!(!repeated.installed_now);
        assert_eq!(repeated.manifest_sha256, installed.manifest_sha256);
    }
}
