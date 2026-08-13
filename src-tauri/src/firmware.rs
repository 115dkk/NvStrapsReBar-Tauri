use crate::error::{BackendError, BackendResult};

pub use nvstraps_core::{CONFIG_VARIABLE_NAME, STATUS_VARIABLE_NAME};

#[derive(Clone, Debug)]
pub struct FirmwareAccess {
    pub is_uefi: bool,
    pub is_elevated: bool,
    pub privilege_enabled: bool,
}

pub fn inspect_access() -> FirmwareAccess {
    #[cfg(windows)]
    {
        windows_impl::inspect_access()
    }

    #[cfg(not(windows))]
    {
        FirmwareAccess {
            is_uefi: false,
            is_elevated: false,
            privilege_enabled: false,
        }
    }
}

pub fn read_variable(name: &'static str) -> BackendResult<Option<Vec<u8>>> {
    #[cfg(windows)]
    {
        windows_impl::read_variable(name)
    }

    #[cfg(not(windows))]
    {
        let _ = name;
        Err(BackendError::UnsupportedPlatform)
    }
}

pub fn write_variable(name: &'static str, value: &[u8]) -> BackendResult<()> {
    #[cfg(windows)]
    {
        windows_impl::write_variable(name, value)
    }

    #[cfg(not(windows))]
    {
        let _ = (name, value);
        Err(BackendError::UnsupportedPlatform)
    }
}

pub fn relaunch_elevated() -> BackendResult<()> {
    #[cfg(windows)]
    {
        windows_impl::relaunch_elevated()
    }

    #[cfg(not(windows))]
    {
        Err(BackendError::UnsupportedPlatform)
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::{ffi::c_void, mem::size_of, ptr};

    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, ERROR_ENVVAR_NOT_FOUND, ERROR_NOT_ALL_ASSIGNED, GetLastError, HANDLE,
        },
        Security::{
            AdjustTokenPrivileges, GetTokenInformation, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW,
            SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES, TOKEN_ELEVATION, TOKEN_PRIVILEGES,
            TOKEN_QUERY, TokenElevation,
        },
        System::{
            SystemInformation::{FirmwareTypeUefi, GetFirmwareType},
            Threading::{GetCurrentProcess, OpenProcessToken},
            WindowsProgramming::{
                GetFirmwareEnvironmentVariableExW, SetFirmwareEnvironmentVariableExW,
            },
        },
        UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };

    use super::*;
    use nvstraps_core::{CONFIG_VARIABLE_ATTRIBUTES, VARIABLE_VENDOR_GUID_STRING};

    struct HandleGuard(HANDLE);

    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: the token handle is owned by this guard.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    pub fn inspect_access() -> FirmwareAccess {
        FirmwareAccess {
            is_uefi: is_uefi(),
            is_elevated: is_elevated().unwrap_or(false),
            privilege_enabled: enable_system_environment_privilege().is_ok(),
        }
    }

    pub fn read_variable(name: &'static str) -> BackendResult<Option<Vec<u8>>> {
        enable_system_environment_privilege()?;
        let name = wide(name);
        let guid = wide(VARIABLE_VENDOR_GUID_STRING);
        let mut attributes = 0_u32;
        let mut buffer = vec![0_u8; 1024];
        // SAFETY: all pointers refer to valid, writable storage and strings are null terminated.
        let size = unsafe {
            GetFirmwareEnvironmentVariableExW(
                name.as_ptr(),
                guid.as_ptr(),
                buffer.as_mut_ptr().cast::<c_void>(),
                buffer.len() as u32,
                &mut attributes,
            )
        };
        if size == 0 {
            // SAFETY: GetLastError has no preconditions.
            let error = unsafe { GetLastError() };
            if error == ERROR_ENVVAR_NOT_FOUND {
                return Ok(None);
            }
            return Err(BackendError::Windows {
                operation: "GetFirmwareEnvironmentVariableExW",
                code: error,
            });
        }
        buffer.truncate(size as usize);
        Ok(Some(buffer))
    }

    pub fn write_variable(name: &'static str, value: &[u8]) -> BackendResult<()> {
        enable_system_environment_privilege()?;
        let name = wide(name);
        let guid = wide(VARIABLE_VENDOR_GUID_STRING);
        let attributes = CONFIG_VARIABLE_ATTRIBUTES;
        let pointer = if value.is_empty() {
            ptr::null()
        } else {
            value.as_ptr().cast::<c_void>()
        };
        // SAFETY: strings are null terminated and the value pointer/size pair is valid.
        let success = unsafe {
            SetFirmwareEnvironmentVariableExW(
                name.as_ptr(),
                guid.as_ptr(),
                pointer,
                value.len() as u32,
                attributes,
            )
        };
        if success != 0 {
            return Ok(());
        }
        // SAFETY: GetLastError has no preconditions.
        let error = unsafe { GetLastError() };
        if value.is_empty() && error == ERROR_ENVVAR_NOT_FOUND {
            Ok(())
        } else {
            Err(BackendError::Windows {
                operation: "SetFirmwareEnvironmentVariableExW",
                code: error,
            })
        }
    }

    pub fn relaunch_elevated() -> BackendResult<()> {
        let executable =
            std::env::current_exe().map_err(|error| BackendError::Elevation(error.to_string()))?;
        let executable = wide(&executable.to_string_lossy());
        let verb = wide("runas");
        // SAFETY: strings are null terminated and null optional arguments are allowed.
        let result = unsafe {
            ShellExecuteW(
                ptr::null_mut(),
                verb.as_ptr(),
                executable.as_ptr(),
                ptr::null(),
                ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize > 32 {
            Ok(())
        } else {
            Err(BackendError::Elevation(format!(
                "ShellExecuteW returned {}",
                result as isize
            )))
        }
    }

    fn is_uefi() -> bool {
        let mut firmware_type = 0;
        // SAFETY: output pointer is valid.
        unsafe { GetFirmwareType(&mut firmware_type) != 0 && firmware_type == FirmwareTypeUefi }
    }

    fn is_elevated() -> BackendResult<bool> {
        let token = open_process_token(TOKEN_QUERY)?;
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut returned = 0;
        // SAFETY: token and output buffers are valid.
        let success = unsafe {
            GetTokenInformation(
                token.0,
                TokenElevation,
                &mut elevation as *mut _ as *mut c_void,
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            )
        };
        if success == 0 {
            Err(BackendError::windows("GetTokenInformation"))
        } else {
            Ok(elevation.TokenIsElevated != 0)
        }
    }

    fn enable_system_environment_privilege() -> BackendResult<()> {
        let token = open_process_token(TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY)?;
        let privilege_name = wide("SeSystemEnvironmentPrivilege");
        let mut luid = Default::default();
        // SAFETY: output pointer and null-terminated privilege string are valid.
        if unsafe { LookupPrivilegeValueW(ptr::null(), privilege_name.as_ptr(), &mut luid) } == 0 {
            return Err(BackendError::windows("LookupPrivilegeValueW"));
        }
        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        // SAFETY: token and input structure are valid; optional outputs are null.
        if unsafe {
            AdjustTokenPrivileges(token.0, 0, &privileges, 0, ptr::null_mut(), ptr::null_mut())
        } == 0
        {
            return Err(BackendError::windows("AdjustTokenPrivileges"));
        }
        // SAFETY: GetLastError has no preconditions and AdjustTokenPrivileges documents its use.
        let error = unsafe { GetLastError() };
        if error == ERROR_NOT_ALL_ASSIGNED {
            return Err(BackendError::Windows {
                operation: "AdjustTokenPrivileges",
                code: error,
            });
        }
        Ok(())
    }

    fn open_process_token(access: u32) -> BackendResult<HandleGuard> {
        let mut token = ptr::null_mut();
        // SAFETY: current process pseudo-handle and output pointer are valid.
        if unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) } == 0 {
            Err(BackendError::windows("OpenProcessToken"))
        } else {
            Ok(HandleGuard(token))
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
}
