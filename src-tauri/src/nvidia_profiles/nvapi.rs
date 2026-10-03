//! NVAPI driver settings (DRS) through `nvapi64.dll`, which the NVIDIA driver installs.
//!
//! Interface IDs and struct layouts come from NVIDIA's NVAPI SDK (`nvapi_interface.h`, `nvapi.h`,
//! MIT, Copyright (c) 2019-2026 NVIDIA CORPORATION & AFFILIATES); see THIRD_PARTY_NOTICES.md.

use std::{
    ffi::c_void,
    path::Path,
    ptr,
    sync::atomic::{AtomicI32, Ordering},
};

use super::{
    drs::{
        DrsDriver, DrsError, DrsResult, DrsSession, NVAPI_END_ENUMERATION, NVAPI_NO_IMPLEMENTATION,
        NVAPI_PROFILE_NOT_FOUND, NVAPI_SETTING_NOT_FOUND, ProfileHandle, ProfileInfo,
    },
    policy::{Location, Setting, Value},
};

const NVAPI_OK: i32 = 0;
const NVAPI_INVALID_ARGUMENT: i32 = -5;

const UNICODE_STRING_MAX: usize = 2048;
const BINARY_DATA_MAX: usize = 4096;
/// The value unions hold at most an `NVDRS_BINARY_SETTING`: a length and 4096 bytes.
const SETTING_VALUE_BYTES: usize = 4 + BINARY_DATA_MAX;
const SHORT_STRING_MAX: usize = 64;
const MAX_APPLICATIONS: u32 = 4096;

const DWORD_TYPE: u32 = 0;
const BINARY_TYPE: u32 = 1;
const QWORD_TYPE: u32 = 4;

type UnicodeString = [u16; UNICODE_STRING_MAX];
type Handle = *mut c_void;

/// `nvapi_QueryInterface`: resolves an NVAPI function from its interface ID.
pub type QueryInterface = unsafe extern "C" fn(u32) -> *mut c_void;

const fn struct_version<T>(revision: u32) -> u32 {
    size_of::<T>() as u32 | (revision << 16)
}

/// `NVDRS_PROFILE_V1`.
#[repr(C)]
#[derive(Clone, Copy)]
struct NvdrsProfile {
    version: u32,
    profile_name: UnicodeString,
    gpu_support: u32,
    is_predefined: u32,
    num_of_apps: u32,
    num_of_settings: u32,
}

/// `NVDRS_APPLICATION_V4`.
#[repr(C)]
#[derive(Clone, Copy)]
struct NvdrsApplication {
    version: u32,
    is_predefined: u32,
    app_name: UnicodeString,
    user_friendly_name: UnicodeString,
    launcher: UnicodeString,
    file_in_folder: UnicodeString,
    flags: u32,
    command_line: UnicodeString,
}

/// `NVDRS_SETTING_V1` (`#pragma pack(4)`; the value unions are kept as raw bytes).
#[repr(C)]
#[derive(Clone, Copy)]
struct NvdrsSetting {
    version: u32,
    setting_name: UnicodeString,
    setting_id: u32,
    setting_type: u32,
    setting_location: u32,
    is_current_predefined: u32,
    is_predefined_valid: u32,
    predefined_value: [u8; SETTING_VALUE_BYTES],
    current_value: [u8; SETTING_VALUE_BYTES],
}

// The sizes nvapi.h gives these structs; their versions encode the size.
const _: () = assert!(size_of::<NvdrsProfile>() == 4116);
const _: () = assert!(size_of::<NvdrsApplication>() == 20492);
const _: () = assert!(size_of::<NvdrsSetting>() == 12320);

impl NvdrsProfile {
    fn empty() -> Box<Self> {
        Box::new(Self {
            version: struct_version::<Self>(1),
            profile_name: [0; UNICODE_STRING_MAX],
            gpu_support: 0,
            is_predefined: 0,
            num_of_apps: 0,
            num_of_settings: 0,
        })
    }
}

impl NvdrsApplication {
    fn empty() -> Self {
        Self {
            version: struct_version::<Self>(4),
            is_predefined: 0,
            app_name: [0; UNICODE_STRING_MAX],
            user_friendly_name: [0; UNICODE_STRING_MAX],
            launcher: [0; UNICODE_STRING_MAX],
            file_in_folder: [0; UNICODE_STRING_MAX],
            flags: 0,
            command_line: [0; UNICODE_STRING_MAX],
        }
    }
}

impl NvdrsSetting {
    fn empty() -> Box<Self> {
        Box::new(Self {
            version: struct_version::<Self>(1),
            setting_name: [0; UNICODE_STRING_MAX],
            setting_id: 0,
            setting_type: 0,
            setting_location: 0,
            is_current_predefined: 0,
            is_predefined_valid: 0,
            predefined_value: [0; SETTING_VALUE_BYTES],
            current_value: [0; SETTING_VALUE_BYTES],
        })
    }
}

type InitializeFn = unsafe extern "C" fn() -> i32;
type DriverVersionFn = unsafe extern "C" fn(*mut u32, *mut u8) -> i32;
type CreateSessionFn = unsafe extern "C" fn(*mut Handle) -> i32;
type SessionFn = unsafe extern "C" fn(Handle) -> i32;
type SessionFileFn = unsafe extern "C" fn(Handle, *const u16) -> i32;
type GlobalProfileFn = unsafe extern "C" fn(Handle, *mut Handle) -> i32;
type FindProfileFn = unsafe extern "C" fn(Handle, *const u16, *mut Handle) -> i32;
type EnumProfilesFn = unsafe extern "C" fn(Handle, u32, *mut Handle) -> i32;
type ProfileInfoFn = unsafe extern "C" fn(Handle, Handle, *mut NvdrsProfile) -> i32;
type EnumApplicationsFn =
    unsafe extern "C" fn(Handle, Handle, u32, *mut u32, *mut NvdrsApplication) -> i32;
type GetSettingFn = unsafe extern "C" fn(Handle, Handle, u32, *mut NvdrsSetting) -> i32;
type SetSettingFn = unsafe extern "C" fn(Handle, Handle, *mut NvdrsSetting) -> i32;
type DeleteSettingFn = unsafe extern "C" fn(Handle, Handle, u32) -> i32;
/// The driver's own setting accessors take extra flag arguments, passed as zero.
type GetSettingExFn = unsafe extern "C" fn(Handle, Handle, u32, *mut NvdrsSetting, *mut u32) -> i32;
type SetSettingExFn = unsafe extern "C" fn(Handle, Handle, *mut NvdrsSetting, u32, u32) -> i32;

// Interface IDs from nvapi_interface.h.
const INITIALIZE: u32 = 0x0150_E828;
const SYS_GET_DRIVER_AND_BRANCH_VERSION: u32 = 0x2926_AAAD;
const DRS_CREATE_SESSION: u32 = 0x0694_D52E;
const DRS_DESTROY_SESSION: u32 = 0xDAD9_CFF8;
const DRS_LOAD_SETTINGS: u32 = 0x375D_BD6B;
const DRS_SAVE_SETTINGS: u32 = 0xFCBC_7E14;
const DRS_SAVE_SETTINGS_TO_FILE: u32 = 0x2BE2_5DF8;
const DRS_GET_CURRENT_GLOBAL_PROFILE: u32 = 0x617B_FF9F;
const DRS_FIND_PROFILE_BY_NAME: u32 = 0x7E4A_9A0B;
const DRS_ENUM_PROFILES: u32 = 0xBC37_1EE0;
const DRS_GET_PROFILE_INFO: u32 = 0x61CD_6FD6;
const DRS_ENUM_APPLICATIONS: u32 = 0x7FA2_173A;
const DRS_GET_SETTING: u32 = 0x73BF_8338;
const DRS_SET_SETTING: u32 = 0x577D_D202;
const DRS_DELETE_PROFILE_SETTING: u32 = 0xE4A2_6362;
const DRS_RESTORE_PROFILE_DEFAULT_SETTING: u32 = 0x53F0_381E;

// Since R445 the public accessors refuse some undocumented settings (NVAPI_SETTING_NOT_FOUND).
// NVIDIA Profile Inspector resolves the driver's own accessors first and falls back to the
// public ones (NvapiDrsWrapper.cs, "workaround for some settings throw errors when changed").
const DRS_GET_SETTING_EX: u32 = 0xEA99_498D;
const DRS_SET_SETTING_EX: u32 = 0x8A2C_F5F5;
const DRS_DELETE_PROFILE_SETTING_EX: u32 = 0xD20D_29DF;
const DRS_RESTORE_PROFILE_DEFAULT_SETTING_EX: u32 = 0x7DD5_B261;

#[derive(Clone, Copy)]
enum GetSetting {
    Driver(GetSettingExFn),
    Public(GetSettingFn),
}

#[derive(Clone, Copy)]
enum SetSetting {
    Driver(SetSettingExFn),
    Public(SetSettingFn),
}

/// The NVAPI functions the app calls, resolved once.
pub struct NvApi {
    initialize: InitializeFn,
    driver_version: DriverVersionFn,
    create_session: CreateSessionFn,
    destroy_session: SessionFn,
    load_settings: SessionFn,
    save_settings: SessionFn,
    save_settings_to_file: SessionFileFn,
    current_global_profile: GlobalProfileFn,
    find_profile_by_name: FindProfileFn,
    enum_profiles: EnumProfilesFn,
    profile_info: ProfileInfoFn,
    enum_applications: EnumApplicationsFn,
    get_setting: GetSetting,
    set_setting: SetSetting,
    delete_profile_setting: DeleteSettingFn,
    restore_profile_default_setting: DeleteSettingFn,
    /// Which setting accessors resolved, for the log.
    accessors: String,
}

/// # Safety
///
/// `query` must return null or a function with signature `F` for `id`.
unsafe fn resolve_optional<F: Copy>(query: QueryInterface, id: u32) -> Option<F> {
    const { assert!(size_of::<F>() == size_of::<*mut c_void>()) };
    // SAFETY: the caller passes NVAPI's resolver, which accepts any ID.
    let pointer = unsafe { query(id) };
    // SAFETY: as in `resolve_function`.
    (!pointer.is_null()).then(|| unsafe { std::mem::transmute_copy::<*mut c_void, F>(&pointer) })
}

/// # Safety
///
/// `query` must return null or a function with signature `F` for `id`.
unsafe fn resolve_function<F: Copy>(
    query: QueryInterface,
    id: u32,
    name: &'static str,
) -> DrsResult<F> {
    const { assert!(size_of::<F>() == size_of::<*mut c_void>()) };
    // SAFETY: the caller passes NVAPI's resolver, which accepts any ID.
    let pointer = unsafe { query(id) };
    if pointer.is_null() {
        return Err(DrsError::new(name, NVAPI_NO_IMPLEMENTATION));
    }
    // SAFETY: the pointer is non-null and, per the caller, a function of type `F`, which is a
    // function pointer of the same size.
    Ok(unsafe { std::mem::transmute_copy::<*mut c_void, F>(&pointer) })
}

impl NvApi {
    /// # Safety
    ///
    /// `query` must behave like `nvapi_QueryInterface`: every ID resolves to null or to the NVAPI
    /// function nvapi.h declares for it.
    pub unsafe fn resolve(query: QueryInterface) -> DrsResult<Self> {
        // SAFETY: NvAPI_Initialize takes no arguments and returns a status.
        let initialize = unsafe { resolve_function(query, INITIALIZE, "NvAPI_Initialize")? };
        // SAFETY: each ID is paired with the signature nvapi.h (or, for the driver's own
        // accessors, NVIDIA Profile Inspector) declares for it.
        let (get_setting, get_id) = match unsafe { resolve_optional(query, DRS_GET_SETTING_EX) } {
            Some(function) => (GetSetting::Driver(function), DRS_GET_SETTING_EX),
            None => (
                GetSetting::Public(unsafe {
                    resolve_function(query, DRS_GET_SETTING, "NvAPI_DRS_GetSetting")?
                }),
                DRS_GET_SETTING,
            ),
        };
        let (set_setting, set_id) = match unsafe { resolve_optional(query, DRS_SET_SETTING_EX) } {
            Some(function) => (SetSetting::Driver(function), DRS_SET_SETTING_EX),
            None => (
                SetSetting::Public(unsafe {
                    resolve_function(query, DRS_SET_SETTING, "NvAPI_DRS_SetSetting")?
                }),
                DRS_SET_SETTING,
            ),
        };
        let (delete_profile_setting, delete_id) =
            match unsafe { resolve_optional(query, DRS_DELETE_PROFILE_SETTING_EX) } {
                Some(function) => (function, DRS_DELETE_PROFILE_SETTING_EX),
                None => (
                    unsafe {
                        resolve_function(
                            query,
                            DRS_DELETE_PROFILE_SETTING,
                            "NvAPI_DRS_DeleteProfileSetting",
                        )?
                    },
                    DRS_DELETE_PROFILE_SETTING,
                ),
            };
        // SAFETY: as above; both IDs take a session, a profile, and a setting ID.
        let (restore_profile_default_setting, restore_id) =
            match unsafe { resolve_optional(query, DRS_RESTORE_PROFILE_DEFAULT_SETTING_EX) } {
                Some(function) => (function, DRS_RESTORE_PROFILE_DEFAULT_SETTING_EX),
                None => (
                    unsafe {
                        resolve_function(
                            query,
                            DRS_RESTORE_PROFILE_DEFAULT_SETTING,
                            "NvAPI_DRS_RestoreProfileDefaultSetting",
                        )?
                    },
                    DRS_RESTORE_PROFILE_DEFAULT_SETTING,
                ),
            };
        let accessors = format!(
            "get_setting={get_id:#010x} set_setting={set_id:#010x} delete_setting={delete_id:#010x} restore_setting={restore_id:#010x}"
        );
        // SAFETY: each ID is paired with the signature nvapi.h declares for it.
        unsafe {
            Ok(Self {
                initialize,
                driver_version: resolve_function(
                    query,
                    SYS_GET_DRIVER_AND_BRANCH_VERSION,
                    "NvAPI_SYS_GetDriverAndBranchVersion",
                )?,
                create_session: resolve_function(
                    query,
                    DRS_CREATE_SESSION,
                    "NvAPI_DRS_CreateSession",
                )?,
                destroy_session: resolve_function(
                    query,
                    DRS_DESTROY_SESSION,
                    "NvAPI_DRS_DestroySession",
                )?,
                load_settings: resolve_function(
                    query,
                    DRS_LOAD_SETTINGS,
                    "NvAPI_DRS_LoadSettings",
                )?,
                save_settings: resolve_function(
                    query,
                    DRS_SAVE_SETTINGS,
                    "NvAPI_DRS_SaveSettings",
                )?,
                save_settings_to_file: resolve_function(
                    query,
                    DRS_SAVE_SETTINGS_TO_FILE,
                    "NvAPI_DRS_SaveSettingsToFile",
                )?,
                current_global_profile: resolve_function(
                    query,
                    DRS_GET_CURRENT_GLOBAL_PROFILE,
                    "NvAPI_DRS_GetCurrentGlobalProfile",
                )?,
                find_profile_by_name: resolve_function(
                    query,
                    DRS_FIND_PROFILE_BY_NAME,
                    "NvAPI_DRS_FindProfileByName",
                )?,
                enum_profiles: resolve_function(
                    query,
                    DRS_ENUM_PROFILES,
                    "NvAPI_DRS_EnumProfiles",
                )?,
                profile_info: resolve_function(
                    query,
                    DRS_GET_PROFILE_INFO,
                    "NvAPI_DRS_GetProfileInfo",
                )?,
                enum_applications: resolve_function(
                    query,
                    DRS_ENUM_APPLICATIONS,
                    "NvAPI_DRS_EnumApplications",
                )?,
                get_setting,
                set_setting,
                delete_profile_setting,
                restore_profile_default_setting,
                accessors,
            })
        }
    }

    /// The interface IDs the setting accessors resolved to.
    pub fn accessors(&self) -> &str {
        &self.accessors
    }

    pub fn initialize(&self) -> DrsResult<()> {
        // SAFETY: NvAPI_Initialize takes no arguments.
        check("NvAPI_Initialize", unsafe { (self.initialize)() })
    }
}

fn check(function: &'static str, status: i32) -> DrsResult<()> {
    if status == NVAPI_OK {
        Ok(())
    } else {
        Err(DrsError::new(function, status))
    }
}

fn handle(profile: ProfileHandle) -> Handle {
    profile.0 as Handle
}

fn unicode(text: &str, function: &'static str) -> DrsResult<Box<UnicodeString>> {
    let mut buffer = Box::new([0_u16; UNICODE_STRING_MAX]);
    for (index, unit) in text.encode_utf16().enumerate() {
        // Keep the final unit for the terminating NUL; an inner NUL would cut the name short.
        if index + 1 == UNICODE_STRING_MAX || unit == 0 {
            return Err(DrsError::new(function, NVAPI_INVALID_ARGUMENT));
        }
        buffer[index] = unit;
    }
    Ok(buffer)
}

#[cfg(windows)]
fn unicode_path(path: &Path, function: &'static str) -> DrsResult<Box<UnicodeString>> {
    use std::os::windows::ffi::OsStrExt;

    let mut buffer = Box::new([0_u16; UNICODE_STRING_MAX]);
    for (index, unit) in path.as_os_str().encode_wide().enumerate() {
        if index + 1 == UNICODE_STRING_MAX || unit == 0 {
            return Err(DrsError::new(function, NVAPI_INVALID_ARGUMENT));
        }
        buffer[index] = unit;
    }
    Ok(buffer)
}

#[cfg(not(windows))]
fn unicode_path(path: &Path, function: &'static str) -> DrsResult<Box<UnicodeString>> {
    unicode(&path.to_string_lossy(), function)
}

fn text(units: &[u16]) -> String {
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

fn read_value(kind: u32, bytes: &[u8; SETTING_VALUE_BYTES]) -> Value {
    let dword = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    match kind {
        DWORD_TYPE => Value::Dword(dword),
        QWORD_TYPE => Value::Qword(u64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ])),
        // The length comes from the driver; a value past the buffer is cut at the buffer.
        BINARY_TYPE => Value::Binary(bytes[4..4 + (dword as usize).min(BINARY_DATA_MAX)].to_vec()),
        _ => Value::Text,
    }
}

fn write_value(value: &Value, bytes: &mut [u8; SETTING_VALUE_BYTES]) -> DrsResult<u32> {
    match value {
        Value::Dword(value) => {
            bytes[..4].copy_from_slice(&value.to_le_bytes());
            Ok(DWORD_TYPE)
        }
        Value::Qword(value) => {
            bytes[..8].copy_from_slice(&value.to_le_bytes());
            Ok(QWORD_TYPE)
        }
        Value::Binary(data) if data.len() <= BINARY_DATA_MAX => {
            bytes[..4].copy_from_slice(&(data.len() as u32).to_le_bytes());
            bytes[4..4 + data.len()].copy_from_slice(data);
            Ok(BINARY_TYPE)
        }
        Value::Binary(_) | Value::Text => Err(DrsError::new(
            "NvAPI_DRS_SetSetting",
            NVAPI_INVALID_ARGUMENT,
        )),
    }
}

fn read_setting(raw: &NvdrsSetting) -> Setting {
    Setting {
        location: match raw.setting_location {
            0 => Location::Profile,
            1 => Location::Global,
            2 => Location::Base,
            _ => Location::Default,
        },
        current_predefined: raw.is_current_predefined != 0,
        predefined: raw.is_predefined_valid != 0,
        value: read_value(raw.setting_type, &raw.current_value),
    }
}

/// DRS through a resolved NVAPI.
pub struct NvapiDriver<'a> {
    api: &'a NvApi,
}

impl<'a> NvapiDriver<'a> {
    pub fn new(api: &'a NvApi) -> Self {
        Self { api }
    }
}

impl DrsDriver for NvapiDriver<'_> {
    type Session<'s>
        = NvapiSession<'s>
    where
        Self: 's;

    fn driver_version(&self) -> DrsResult<u32> {
        let mut version = 0;
        let mut branch = [0_u8; SHORT_STRING_MAX];
        // SAFETY: both outputs are writable and the branch buffer is NvAPI_ShortString sized.
        let status = unsafe { (self.api.driver_version)(&mut version, branch.as_mut_ptr()) };
        check("NvAPI_SYS_GetDriverAndBranchVersion", status)?;
        Ok(version)
    }

    fn open(&self) -> DrsResult<NvapiSession<'_>> {
        let session = self.open_empty()?;
        // SAFETY: the session handle is live until the session drops.
        check("NvAPI_DRS_LoadSettings", unsafe {
            (self.api.load_settings)(session.handle)
        })?;
        Ok(session)
    }

    fn open_empty(&self) -> DrsResult<NvapiSession<'_>> {
        let mut session = ptr::null_mut();
        // SAFETY: the output handle is writable.
        check("NvAPI_DRS_CreateSession", unsafe {
            (self.api.create_session)(&mut session)
        })?;
        if session.is_null() {
            return Err(DrsError::new(
                "NvAPI_DRS_CreateSession",
                NVAPI_INVALID_ARGUMENT,
            ));
        }
        Ok(NvapiSession {
            api: self.api,
            handle: session,
        })
    }
}

pub struct NvapiSession<'a> {
    api: &'a NvApi,
    handle: Handle,
}

/// The last failed `NvAPI_DRS_DestroySession` status, for the next command to log.
static DESTROY_FAILURE: AtomicI32 = AtomicI32::new(NVAPI_OK);

/// Takes the status of a session that failed to close since the last call.
pub fn take_destroy_failure() -> Option<i32> {
    match DESTROY_FAILURE.swap(NVAPI_OK, Ordering::Relaxed) {
        NVAPI_OK => None,
        status => Some(status),
    }
}

impl Drop for NvapiSession<'_> {
    fn drop(&mut self) {
        // SAFETY: the handle came from NvAPI_DRS_CreateSession and is destroyed once.
        let status = unsafe { (self.api.destroy_session)(self.handle) };
        if status != NVAPI_OK {
            DESTROY_FAILURE.store(status, Ordering::Relaxed);
        }
    }
}

impl DrsSession for NvapiSession<'_> {
    fn profile(&mut self, index: u32) -> DrsResult<Option<ProfileHandle>> {
        let mut profile = ptr::null_mut();
        // SAFETY: the session is live and the output handle is writable.
        match unsafe { (self.api.enum_profiles)(self.handle, index, &mut profile) } {
            NVAPI_OK => Ok(Some(ProfileHandle(profile as usize))),
            NVAPI_END_ENUMERATION => Ok(None),
            status => Err(DrsError::new("NvAPI_DRS_EnumProfiles", status)),
        }
    }

    fn profile_info(&mut self, profile: ProfileHandle) -> DrsResult<ProfileInfo> {
        let mut info = NvdrsProfile::empty();
        // SAFETY: the session is live and the versioned output struct is writable.
        check("NvAPI_DRS_GetProfileInfo", unsafe {
            (self.api.profile_info)(self.handle, handle(profile), &mut *info)
        })?;
        Ok(ProfileInfo {
            name: text(&info.profile_name),
            predefined: info.is_predefined != 0,
            app_count: info.num_of_apps,
        })
    }

    fn applications(&mut self, profile: ProfileHandle, count: u32) -> DrsResult<Vec<String>> {
        if count == 0 {
            return Ok(Vec::new());
        }
        // Each entry is 20 KiB; a count past any real profile is a bad read, not an allocation.
        if count > MAX_APPLICATIONS {
            return Err(DrsError::new(
                "NvAPI_DRS_EnumApplications (count over 4096)",
                NVAPI_INVALID_ARGUMENT,
            ));
        }
        let mut applications = vec![NvdrsApplication::empty(); count as usize];
        let mut returned = count;
        // SAFETY: the array holds `count` versioned structs and `returned` says so.
        let status = unsafe {
            (self.api.enum_applications)(
                self.handle,
                handle(profile),
                0,
                &mut returned,
                applications.as_mut_ptr(),
            )
        };
        match status {
            NVAPI_OK => Ok(applications
                .iter()
                .take(returned.min(count) as usize)
                .map(|application| text(&application.app_name))
                .filter(|name| !name.is_empty())
                .collect()),
            NVAPI_END_ENUMERATION => Ok(Vec::new()),
            status => Err(DrsError::new("NvAPI_DRS_EnumApplications", status)),
        }
    }

    fn find_profile(&mut self, name: &str) -> DrsResult<Option<ProfileHandle>> {
        let name = unicode(name, "NvAPI_DRS_FindProfileByName")?;
        let mut profile = ptr::null_mut();
        // SAFETY: the name is a NUL-terminated NvAPI_UnicodeString and the output is writable.
        match unsafe { (self.api.find_profile_by_name)(self.handle, name.as_ptr(), &mut profile) } {
            NVAPI_OK => Ok(Some(ProfileHandle(profile as usize))),
            NVAPI_PROFILE_NOT_FOUND => Ok(None),
            status => Err(DrsError::new("NvAPI_DRS_FindProfileByName", status)),
        }
    }

    fn global_profile(&mut self) -> DrsResult<ProfileHandle> {
        let mut profile = ptr::null_mut();
        // SAFETY: the session is live and the output handle is writable.
        check("NvAPI_DRS_GetCurrentGlobalProfile", unsafe {
            (self.api.current_global_profile)(self.handle, &mut profile)
        })?;
        Ok(ProfileHandle(profile as usize))
    }

    fn setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<Option<Setting>> {
        let mut setting = NvdrsSetting::empty();
        // A binary value is returned only into a buffer whose length the caller states.
        let capacity = (BINARY_DATA_MAX as u32).to_le_bytes();
        setting.predefined_value[..4].copy_from_slice(&capacity);
        setting.current_value[..4].copy_from_slice(&capacity);
        let status = match self.api.get_setting {
            // SAFETY: the session is live, the versioned output struct and the flags are writable.
            GetSetting::Driver(function) => unsafe {
                let mut flags = 0_u32;
                function(self.handle, handle(profile), id, &mut *setting, &mut flags)
            },
            // SAFETY: the session is live and the versioned output struct is writable.
            GetSetting::Public(function) => unsafe {
                function(self.handle, handle(profile), id, &mut *setting)
            },
        };
        match status {
            NVAPI_OK => Ok(Some(read_setting(&setting))),
            NVAPI_SETTING_NOT_FOUND => Ok(None),
            status => Err(DrsError::new("NvAPI_DRS_GetSetting", status)),
        }
    }

    fn set_setting(&mut self, profile: ProfileHandle, id: u32, value: &Value) -> DrsResult<()> {
        let mut setting = NvdrsSetting::empty();
        setting.setting_id = id;
        setting.setting_type = write_value(value, &mut setting.current_value)?;
        let status = match self.api.set_setting {
            // SAFETY: the session is live and the versioned input struct is fully initialized.
            SetSetting::Driver(function) => unsafe {
                function(self.handle, handle(profile), &mut *setting, 0, 0)
            },
            // SAFETY: as above.
            SetSetting::Public(function) => unsafe {
                function(self.handle, handle(profile), &mut *setting)
            },
        };
        check("NvAPI_DRS_SetSetting", status)
    }

    fn delete_setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<bool> {
        // SAFETY: the session is live.
        match unsafe { (self.api.delete_profile_setting)(self.handle, handle(profile), id) } {
            NVAPI_OK => Ok(true),
            NVAPI_SETTING_NOT_FOUND => Ok(false),
            status => Err(DrsError::new("NvAPI_DRS_DeleteProfileSetting", status)),
        }
    }

    fn restore_setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<()> {
        // SAFETY: the session is live.
        let status =
            unsafe { (self.api.restore_profile_default_setting)(self.handle, handle(profile), id) };
        check("NvAPI_DRS_RestoreProfileDefaultSetting", status)
    }

    fn save(&mut self) -> DrsResult<()> {
        // SAFETY: the session is live.
        check("NvAPI_DRS_SaveSettings", unsafe {
            (self.api.save_settings)(self.handle)
        })
    }

    fn save_to_file(&mut self, path: &Path) -> DrsResult<()> {
        let path = unicode_path(path, "NvAPI_DRS_SaveSettingsToFile")?;
        // SAFETY: the session is live and the path is a NUL-terminated NvAPI_UnicodeString.
        check("NvAPI_DRS_SaveSettingsToFile", unsafe {
            (self.api.save_settings_to_file)(self.handle, path.as_ptr())
        })
    }
}

// Whole-profile calls the app does not make, for the on-PC repair test (`on_pc`). The driver's
// own EnumSettings comes first, as in NVIDIA Profile Inspector's NvapiDrsWrapper.cs.
#[cfg(all(test, windows, target_arch = "x86_64"))]
const DRS_ENUM_SETTINGS: u32 = 0xAE30_39DA;
#[cfg(all(test, windows, target_arch = "x86_64"))]
const DRS_ENUM_SETTINGS_EX: u32 = 0xCFD6_983E;
#[cfg(all(test, windows, target_arch = "x86_64"))]
type EnumSettingsFn = unsafe extern "C" fn(Handle, Handle, u32, *mut u32, *mut NvdrsSetting) -> i32;
#[cfg(all(test, windows, target_arch = "x86_64"))]
const DRS_LOAD_SETTINGS_FROM_FILE: u32 = 0xD3ED_E889;

#[cfg(all(test, windows, target_arch = "x86_64"))]
impl NvapiDriver<'_> {
    /// A session with the settings of a file saved by `NvAPI_DRS_SaveSettingsToFile`; saving
    /// it replaces the system settings with the file's.
    pub fn open_file(&self, path: &Path) -> DrsResult<NvapiSession<'_>> {
        let query = loaded_query()?;
        // SAFETY: nvapi.h declares this ID as taking a session and a NUL-terminated path.
        let load: SessionFileFn = unsafe {
            resolve_function(
                query,
                DRS_LOAD_SETTINGS_FROM_FILE,
                "NvAPI_DRS_LoadSettingsFromFile",
            )?
        };
        let session = self.open_empty()?;
        let path = unicode_path(path, "NvAPI_DRS_LoadSettingsFromFile")?;
        // SAFETY: the session is live and the path is a NUL-terminated NvAPI_UnicodeString.
        check("NvAPI_DRS_LoadSettingsFromFile", unsafe {
            load(session.handle, path.as_ptr())
        })?;
        Ok(session)
    }
}

/// `nvapi_QueryInterface` of the NVAPI `system_api` loaded.
#[cfg(all(test, windows, target_arch = "x86_64"))]
fn loaded_query() -> DrsResult<QueryInterface> {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    use super::drs::NVAPI_LIBRARY_NOT_FOUND;

    let library: Vec<u16> = "nvapi64.dll\0".encode_utf16().collect();
    // SAFETY: the name is NUL-terminated; the handle is not freed.
    let module = unsafe { GetModuleHandleW(library.as_ptr()) };
    if module.is_null() {
        return Err(DrsError::new(
            "GetModuleHandleW(nvapi64.dll)",
            NVAPI_LIBRARY_NOT_FOUND,
        ));
    }
    // SAFETY: the module is loaded and the export name is NUL-terminated.
    let query = unsafe { GetProcAddress(module, c"nvapi_QueryInterface".as_ptr().cast()) }.ok_or(
        DrsError::new("nvapi_QueryInterface", NVAPI_LIBRARY_NOT_FOUND),
    )?;
    // SAFETY: as in `system_api`.
    Ok(unsafe {
        std::mem::transmute::<unsafe extern "system" fn() -> isize, QueryInterface>(query)
    })
}

#[cfg(all(test, windows, target_arch = "x86_64"))]
impl NvapiSession<'_> {
    /// The settings in `profile` whose current value was written on this PC.
    pub fn values_written_here(
        &mut self,
        profile: ProfileHandle,
    ) -> DrsResult<Vec<(u32, Setting)>> {
        let query = loaded_query()?;
        // SAFETY: both IDs take a session, a profile, a start index, a count, and a settings array
        // (nvapi.h; Profile Inspector for the driver's own ID).
        let enum_settings: EnumSettingsFn =
            match unsafe { resolve_optional(query, DRS_ENUM_SETTINGS_EX) } {
                Some(function) => function,
                None => unsafe {
                    resolve_function(query, DRS_ENUM_SETTINGS, "NvAPI_DRS_EnumSettings")?
                },
            };
        let mut info = NvdrsProfile::empty();
        // SAFETY: the session is live and the versioned output struct is writable.
        check("NvAPI_DRS_GetProfileInfo", unsafe {
            (self.api.profile_info)(self.handle, handle(profile), &mut *info)
        })?;
        let count = info.num_of_settings.min(MAX_APPLICATIONS);
        if count == 0 {
            return Ok(Vec::new());
        }
        let capacity = (BINARY_DATA_MAX as u32).to_le_bytes();
        let mut settings: Vec<NvdrsSetting> = (0..count)
            .map(|_| {
                let mut setting = *NvdrsSetting::empty();
                setting.predefined_value[..4].copy_from_slice(&capacity);
                setting.current_value[..4].copy_from_slice(&capacity);
                setting
            })
            .collect();
        let mut returned = count;
        // SAFETY: the array holds `count` versioned structs and `returned` says so.
        let status = unsafe {
            enum_settings(
                self.handle,
                handle(profile),
                0,
                &mut returned,
                settings.as_mut_ptr(),
            )
        };
        match status {
            NVAPI_OK => Ok(settings
                .iter()
                .take(returned.min(count) as usize)
                .map(|raw| (raw.setting_id, read_setting(raw)))
                .filter(|(_, setting)| setting.user_set())
                .collect()),
            NVAPI_END_ENUMERATION => Ok(Vec::new()),
            status => Err(DrsError::new("NvAPI_DRS_EnumSettings", status)),
        }
    }
}

/// The NVAPI the installed NVIDIA driver provides, loaded and initialized once per process.
/// Only 64-bit Windows: the cast below relies on the x86-64 calling convention.
#[cfg(all(windows, target_arch = "x86_64"))]
pub fn system_api() -> DrsResult<&'static NvApi> {
    use std::sync::OnceLock;

    use windows_sys::Win32::System::LibraryLoader::{
        GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
    };

    use super::drs::NVAPI_LIBRARY_NOT_FOUND;

    // Only a working NVAPI is kept; a failure (no driver yet, a driver update in progress) is
    // retried on the next read.
    static API: OnceLock<NvApi> = OnceLock::new();
    if let Some(api) = API.get() {
        return Ok(api);
    }
    let library: Vec<u16> = "nvapi64.dll\0".encode_utf16().collect();
    // SAFETY: the name is NUL-terminated. The search covers only System32, where the driver
    // installs NVAPI. The library stays loaded for the life of the process.
    let module = unsafe {
        LoadLibraryExW(
            library.as_ptr(),
            ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    if module.is_null() {
        return Err(DrsError::new(
            "LoadLibraryExW(nvapi64.dll)",
            NVAPI_LIBRARY_NOT_FOUND,
        ));
    }
    // SAFETY: the module is loaded and the export name is NUL-terminated.
    let query = unsafe { GetProcAddress(module, c"nvapi_QueryInterface".as_ptr().cast()) }.ok_or(
        DrsError::new("nvapi_QueryInterface", NVAPI_LIBRARY_NOT_FOUND),
    )?;
    // SAFETY: nvapi_QueryInterface takes an interface ID and returns a function pointer; on
    // x86-64 the C and system calling conventions are the same.
    let query = unsafe {
        std::mem::transmute::<unsafe extern "system" fn() -> isize, QueryInterface>(query)
    };
    // SAFETY: `query` is NVAPI's own resolver.
    let api = unsafe { NvApi::resolve(query) }?;
    api.initialize()?;
    Ok(API.get_or_init(|| api))
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
pub fn system_api() -> DrsResult<&'static NvApi> {
    Err(DrsError::new(
        "nvapi64.dll",
        super::drs::NVAPI_LIBRARY_NOT_FOUND,
    ))
}

#[cfg(test)]
mod tests {
    //! NVAPI stand-ins over the in-memory database check that every value survives the trip
    //! through the C structs.

    use std::{cell::RefCell, collections::HashMap};

    use super::*;
    use crate::nvidia_profiles::{
        fake::{FakeDb, sample_db},
        policy::{APP_SETTING_ID, ENABLE_ID, SIZE_LIMIT_ID},
    };

    thread_local! {
        static SYSTEM: RefCell<FakeDb> = RefCell::new(sample_db());
        static SESSIONS: RefCell<HashMap<usize, FakeDb>> = RefCell::new(HashMap::new());
        static NEXT_SESSION: RefCell<usize> = const { RefCell::new(0x1000) };
    }

    fn with_session<T>(session: Handle, action: impl FnOnce(&mut FakeDb) -> T) -> T {
        SESSIONS.with(|sessions| {
            action(
                sessions
                    .borrow_mut()
                    .get_mut(&(session as usize))
                    .expect("live session"),
            )
        })
    }

    fn profile_index(profile: Handle) -> usize {
        profile as usize - 1
    }

    unsafe extern "C" fn initialize() -> i32 {
        NVAPI_OK
    }
    unsafe extern "C" fn driver_version(version: *mut u32, branch: *mut u8) -> i32 {
        // SAFETY: the caller passes writable outputs.
        unsafe {
            *version = 61_664;
            *branch = b'r';
        }
        NVAPI_OK
    }
    unsafe extern "C" fn create_session(session: *mut Handle) -> i32 {
        let id = NEXT_SESSION.with(|next| {
            let mut next = next.borrow_mut();
            *next += 1;
            *next
        });
        SESSIONS.with(|sessions| sessions.borrow_mut().insert(id, FakeDb::default()));
        // SAFETY: the caller passes a writable output.
        unsafe { *session = id as Handle };
        NVAPI_OK
    }
    unsafe extern "C" fn destroy_session(session: Handle) -> i32 {
        SESSIONS.with(|sessions| sessions.borrow_mut().remove(&(session as usize)));
        NVAPI_OK
    }
    unsafe extern "C" fn load_settings(session: Handle) -> i32 {
        let system = SYSTEM.with(|system| system.borrow().clone());
        with_session(session, |db| *db = system);
        NVAPI_OK
    }
    unsafe extern "C" fn save_settings(session: Handle) -> i32 {
        let db = with_session(session, |db| db.clone());
        SYSTEM.with(|system| *system.borrow_mut() = db);
        NVAPI_OK
    }
    unsafe extern "C" fn file_operation(_session: Handle, _path: *const u16) -> i32 {
        NVAPI_OK
    }
    unsafe extern "C" fn global_profile(session: Handle, profile: *mut Handle) -> i32 {
        let global = with_session(session, |db| db.global);
        // SAFETY: the caller passes a writable output.
        unsafe { *profile = (global + 1) as Handle };
        NVAPI_OK
    }
    unsafe extern "C" fn find_profile(
        session: Handle,
        name: *const u16,
        profile: *mut Handle,
    ) -> i32 {
        // SAFETY: the caller passes an NvAPI_UnicodeString.
        let name = text(unsafe { std::slice::from_raw_parts(name, UNICODE_STRING_MAX) });
        match with_session(session, |db| db.find(&name)) {
            Some(index) => {
                // SAFETY: the caller passes a writable output.
                unsafe { *profile = (index + 1) as Handle };
                NVAPI_OK
            }
            None => NVAPI_PROFILE_NOT_FOUND,
        }
    }
    unsafe extern "C" fn enum_profiles(session: Handle, index: u32, profile: *mut Handle) -> i32 {
        if index as usize >= with_session(session, |db| db.profiles.len()) {
            return NVAPI_END_ENUMERATION;
        }
        // SAFETY: the caller passes a writable output.
        unsafe { *profile = (index as usize + 1) as Handle };
        NVAPI_OK
    }
    unsafe extern "C" fn profile_info(
        session: Handle,
        profile: Handle,
        info: *mut NvdrsProfile,
    ) -> i32 {
        // SAFETY: the caller passes a versioned, writable struct.
        let info = unsafe { &mut *info };
        assert_eq!(info.version, 4116 | (1 << 16));
        with_session(session, |db| {
            let entry = &db.profiles[profile_index(profile)];
            for (slot, unit) in info.profile_name.iter_mut().zip(entry.name.encode_utf16()) {
                *slot = unit;
            }
            info.is_predefined = u32::from(entry.predefined);
            info.num_of_apps = entry.apps.len() as u32;
        });
        NVAPI_OK
    }
    unsafe extern "C" fn enum_applications(
        session: Handle,
        profile: Handle,
        start: u32,
        count: *mut u32,
        applications: *mut NvdrsApplication,
    ) -> i32 {
        // SAFETY: the caller passes `*count` writable, versioned structs.
        let capacity = unsafe { *count } as usize;
        let applications = unsafe { std::slice::from_raw_parts_mut(applications, capacity) };
        let apps = with_session(session, |db| {
            db.profiles[profile_index(profile)].apps.clone()
        });
        if start as usize >= apps.len() {
            return NVAPI_END_ENUMERATION;
        }
        let written = apps.len().min(capacity);
        for (application, name) in applications.iter_mut().zip(apps.iter()) {
            assert_eq!(application.version, 20492 | (4 << 16));
            for (slot, unit) in application.app_name.iter_mut().zip(name.encode_utf16()) {
                *slot = unit;
            }
        }
        // SAFETY: as above.
        unsafe { *count = written as u32 };
        NVAPI_OK
    }
    unsafe extern "C" fn get_setting(
        session: Handle,
        profile: Handle,
        id: u32,
        setting: *mut NvdrsSetting,
    ) -> i32 {
        // SAFETY: the caller passes a versioned, writable struct.
        let setting = unsafe { &mut *setting };
        assert_eq!(setting.version, 12320 | (1 << 16));
        let Some(found) = with_session(session, |db| db.setting(profile_index(profile), id)) else {
            return NVAPI_SETTING_NOT_FOUND;
        };
        setting.setting_id = id;
        setting.setting_location = match found.location {
            Location::Profile => 0,
            Location::Global => 1,
            Location::Base => 2,
            Location::Default => 3,
        };
        setting.is_current_predefined = u32::from(found.current_predefined);
        setting.is_predefined_valid = u32::from(found.predefined);
        setting.setting_type =
            write_value(&found.value, &mut setting.current_value).expect("storable value");
        NVAPI_OK
    }
    unsafe extern "C" fn set_setting(
        session: Handle,
        profile: Handle,
        setting: *mut NvdrsSetting,
    ) -> i32 {
        // SAFETY: the caller passes an initialized, versioned struct.
        let setting = unsafe { &*setting };
        assert_eq!(setting.version, 12320 | (1 << 16));
        assert_eq!(setting.setting_location, 0);
        let value = read_value(setting.setting_type, &setting.current_value);
        with_session(session, |db| {
            db.profiles[profile_index(profile)]
                .user
                .insert(setting.setting_id, value)
        });
        NVAPI_OK
    }
    unsafe extern "C" fn delete_setting(session: Handle, profile: Handle, id: u32) -> i32 {
        let removed = with_session(session, |db| {
            let profile = &mut db.profiles[profile_index(profile)];
            let user = profile.user.remove(&id).is_some();
            let nvidia = profile.nvidia.contains_key(&id) && !profile.removed_nvidia.contains(&id);
            if nvidia {
                profile.removed_nvidia.insert(id);
            }
            user || nvidia
        });
        if removed {
            NVAPI_OK
        } else {
            NVAPI_SETTING_NOT_FOUND
        }
    }
    unsafe extern "C" fn restore_setting(session: Handle, profile: Handle, id: u32) -> i32 {
        with_session(session, |db| {
            let profile = &mut db.profiles[profile_index(profile)];
            profile.user.remove(&id);
            profile.removed_nvidia.remove(&id);
        });
        NVAPI_OK
    }

    unsafe extern "C" fn get_setting_ex(
        session: Handle,
        profile: Handle,
        id: u32,
        setting: *mut NvdrsSetting,
        flags: *mut u32,
    ) -> i32 {
        // SAFETY: the caller passes writable flags.
        assert_eq!(unsafe { *flags }, 0);
        // SAFETY: forwarded unchanged.
        unsafe { get_setting(session, profile, id, setting) }
    }
    unsafe extern "C" fn set_setting_ex(
        session: Handle,
        profile: Handle,
        setting: *mut NvdrsSetting,
        first: u32,
        second: u32,
    ) -> i32 {
        assert_eq!((first, second), (0, 0));
        // SAFETY: forwarded unchanged.
        unsafe { set_setting(session, profile, setting) }
    }

    /// The driver's own accessors, as current drivers export them.
    unsafe extern "C" fn query(id: u32) -> *mut c_void {
        match id {
            DRS_GET_SETTING_EX => get_setting_ex as GetSettingExFn as *mut c_void,
            DRS_SET_SETTING_EX => set_setting_ex as SetSettingExFn as *mut c_void,
            DRS_DELETE_PROFILE_SETTING_EX => delete_setting as DeleteSettingFn as *mut c_void,
            DRS_RESTORE_PROFILE_DEFAULT_SETTING_EX => {
                restore_setting as DeleteSettingFn as *mut c_void
            }
            // SAFETY: the public table below answers every other ID.
            _ => unsafe { public_query(id) },
        }
    }

    /// Only the public accessors, as a driver without the driver's own ones would answer.
    unsafe extern "C" fn public_query(id: u32) -> *mut c_void {
        match id {
            INITIALIZE => initialize as InitializeFn as *mut c_void,
            SYS_GET_DRIVER_AND_BRANCH_VERSION => driver_version as DriverVersionFn as *mut c_void,
            DRS_CREATE_SESSION => create_session as CreateSessionFn as *mut c_void,
            DRS_DESTROY_SESSION => destroy_session as SessionFn as *mut c_void,
            DRS_LOAD_SETTINGS => load_settings as SessionFn as *mut c_void,
            DRS_SAVE_SETTINGS => save_settings as SessionFn as *mut c_void,
            DRS_SAVE_SETTINGS_TO_FILE => file_operation as SessionFileFn as *mut c_void,
            DRS_GET_CURRENT_GLOBAL_PROFILE => global_profile as GlobalProfileFn as *mut c_void,
            DRS_FIND_PROFILE_BY_NAME => find_profile as FindProfileFn as *mut c_void,
            DRS_ENUM_PROFILES => enum_profiles as EnumProfilesFn as *mut c_void,
            DRS_GET_PROFILE_INFO => profile_info as ProfileInfoFn as *mut c_void,
            DRS_ENUM_APPLICATIONS => enum_applications as EnumApplicationsFn as *mut c_void,
            DRS_GET_SETTING => get_setting as GetSettingFn as *mut c_void,
            DRS_SET_SETTING => set_setting as SetSettingFn as *mut c_void,
            DRS_DELETE_PROFILE_SETTING => delete_setting as DeleteSettingFn as *mut c_void,
            DRS_RESTORE_PROFILE_DEFAULT_SETTING => {
                restore_setting as DeleteSettingFn as *mut c_void
            }
            _ => ptr::null_mut(),
        }
    }

    fn api() -> NvApi {
        // SAFETY: `query` pairs every ID with a stand-in of the declared signature.
        unsafe { NvApi::resolve(query) }.expect("every function resolves")
    }

    #[test]
    fn the_drivers_own_accessors_come_first_and_the_public_ones_are_the_fallback() {
        assert_eq!(
            api().accessors(),
            "get_setting=0xea99498d set_setting=0x8a2cf5f5 delete_setting=0xd20d29df restore_setting=0x7dd5b261"
        );
        // SAFETY: `public_query` pairs every public ID with a stand-in of the declared signature.
        let public = unsafe { NvApi::resolve(public_query) }.expect("public functions resolve");
        assert_eq!(
            public.accessors(),
            "get_setting=0x73bf8338 set_setting=0x577dd202 delete_setting=0xe4a26362 restore_setting=0x53f0381e"
        );
        let driver = NvapiDriver::new(&public);
        let mut session = driver.open().unwrap();
        let game = session
            .find_profile("Elden Ring")
            .unwrap()
            .expect("sample profile");
        session
            .set_setting(game, ENABLE_ID, &Value::Dword(1))
            .unwrap();
        assert_eq!(
            session.setting(game, ENABLE_ID).unwrap().unwrap().value,
            Value::Dword(1)
        );
        assert!(session.delete_setting(game, ENABLE_ID).unwrap());
        assert!(!session.delete_setting(game, ENABLE_ID).unwrap());
    }

    #[test]
    fn values_survive_the_c_structs() {
        let api = api();
        api.initialize().unwrap();
        let driver = NvapiDriver::new(&api);
        assert_eq!(driver.driver_version().unwrap(), 61_664);
        let mut session = driver.open().unwrap();
        let game = session
            .find_profile("Cyberpunk 2077")
            .unwrap()
            .expect("sample profile");
        assert_eq!(session.profile_info(game).unwrap().name, "Cyberpunk 2077");
        assert_eq!(
            session.applications(game, 1).unwrap(),
            vec!["cyberpunk2077.exe"]
        );
        session
            .set_setting(game, APP_SETTING_ID, &Value::Dword(2))
            .unwrap();
        session
            .set_setting(game, SIZE_LIMIT_ID, &Value::Qword(1 << 30))
            .unwrap();
        session
            .set_setting(game, ENABLE_ID, &Value::Binary(vec![1, 2, 3]))
            .unwrap();
        let settings = session.rebar_settings(game).unwrap();
        assert_eq!(settings.app.unwrap().value, Value::Dword(2));
        assert_eq!(settings.size_limit.unwrap().value, Value::Qword(1 << 30));
        assert_eq!(settings.enable.unwrap().value, Value::Binary(vec![1, 2, 3]));
        assert!(session.delete_setting(game, ENABLE_ID).unwrap());
        assert_eq!(
            session.setting(game, ENABLE_ID).unwrap().unwrap().value,
            Value::Dword(0)
        );
        // Deleting again finds nothing to delete, which is not an error.
        assert!(!session.delete_setting(game, ENABLE_ID).unwrap());
        session.restore_setting(game, ENABLE_ID).unwrap();
        let restored = session.setting(game, ENABLE_ID).unwrap().unwrap();
        assert_eq!(restored.value, Value::Dword(1));
        assert!(restored.current_predefined);
        assert!(session.find_profile("Missing game").unwrap().is_none());
    }

    #[test]
    fn profiles_enumerate_until_the_end() {
        let api = api();
        let driver = NvapiDriver::new(&api);
        let mut session = driver.open().unwrap();
        let mut names = Vec::new();
        let mut index = 0;
        while let Some(profile) = session.profile(index).unwrap() {
            names.push(session.profile_info(profile).unwrap().name);
            index += 1;
        }
        assert_eq!(names.len(), sample_db().profiles.len());
        let global = session.global_profile().unwrap();
        assert_eq!(session.profile_info(global).unwrap().name, "Base Profile");
    }

    #[test]
    fn names_longer_than_the_driver_buffer_are_refused() {
        let long = "x".repeat(UNICODE_STRING_MAX);
        assert!(unicode(&long, "test").is_err());
        assert!(unicode(&long[..UNICODE_STRING_MAX - 1], "test").is_ok());
    }

    #[test]
    fn missing_functions_are_reported_by_name() {
        unsafe extern "C" fn nothing(_id: u32) -> *mut c_void {
            ptr::null_mut()
        }
        // SAFETY: a resolver that knows no function is allowed.
        let error = unsafe { NvApi::resolve(nothing) }
            .err()
            .expect("nothing resolves");
        assert_eq!(error.function, "NvAPI_Initialize");
        assert_eq!(error.status, NVAPI_NO_IMPLEMENTATION);
    }
}
