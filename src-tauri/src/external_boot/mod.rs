pub(crate) mod core;
#[cfg(all(windows, not(feature = "simulated-machine")))]
mod windows;

use std::path::PathBuf;

use nvstraps_external::Slot;
use nvstraps_external_tool::{media::Images, read_bounded, validate_application};
use serde::Deserialize;
use tauri::{AppHandle, Manager, path::BaseDirectory};

use crate::error::{ApiError, BackendError, BackendResult, CommandResult};
use core::{ExternalBootStatus, ExternalMedium, ExternalReport};

const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CERTIFICATE_BYTES: u64 = 64 * 1024;

#[cfg(feature = "simulated-machine")]
type Platform = crate::simulated_machine::SimulatedExternalPlatform;
#[cfg(all(windows, not(feature = "simulated-machine")))]
type Platform = windows::WindowsExternalPlatform;
#[cfg(all(not(windows), not(feature = "simulated-machine")))]
type Platform = UnsupportedExternalPlatform;

#[cfg(all(not(windows), not(feature = "simulated-machine")))]
struct UnsupportedExternalPlatform;

#[cfg(all(not(windows), not(feature = "simulated-machine")))]
impl core::ExternalPlatform for UnsupportedExternalPlatform {
    fn uefi(&self) -> bool {
        false
    }

    fn elevated(&self) -> bool {
        false
    }

    fn read_global(&self, _name: &str) -> BackendResult<Option<Vec<u8>>> {
        Err(BackendError::UnsupportedPlatform)
    }

    fn read_db(&self) -> BackendResult<Option<Vec<u8>>> {
        Err(BackendError::UnsupportedPlatform)
    }

    fn write_global(&self, _name: &str, _value: &[u8]) -> BackendResult<()> {
        Err(BackendError::UnsupportedPlatform)
    }

    fn esp_volumes(&self) -> BackendResult<Vec<core::EspVolume>> {
        Err(BackendError::UnsupportedPlatform)
    }

    fn usb_volumes(&self) -> BackendResult<Vec<core::UsbVolume>> {
        Err(BackendError::UnsupportedPlatform)
    }

    fn bitlocker(&self) -> core::BitLocker {
        core::BitLocker::Unknown
    }

    fn suspend_bitlocker_once(&self) -> BackendResult<()> {
        Err(BackendError::UnsupportedPlatform)
    }

    fn now_unix_ms(&self) -> u64 {
        0
    }

    fn boot_time_unix_ms(&self) -> BackendResult<u64> {
        Err(BackendError::UnsupportedPlatform)
    }

    fn gpus(&self) -> Vec<crate::devices::GpuDevice> {
        Vec::new()
    }

    fn reboot(&self) -> BackendResult<()> {
        Err(BackendError::UnsupportedPlatform)
    }

    fn reboot_to_firmware_setup(&self) -> BackendResult<()> {
        Err(BackendError::UnsupportedPlatform)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMediumRequest {
    medium: ExternalMedium,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteExternalLoaderRequest {
    medium: ExternalMedium,
    target: Slot,
    size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveExternalCertificateRequest {
    root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartExternalBootRequest {
    suspend_bit_locker: bool,
    #[serde(default)]
    firmware_setup: bool,
}

#[tauri::command]
pub async fn inspect_external_boot(app: AppHandle) -> CommandResult<ExternalBootStatus> {
    run_blocking("external boot inspection", move || {
        let platform = platform()?;
        let bundled = read_bundled_resources(&app, &platform)?;
        core::inspect(&platform, &bundled.borrowed())
    })
    .await
}

#[tauri::command]
pub async fn prepare_external_diagnostic(
    app: AppHandle,
    request: ExternalMediumRequest,
) -> CommandResult<ExternalBootStatus> {
    run_blocking("external diagnostic preparation", move || {
        let platform = platform()?;
        let bundled = read_bundled_resources(&app, &platform)?;
        core::prepare_diagnostic(&platform, &request.medium, &bundled.borrowed())
    })
    .await
}

#[tauri::command]
pub async fn read_external_report(request: ExternalMediumRequest) -> CommandResult<ExternalReport> {
    run_blocking("external diagnostic report read", move || {
        let platform = platform()?;
        core::read_report(&platform, &request.medium)
    })
    .await
}

#[tauri::command]
pub async fn write_external_loader(
    app: AppHandle,
    request: WriteExternalLoaderRequest,
) -> CommandResult<ExternalBootStatus> {
    run_blocking("external loader write", move || {
        let platform = platform()?;
        let bundled = read_bundled_resources(&app, &platform)?;
        core::write_loader(
            &platform,
            &request.medium,
            request.target,
            request.size_bytes,
            &bundled.borrowed(),
        )
    })
    .await
}

#[tauri::command]
pub async fn make_external_boot_permanent(app: AppHandle) -> CommandResult<ExternalBootStatus> {
    run_blocking("permanent external boot configuration", move || {
        let platform = platform()?;
        let bundled = read_bundled_resources(&app, &platform)?;
        core::make_permanent(&platform, &bundled.borrowed())
    })
    .await
}

#[tauri::command]
pub async fn remove_external_boot(
    app: AppHandle,
    request: ExternalMediumRequest,
) -> CommandResult<ExternalBootStatus> {
    run_blocking("external boot removal", move || {
        let platform = platform()?;
        let bundled = read_bundled_resources(&app, &platform)?;
        core::remove(&platform, &request.medium, &bundled.borrowed())
    })
    .await
}

#[tauri::command]
pub async fn save_external_certificate(
    app: AppHandle,
    request: SaveExternalCertificateRequest,
) -> CommandResult<ExternalBootStatus> {
    run_blocking("external Secure Boot certificate save", move || {
        let platform = platform()?;
        let bundled = read_bundled_resources(&app, &platform)?;
        core::save_certificate(&platform, &request.root, &bundled.borrowed())
    })
    .await
}

#[tauri::command]
pub async fn restart_for_external_boot(request: RestartExternalBootRequest) -> CommandResult<()> {
    run_blocking("external boot restart", move || {
        let platform = platform()?;
        core::restart(
            &platform,
            request.suspend_bit_locker,
            request.firmware_setup,
        )
    })
    .await
}

async fn run_blocking<T: Send + 'static>(
    operation: &'static str,
    task: impl FnOnce() -> BackendResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| {
            ApiError::from(BackendError::External {
                code: "externalWrite",
                message: format!("{operation} worker failed: {error}"),
            })
        })?
        .map_err(ApiError::from)
}

struct BundledResources {
    diagnostic: Vec<u8>,
    loader: Vec<u8>,
    certificate: Vec<u8>,
    images_signed_override: Option<bool>,
}

impl BundledResources {
    fn borrowed(&self) -> core::ExternalResources<'_> {
        core::ExternalResources {
            images: Images {
                diagnostic: &self.diagnostic,
                loader: &self.loader,
            },
            certificate: &self.certificate,
            images_signed_override: self.images_signed_override,
        }
    }
}

fn read_bundled_resources(app: &AppHandle, platform: &Platform) -> BackendResult<BundledResources> {
    let diagnostic = read_bundled_image(app, "external/NvStrapsDiagnostic.efi")?;
    let loader = read_bundled_image(app, "external/NvStrapsLoader.efi")?;
    let certificate = read_bundled_certificate(app)?;
    Ok(BundledResources {
        diagnostic,
        loader,
        certificate,
        images_signed_override: images_signed_override(platform)?,
    })
}

fn read_bundled_image(app: &AppHandle, resource: &str) -> BackendResult<Vec<u8>> {
    let path = app
        .path()
        .resolve(resource, BaseDirectory::Resource)
        .map_err(|error| image_error(resource, None, error.to_string()))?;
    let bytes = read_bounded(&path, MAX_IMAGE_BYTES)
        .map_err(|error| image_error(resource, Some(&path), error))?;
    validate_application(&bytes).map_err(|error| image_error(resource, Some(&path), error))?;
    Ok(bytes)
}

fn read_bundled_certificate(app: &AppHandle) -> BackendResult<Vec<u8>> {
    const RESOURCE: &str = "external/NvStrapsReBar-db.cer";
    let path = app
        .path()
        .resolve(RESOURCE, BaseDirectory::Resource)
        .map_err(|error| certificate_error(None, error.to_string()))?;
    read_bounded(&path, MAX_CERTIFICATE_BYTES)
        .map_err(|error| certificate_error(Some(&path), error))
}

fn certificate_error(path: Option<&PathBuf>, detail: String) -> BackendError {
    let location = path.map_or_else(
        || "external/NvStrapsReBar-db.cer".to_owned(),
        |path| path.to_string_lossy().into_owned(),
    );
    BackendError::External {
        code: "externalWrite",
        message: format!("bundled Secure Boot certificate is unavailable at {location}: {detail}"),
    }
}

#[cfg(feature = "simulated-machine")]
fn images_signed_override(platform: &Platform) -> BackendResult<Option<bool>> {
    platform.images_signed().map(Some)
}

#[cfg(not(feature = "simulated-machine"))]
fn images_signed_override(_platform: &Platform) -> BackendResult<Option<bool>> {
    Ok(None)
}

fn image_error(resource: &str, path: Option<&PathBuf>, detail: String) -> BackendError {
    let location = path.map_or_else(
        || resource.to_owned(),
        |path| path.to_string_lossy().into_owned(),
    );
    BackendError::External {
        code: "externalWrite",
        message: format!("bundled external EFI image is unavailable at {location}: {detail}"),
    }
}

#[cfg(feature = "simulated-machine")]
fn platform() -> BackendResult<Platform> {
    crate::simulated_machine::external_platform()
}

#[cfg(all(windows, not(feature = "simulated-machine")))]
fn platform() -> BackendResult<Platform> {
    Ok(windows::WindowsExternalPlatform::new())
}

#[cfg(all(not(windows), not(feature = "simulated-machine")))]
fn platform() -> BackendResult<Platform> {
    Ok(UnsupportedExternalPlatform)
}
