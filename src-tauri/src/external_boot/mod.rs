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
pub struct RestartExternalBootRequest {
    suspend_bit_locker: bool,
}

#[tauri::command]
pub async fn inspect_external_boot() -> CommandResult<ExternalBootStatus> {
    run_blocking("external boot inspection", move || {
        let platform = platform()?;
        core::inspect(&platform)
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
        let (diagnostic, loader) = read_bundled_images(&app)?;
        let images = Images {
            diagnostic: &diagnostic,
            loader: &loader,
        };
        core::prepare_diagnostic(&platform, &request.medium, &images)
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
        let (diagnostic, loader) = read_bundled_images(&app)?;
        let images = Images {
            diagnostic: &diagnostic,
            loader: &loader,
        };
        core::write_loader(
            &platform,
            &request.medium,
            request.target,
            request.size_bytes,
            &images,
        )
    })
    .await
}

#[tauri::command]
pub async fn make_external_boot_permanent() -> CommandResult<ExternalBootStatus> {
    run_blocking("permanent external boot configuration", move || {
        let platform = platform()?;
        core::make_permanent(&platform)
    })
    .await
}

#[tauri::command]
pub async fn remove_external_boot(
    request: ExternalMediumRequest,
) -> CommandResult<ExternalBootStatus> {
    run_blocking("external boot removal", move || {
        let platform = platform()?;
        core::remove(&platform, &request.medium)
    })
    .await
}

#[tauri::command]
pub async fn restart_for_external_boot(request: RestartExternalBootRequest) -> CommandResult<()> {
    run_blocking("external boot restart", move || {
        let platform = platform()?;
        core::restart(&platform, request.suspend_bit_locker)
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

fn read_bundled_images(app: &AppHandle) -> BackendResult<(Vec<u8>, Vec<u8>)> {
    let diagnostic = read_bundled_image(app, "external/NvStrapsDiagnostic.efi")?;
    let loader = read_bundled_image(app, "external/NvStrapsLoader.efi")?;
    Ok((diagnostic, loader))
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
