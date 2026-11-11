//! The command behind the Linux file and folder choosers.
//!
//! On Windows the frontend opens the dialog plugin's dialogs, which belong to the app window. On
//! Linux the plugin gives its dialog no parent window, so the chooser was a window of its own
//! that could be minimized behind the app (issue #63); there the frontend calls this command.

use crate::error::CommandResult;

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) async fn choose_path(
    window: tauri::WebviewWindow,
    chooser: crate::linux::desktop::PathChooser,
) -> CommandResult<Option<String>> {
    Ok(crate::linux::desktop::choose_path(window, chooser).await?)
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn choose_path() -> CommandResult<Option<String>> {
    Err(crate::error::BackendError::UnsupportedPlatform.into())
}
