use std::{
    ffi::{OsString, c_void},
    mem::size_of,
    os::windows::{ffi::OsStringExt, process::CommandExt},
    path::PathBuf,
    ptr,
    time::{SystemTime, UNIX_EPOCH},
};

use windows_sys::{
    Win32::{
        Foundation::{
            CloseHandle, ERROR_ENVVAR_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_MORE_DATA,
            ERROR_NO_MORE_FILES, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
        },
        Storage::FileSystem::{
            BusTypeUsb, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE,
            FindFirstVolumeW, FindNextVolumeW, FindVolumeClose, GetDiskFreeSpaceExW, GetDriveTypeW,
            GetVolumeInformationW, GetVolumePathNamesForVolumeNameW, OPEN_EXISTING,
        },
        System::{
            IO::DeviceIoControl,
            Ioctl::{
                IOCTL_DISK_GET_PARTITION_INFO_EX, IOCTL_STORAGE_QUERY_PROPERTY,
                PARTITION_INFORMATION_EX, PARTITION_STYLE_GPT, PropertyStandardQuery,
                STORAGE_DEVICE_DESCRIPTOR, STORAGE_PROPERTY_QUERY, StorageDeviceProperty,
            },
            SystemInformation::GetSystemDirectoryW,
            WindowsProgramming::{
                DRIVE_REMOVABLE, GetFirmwareEnvironmentVariableExW,
                SetFirmwareEnvironmentVariableExW,
            },
        },
    },
    core::GUID,
};

use crate::{
    deployment_workflow::current_boot_time_unix_ms,
    devices::enumerate_gpus,
    error::{BackendError, BackendResult},
    firmware, reboot,
};

use super::core::{
    BitLocker, EspVolume, ExternalPlatform, UsbVolume, read_name_allowed, write_name_allowed,
};

const EFI_GLOBAL_VARIABLE_GUID: &str = "{8BE4DF61-93CA-11D2-AA0D-00E098032B8C}";
const EFI_IMAGE_SECURITY_DATABASE_GUID: &str = "{D719B2CB-3D3A-4596-A3BC-DAD00E67656F}";
const EFI_VARIABLE_ATTRIBUTES: u32 = 0x7;
const MAX_FIRMWARE_VARIABLE_BYTES: usize = 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const EFI_SYSTEM_PARTITION_GUID: GUID = GUID {
    data1: 0xc12a_7328,
    data2: 0xf81f,
    data3: 0x11d2,
    data4: [0xba, 0x4b, 0x00, 0xa0, 0xc9, 0x3e, 0xc9, 0x3b],
};

pub(crate) struct WindowsExternalPlatform {
    access: firmware::FirmwareAccess,
}

impl WindowsExternalPlatform {
    pub(crate) fn new() -> Self {
        Self {
            access: firmware::inspect_access(),
        }
    }
}

impl ExternalPlatform for WindowsExternalPlatform {
    fn uefi(&self) -> bool {
        self.access.is_uefi
    }

    fn elevated(&self) -> bool {
        self.access.is_elevated
    }

    fn read_global(&self, name: &str) -> BackendResult<Option<Vec<u8>>> {
        read_global(name)
    }

    fn read_db(&self) -> BackendResult<Option<Vec<u8>>> {
        read_db()
    }

    fn write_global(&self, name: &str, value: &[u8]) -> BackendResult<()> {
        write_global(name, value)
    }

    fn esp_volumes(&self) -> BackendResult<Vec<EspVolume>> {
        esp_volumes()
    }

    fn usb_volumes(&self) -> BackendResult<Vec<UsbVolume>> {
        usb_volumes()
    }

    fn bitlocker(&self) -> BitLocker {
        bitlocker_status()
    }

    fn suspend_bitlocker_once(&self) -> BackendResult<()> {
        suspend_bitlocker_once()
    }

    fn now_unix_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }

    fn boot_time_unix_ms(&self) -> BackendResult<u64> {
        current_boot_time_unix_ms()
    }

    fn gpus(&self) -> Vec<crate::devices::GpuDevice> {
        enumerate_gpus().unwrap_or_default()
    }

    fn reboot(&self) -> BackendResult<()> {
        reboot::execute_reboot(&["/r", "/t", "0"], "external boot")
    }

    fn reboot_to_firmware_setup(&self) -> BackendResult<()> {
        reboot::execute_reboot(&["/r", "/fw", "/t", "0"], "firmware setup")
    }
}

fn read_global(name: &str) -> BackendResult<Option<Vec<u8>>> {
    if !read_name_allowed(name) {
        return Err(external_write(format!(
            "firmware variable read is not allowed: {name}"
        )));
    }
    read_firmware_variable(name, EFI_GLOBAL_VARIABLE_GUID)
}

fn read_db() -> BackendResult<Option<Vec<u8>>> {
    read_firmware_variable("db", EFI_IMAGE_SECURITY_DATABASE_GUID)
}

fn read_firmware_variable(name: &str, guid: &str) -> BackendResult<Option<Vec<u8>>> {
    firmware::windows_impl::enable_system_environment_privilege()?;
    let name = wide(name);
    let guid = wide(guid);
    let mut capacity = 1024_usize;
    loop {
        let mut attributes = 0_u32;
        let mut buffer = vec![0_u8; capacity];
        // SAFETY: both strings are NUL terminated and the output buffer and attributes are writable.
        let size = unsafe {
            GetFirmwareEnvironmentVariableExW(
                name.as_ptr(),
                guid.as_ptr(),
                buffer.as_mut_ptr().cast::<c_void>(),
                buffer.len() as u32,
                &mut attributes,
            )
        };
        if size != 0 {
            buffer.truncate(size as usize);
            return Ok(Some(buffer));
        }
        // SAFETY: GetLastError has no preconditions.
        let error = unsafe { GetLastError() };
        if error == ERROR_ENVVAR_NOT_FOUND {
            return Ok(None);
        }
        if error == ERROR_INSUFFICIENT_BUFFER && capacity < MAX_FIRMWARE_VARIABLE_BYTES {
            capacity = capacity.saturating_mul(2).min(MAX_FIRMWARE_VARIABLE_BYTES);
            continue;
        }
        return Err(BackendError::Windows {
            operation: "GetFirmwareEnvironmentVariableExW",
            code: error,
        });
    }
}

fn write_global(name: &str, value: &[u8]) -> BackendResult<()> {
    if !write_name_allowed(name) {
        return Err(external_write(format!(
            "firmware variable write is not allowed: {name}"
        )));
    }
    firmware::windows_impl::enable_system_environment_privilege()?;
    let name = wide(name);
    let guid = wide(EFI_GLOBAL_VARIABLE_GUID);
    let pointer = if value.is_empty() {
        ptr::null()
    } else {
        value.as_ptr().cast::<c_void>()
    };
    // SAFETY: strings are NUL terminated and the value pointer matches its byte count.
    let success = unsafe {
        SetFirmwareEnvironmentVariableExW(
            name.as_ptr(),
            guid.as_ptr(),
            pointer,
            value.len() as u32,
            EFI_VARIABLE_ATTRIBUTES,
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

fn esp_volumes() -> BackendResult<Vec<EspVolume>> {
    let mut result = Vec::new();
    for volume in volume_names()? {
        let Some(partition) = partition_information(&volume)? else {
            continue;
        };
        if partition.PartitionStyle != PARTITION_STYLE_GPT {
            continue;
        }
        // SAFETY: PartitionStyle is GPT, so the GPT union member is initialized by Windows.
        let gpt = unsafe { partition.Anonymous.Gpt };
        if !guid_equal(gpt.PartitionType, EFI_SYSTEM_PARTITION_GUID) {
            continue;
        }
        result.push(EspVolume {
            partition_guid: guid_string(gpt.PartitionId),
            root: PathBuf::from(volume),
        });
    }
    Ok(result)
}

fn usb_volumes() -> BackendResult<Vec<UsbVolume>> {
    let system_drive = std::env::var("SystemDrive")
        .map(|drive| format!("{}\\", drive.trim_end_matches(['\\', '/'])))
        .map_err(|_| external_write("SystemDrive is unavailable; USB enumeration was refused"))?;
    if !is_drive_root(&system_drive) {
        return Err(external_write(
            "SystemDrive is not a drive letter; USB enumeration was refused",
        ));
    }
    let mut result = Vec::new();
    for volume in volume_names()? {
        let bus_usb = volume_is_usb(&volume).unwrap_or(false);
        for root in volume_paths(&volume)? {
            if !is_drive_root(&root) || root.eq_ignore_ascii_case(&system_drive) {
                continue;
            }
            let root_wide = wide(&root);
            // SAFETY: root_wide is a valid NUL-terminated drive-root string.
            let removable = unsafe { GetDriveTypeW(root_wide.as_ptr()) } == DRIVE_REMOVABLE;
            if !removable && !bus_usb {
                continue;
            }
            let (label, file_system) = volume_information(&root)?;
            let total_bytes = volume_total_bytes(&root)?;
            result.push(UsbVolume {
                root: root.clone(),
                path: PathBuf::from(&root),
                label,
                file_system,
                total_bytes,
            });
        }
    }
    result.sort_by(|left, right| left.root.cmp(&right.root));
    result.dedup_by(|left, right| left.root.eq_ignore_ascii_case(&right.root));
    Ok(result)
}

fn volume_names() -> BackendResult<Vec<String>> {
    let mut buffer = vec![0_u16; 1024];
    // SAFETY: buffer is writable for its declared capacity.
    let handle = unsafe { FindFirstVolumeW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(BackendError::windows("FindFirstVolumeW"));
    }
    let guard = FindVolumeGuard(handle);
    let mut names = vec![from_wide_nul(&buffer)?];
    loop {
        buffer.fill(0);
        // SAFETY: the find handle is valid and buffer is writable.
        let success = unsafe { FindNextVolumeW(guard.0, buffer.as_mut_ptr(), buffer.len() as u32) };
        if success != 0 {
            names.push(from_wide_nul(&buffer)?);
            continue;
        }
        // SAFETY: GetLastError has no preconditions.
        let error = unsafe { GetLastError() };
        if error == ERROR_NO_MORE_FILES {
            break;
        }
        return Err(BackendError::Windows {
            operation: "FindNextVolumeW",
            code: error,
        });
    }
    Ok(names)
}

fn volume_paths(volume: &str) -> BackendResult<Vec<String>> {
    let volume = wide(volume);
    let mut capacity = 256_u32;
    loop {
        let mut buffer = vec![0_u16; capacity as usize];
        let mut required = 0_u32;
        // SAFETY: volume is NUL terminated and the output buffer and size pointer are valid.
        let success = unsafe {
            GetVolumePathNamesForVolumeNameW(
                volume.as_ptr(),
                buffer.as_mut_ptr(),
                capacity,
                &mut required,
            )
        };
        if success != 0 {
            return Ok(parse_multi_sz(&buffer));
        }
        // SAFETY: GetLastError has no preconditions.
        let error = unsafe { GetLastError() };
        if matches!(error, ERROR_MORE_DATA | ERROR_INSUFFICIENT_BUFFER) && required > capacity {
            capacity = required;
            continue;
        }
        return Err(BackendError::Windows {
            operation: "GetVolumePathNamesForVolumeNameW",
            code: error,
        });
    }
}

fn partition_information(volume: &str) -> BackendResult<Option<PARTITION_INFORMATION_EX>> {
    let handle = match open_volume(volume) {
        Ok(handle) => handle,
        Err(_) => return Ok(None),
    };
    let mut information = PARTITION_INFORMATION_EX::default();
    let mut returned = 0_u32;
    // SAFETY: handle is valid, there is no input buffer, and the output structure is writable.
    let success = unsafe {
        DeviceIoControl(
            handle.0,
            IOCTL_DISK_GET_PARTITION_INFO_EX,
            ptr::null(),
            0,
            (&mut information as *mut PARTITION_INFORMATION_EX).cast::<c_void>(),
            size_of::<PARTITION_INFORMATION_EX>() as u32,
            &mut returned,
            ptr::null_mut(),
        )
    };
    if success == 0 {
        Ok(None)
    } else {
        Ok(Some(information))
    }
}

fn volume_is_usb(volume: &str) -> BackendResult<bool> {
    let handle = open_volume(volume)?;
    let query = STORAGE_PROPERTY_QUERY {
        PropertyId: StorageDeviceProperty,
        QueryType: PropertyStandardQuery,
        AdditionalParameters: [0],
    };
    let mut descriptor = STORAGE_DEVICE_DESCRIPTOR::default();
    let mut returned = 0_u32;
    // SAFETY: handle and the fixed input/output structures are valid for this synchronous request.
    let success = unsafe {
        DeviceIoControl(
            handle.0,
            IOCTL_STORAGE_QUERY_PROPERTY,
            (&query as *const STORAGE_PROPERTY_QUERY).cast::<c_void>(),
            size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            (&mut descriptor as *mut STORAGE_DEVICE_DESCRIPTOR).cast::<c_void>(),
            size_of::<STORAGE_DEVICE_DESCRIPTOR>() as u32,
            &mut returned,
            ptr::null_mut(),
        )
    };
    if success == 0 {
        Err(BackendError::windows(
            "DeviceIoControl(IOCTL_STORAGE_QUERY_PROPERTY)",
        ))
    } else {
        Ok(descriptor.BusType == BusTypeUsb)
    }
}

fn open_volume(volume: &str) -> BackendResult<HandleGuard> {
    let path = volume.trim_end_matches('\\');
    let path = wide(path);
    // SAFETY: path is NUL terminated; null security attributes and template handles are allowed.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(BackendError::windows("CreateFileW(volume)"))
    } else {
        Ok(HandleGuard(handle))
    }
}

fn volume_information(root: &str) -> BackendResult<(String, String)> {
    let root = wide(root);
    let mut label = [0_u16; 261];
    let mut file_system = [0_u16; 64];
    // SAFETY: root is NUL terminated; both output buffers are writable and optional outputs are null.
    let success = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            label.as_mut_ptr(),
            label.len() as u32,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            file_system.as_mut_ptr(),
            file_system.len() as u32,
        )
    };
    if success == 0 {
        return Err(BackendError::windows("GetVolumeInformationW"));
    }
    Ok((from_wide_nul(&label)?, from_wide_nul(&file_system)?))
}

fn volume_total_bytes(root: &str) -> BackendResult<u64> {
    let root = wide(root);
    let mut total = 0_u64;
    // SAFETY: root is NUL terminated, total is writable, and the other outputs are optional.
    let success =
        unsafe { GetDiskFreeSpaceExW(root.as_ptr(), ptr::null_mut(), &mut total, ptr::null_mut()) };
    if success == 0 {
        Err(BackendError::windows("GetDiskFreeSpaceExW"))
    } else {
        Ok(total)
    }
}

fn bitlocker_status() -> BitLocker {
    let script = concat!(
        "$ErrorActionPreference='Stop';",
        "try {",
        "$d=[Environment]::GetEnvironmentVariable('SystemDrive');",
        "$v=Get-CimInstance -Namespace 'root\\cimv2\\security\\microsoftvolumeencryption' ",
        "-ClassName 'Win32_EncryptableVolume' -Filter \"DriveLetter='$d'\";",
        "if ($null -eq $v) { 'MISSING' } else { 'STATUS=' + [int]$v.ProtectionStatus }",
        "} catch [Microsoft.Management.Infrastructure.CimException] {",
        "'CIM=' + [int]$_.Exception.NativeErrorCode",
        "} catch { 'ERROR' }"
    );
    let Ok(output) = powershell_output(script) else {
        return BitLocker::Unknown;
    };
    match output.trim() {
        "MISSING" | "CIM=3" | "CIM=5" => BitLocker::Off,
        "STATUS=0" => BitLocker::Off,
        "STATUS=1" => BitLocker::On,
        _ => BitLocker::Unknown,
    }
}

fn suspend_bitlocker_once() -> BackendResult<()> {
    let script = concat!(
        "$ErrorActionPreference='Stop';",
        "$d=[Environment]::GetEnvironmentVariable('SystemDrive');",
        "$v=Get-CimInstance -Namespace 'root\\cimv2\\security\\microsoftvolumeencryption' ",
        "-ClassName 'Win32_EncryptableVolume' -Filter \"DriveLetter='$d'\";",
        "if ($null -eq $v) { 'MISSING'; exit 2 };",
        "$r=Invoke-CimMethod -InputObject $v -MethodName 'DisableKeyProtectors' ",
        "-Arguments @{DisableCount=[uint32]1};",
        "'RETURN=' + [uint32]$r.ReturnValue"
    );
    let output = powershell_output(script)?;
    if output.trim() == "RETURN=0" {
        Ok(())
    } else {
        Err(external_write(format!(
            "BitLocker DisableKeyProtectors(DisableCount=1) returned {}",
            output.trim()
        )))
    }
}

fn powershell_output(script: &str) -> BackendResult<String> {
    let executable = system_directory()?.join("WindowsPowerShell/v1.0/powershell.exe");
    if !executable.is_file() {
        return Err(external_write(format!(
            "Windows PowerShell is unavailable at {}",
            executable.display()
        )));
    }
    let output = std::process::Command::new(&executable)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| {
            external_write(format!(
                "failed to launch hidden Windows PowerShell: {error}"
            ))
        })?;
    if !output.status.success() {
        return Err(external_write(format!(
            "hidden Windows PowerShell exited with code {}",
            output
                .status
                .code()
                .map_or_else(|| "unknown".to_owned(), |code| code.to_string())
        )));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| external_write("hidden Windows PowerShell returned non-UTF-8 output"))
}

fn system_directory() -> BackendResult<PathBuf> {
    let mut buffer = [0_u16; 32_768];
    // SAFETY: buffer is writable and its exact capacity is supplied.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 {
        return Err(BackendError::windows("GetSystemDirectoryW"));
    }
    if length >= buffer.len() {
        return Err(external_write(
            "Windows system directory exceeded the guarded buffer",
        ));
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

fn parse_multi_sz(buffer: &[u16]) -> Vec<String> {
    buffer
        .split(|unit| *unit == 0)
        .take_while(|value| !value.is_empty())
        .map(|value| OsString::from_wide(value).to_string_lossy().into_owned())
        .collect()
}

fn from_wide_nul(buffer: &[u16]) -> BackendResult<String> {
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .ok_or_else(|| external_write("Windows returned a string without a NUL terminator"))?;
    Ok(OsString::from_wide(&buffer[..length])
        .to_string_lossy()
        .into_owned())
}

fn is_drive_root(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() == 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

fn guid_equal(left: GUID, right: GUID) -> bool {
    left.data1 == right.data1
        && left.data2 == right.data2
        && left.data3 == right.data3
        && left.data4 == right.data4
}

fn guid_string(guid: GUID) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        guid.data1,
        guid.data2,
        guid.data3,
        guid.data4[0],
        guid.data4[1],
        guid.data4[2],
        guid.data4[3],
        guid.data4[4],
        guid.data4[5],
        guid.data4[6],
        guid.data4[7]
    )
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn external_write(message: impl Into<String>) -> BackendError {
    BackendError::External {
        code: "externalWrite",
        message: message.into(),
    }
}

struct HandleGuard(HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        if self.0 != INVALID_HANDLE_VALUE && !self.0.is_null() {
            // SAFETY: this guard owns the valid kernel handle.
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct FindVolumeGuard(HANDLE);

impl Drop for FindVolumeGuard {
    fn drop(&mut self) {
        // SAFETY: this guard owns the volume enumeration handle.
        unsafe { FindVolumeClose(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_and_multi_string_helpers_use_windows_wire_formats() {
        let guid = GUID {
            data1: 0x02d5_d49a,
            data2: 0xd31c,
            data3: 0x11eb,
            data4: [0x9d, 0xe1, 0xd8, 0x50, 0xe6, 0xdc, 0xcc, 0xd2],
        };
        assert_eq!(guid_string(guid), "02d5d49a-d31c-11eb-9de1-d850e6dcccd2");
        assert_eq!(
            parse_multi_sz(&[
                b'E' as u16,
                b':' as u16,
                b'\\' as u16,
                0,
                b'F' as u16,
                b':' as u16,
                b'\\' as u16,
                0,
                0,
            ]),
            ["E:\\", "F:\\"]
        );
    }
}
