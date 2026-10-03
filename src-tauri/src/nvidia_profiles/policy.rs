//! Resizable BAR values in the NVIDIA driver settings database (DRS): which values decide
//! whether a profile uses Resizable BAR, and which writes turn it on or off.
//!
//! The setting IDs are not in NVIDIA's public headers. They come from NVIDIA Profile Inspector's
//! `CustomSettingNames.xml` (MIT, Copyright (c) 2016 Orbmu2k); see THIRD_PARTY_NOTICES.md.

use serde::Serialize;

/// The NVIDIA app's per-program Resizable BAR setting (0 off, 1 auto, 2 on), driver 616.56+.
pub const APP_SETTING_ID: u32 = 0x000B_FA21;
/// "rBAR - Enable" (0 off, 1 on).
pub const ENABLE_ID: u32 = 0x000F_00BA;
/// "rBAR - Options" bitfield.
pub const OPTIONS_ID: u32 = 0x000F_00BB;
/// "rBAR - Size Limit" in bytes.
pub const SIZE_LIMIT_ID: u32 = 0x000F_00FF;
pub const REBAR_SETTING_IDS: [u32; 4] = [APP_SETTING_ID, ENABLE_ID, OPTIONS_ID, SIZE_LIMIT_ID];

/// Drivers are numbered as major * 100 + minor (616.56 is 61656).
pub const APP_SETTING_MIN_DRIVER: u32 = 61_656;
/// R610 changed the size limit to a QWORD setting.
pub const QWORD_SIZE_LIMIT_MIN_DRIVER: u32 = 61_000;

pub const APP_OFF: u32 = 0;
pub const APP_ON: u32 = 2;
pub const OPTIONS_ON: u32 = 1;
/// 1 GiB, the size NVIDIA uses for most games it turns on.
pub const SIZE_LIMIT_ON: u64 = 1 << 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Location {
    Profile,
    Global,
    Base,
    Default,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Dword(u32),
    Qword(u64),
    Binary(Vec<u8>),
    Text,
}

/// One setting as `NvAPI_DRS_GetSetting` reports it for a profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Setting {
    pub location: Location,
    /// The current value is NVIDIA's predefined value for this profile.
    pub current_predefined: bool,
    /// This profile carries a predefined NVIDIA value for the setting.
    pub predefined: bool,
    pub value: Value,
}

impl Setting {
    /// The value was written on this PC (by this app, NVIDIA's apps, or another tool).
    pub fn user_set(&self) -> bool {
        self.location == Location::Profile && !self.current_predefined
    }

    fn own(&self) -> bool {
        self.location == Location::Profile
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RebarSettings {
    pub app: Option<Setting>,
    pub enable: Option<Setting>,
    pub options: Option<Setting>,
    pub size_limit: Option<Setting>,
}

impl RebarSettings {
    pub fn get(&self, id: u32) -> Option<&Setting> {
        match id {
            APP_SETTING_ID => self.app.as_ref(),
            ENABLE_ID => self.enable.as_ref(),
            OPTIONS_ID => self.options.as_ref(),
            SIZE_LIMIT_ID => self.size_limit.as_ref(),
            _ => None,
        }
    }

    pub fn set(&mut self, id: u32, setting: Option<Setting>) {
        match id {
            APP_SETTING_ID => self.app = setting,
            ENABLE_ID => self.enable = setting,
            OPTIONS_ID => self.options = setting,
            SIZE_LIMIT_ID => self.size_limit = setting,
            _ => {}
        }
    }
}

/// Where the value that decides the state lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RebarSource {
    /// Written on this PC in this profile.
    ThisPc,
    /// NVIDIA's predefined value for this profile.
    Nvidia,
    /// Inherited from the profile that applies to all programs.
    AllGames,
    /// The driver's built-in default.
    Driver,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebarState {
    pub on: bool,
    pub source: RebarSource,
    /// The profile holds Resizable BAR values written on this PC.
    pub changed: bool,
}

/// Driver 616.56 and later read the NVIDIA app's per-program setting.
pub fn app_setting_supported(driver_version: u32) -> bool {
    driver_version >= APP_SETTING_MIN_DRIVER
}

pub fn rebar_state(settings: &RebarSettings, driver_version: u32) -> RebarState {
    let changed = REBAR_SETTING_IDS
        .iter()
        .filter_map(|id| settings.get(*id))
        .any(Setting::user_set);
    if app_setting_supported(driver_version)
        && let Some(app) = &settings.app
    {
        match decoded_dword(app, APP_SETTING_ID, &[0, 1, 2]) {
            Some(APP_ON) => return state(true, app, changed),
            Some(APP_OFF) => return state(false, app, changed),
            // Auto follows the values NVIDIA chose, read below.
            _ => {}
        }
    }
    match &settings.enable {
        Some(enable) => state(
            decoded_dword(enable, ENABLE_ID, &[0, 1]).is_some_and(|value| value != 0),
            enable,
            changed,
        ),
        None => RebarState {
            on: false,
            source: RebarSource::Driver,
            changed,
        },
    }
}

fn state(on: bool, setting: &Setting, changed: bool) -> RebarState {
    let source = match setting.location {
        Location::Profile if setting.current_predefined => RebarSource::Nvidia,
        Location::Profile => RebarSource::ThisPc,
        Location::Global | Location::Base => RebarSource::AllGames,
        Location::Default => RebarSource::Driver,
    };
    RebarState {
        on,
        source,
        changed,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Write {
    Set { id: u32, value: Value },
    Delete { id: u32 },
}

/// Turns Resizable BAR on in one profile. Options and the size limit are written only when the
/// profile has no value of its own, so NVIDIA's and the user's own choices stay.
pub fn turn_on(settings: &RebarSettings, driver_version: u32) -> Vec<Write> {
    let mut writes = Vec::new();
    if app_setting_supported(driver_version) {
        writes.push(set_dword(APP_SETTING_ID, APP_ON));
    }
    writes.push(set_dword(ENABLE_ID, 1));
    if !settings.options.as_ref().is_some_and(Setting::own) {
        writes.push(set_dword(OPTIONS_ID, OPTIONS_ON));
    }
    if !settings.size_limit.as_ref().is_some_and(Setting::own)
        && let Some(value) = size_limit_value(settings.size_limit.as_ref(), driver_version)
    {
        writes.push(Write::Set {
            id: SIZE_LIMIT_ID,
            value,
        });
    }
    writes
}

/// The size limit in the type the driver uses for it: a QWORD on R610 and later; before that,
/// the type of the value the profile inherits, or nothing when there is none.
fn size_limit_value(inherited: Option<&Setting>, driver_version: u32) -> Option<Value> {
    if driver_version >= QWORD_SIZE_LIMIT_MIN_DRIVER {
        return Some(Value::Qword(SIZE_LIMIT_ON));
    }
    match inherited.map(|setting| &setting.value) {
        Some(Value::Qword(_)) => Some(Value::Qword(SIZE_LIMIT_ON)),
        Some(Value::Binary(bytes)) if bytes.len() == 8 => {
            Some(Value::Binary(SIZE_LIMIT_ON.to_le_bytes().to_vec()))
        }
        Some(Value::Dword(_)) => Some(Value::Dword(SIZE_LIMIT_ON as u32)),
        Some(_) | None => None,
    }
}

/// Removes the on/off values written on this PC, and the options and size limit only when they
/// still hold the values `turn_on` writes.
pub fn clear(settings: &RebarSettings) -> Vec<Write> {
    let mut writes = Vec::new();
    for id in [APP_SETTING_ID, ENABLE_ID] {
        if settings.get(id).is_some_and(Setting::user_set) {
            writes.push(Write::Delete { id });
        }
    }
    if settings
        .options
        .as_ref()
        .is_some_and(|setting| setting.user_set() && setting.value == Value::Dword(OPTIONS_ON))
    {
        writes.push(Write::Delete { id: OPTIONS_ID });
    }
    if settings
        .size_limit
        .as_ref()
        .is_some_and(|setting| setting.user_set() && is_size_limit_on(&setting.value))
    {
        writes.push(Write::Delete { id: SIZE_LIMIT_ID });
    }
    writes
}

fn is_size_limit_on(value: &Value) -> bool {
    match value {
        Value::Qword(bytes) => *bytes == SIZE_LIMIT_ON,
        Value::Dword(bytes) => u64::from(*bytes) == SIZE_LIMIT_ON,
        Value::Binary(bytes) => bytes.as_slice() == SIZE_LIMIT_ON.to_le_bytes(),
        Value::Text => false,
    }
}

/// After `clear`, a profile that still resolves to on (NVIDIA's value or the all-games value)
/// gets explicit off values.
pub fn force_off(cleared: &RebarSettings, driver_version: u32) -> Vec<Write> {
    if !rebar_state(cleared, driver_version).on {
        return Vec::new();
    }
    let mut writes = Vec::new();
    if app_setting_supported(driver_version) {
        writes.push(set_dword(APP_SETTING_ID, APP_OFF));
    }
    writes.push(set_dword(ENABLE_ID, 0));
    writes
}

fn set_dword(id: u32, value: u32) -> Write {
    Write::Set {
        id,
        value: Value::Dword(value),
    }
}

/// NVIDIA stores some predefined values XOR-masked with a fixed table, keyed by setting ID.
/// The table is the one NVIDIA Profile Inspector uses to read them (DrsDecrypterService.cs).
/// A plain value is taken as is; a masked one is unmasked only when that gives an allowed value.
fn decoded_dword(setting: &Setting, id: u32, allowed: &[u32]) -> Option<u32> {
    let Value::Dword(raw) = setting.value else {
        return None;
    };
    if allowed.contains(&raw) || !setting.current_predefined {
        return Some(raw);
    }
    let unmasked = raw ^ predefined_mask(id);
    allowed.contains(&unmasked).then_some(unmasked)
}

fn predefined_mask(id: u32) -> u32 {
    let offset = id.wrapping_shl(1) as usize;
    u32::from_le_bytes(std::array::from_fn(|index| {
        PREDEFINED_VALUE_MASK[(offset + index) % PREDEFINED_VALUE_MASK.len()]
    }))
}

const PREDEFINED_VALUE_MASK: [u8; 256] = [
    0x2f, 0x7c, 0x4f, 0x8b, 0x20, 0x24, 0x52, 0x8d, 0x26, 0x3c, 0x94, 0x77, 0xf3, 0x7c, 0x98, 0xa5,
    0xfa, 0x71, 0xb6, 0x80, 0xdd, 0x35, 0x84, 0xba, 0xfd, 0xb6, 0xa6, 0x1b, 0x39, 0xc4, 0xcc, 0xb0,
    0x7e, 0x95, 0xd9, 0xee, 0x18, 0x4b, 0x9c, 0xf5, 0x2d, 0x4e, 0xd0, 0xc1, 0x55, 0x17, 0xdf, 0x18,
    0x1e, 0x0b, 0x18, 0x8b, 0x88, 0x58, 0x86, 0x5a, 0x1e, 0x03, 0xed, 0x56, 0xfb, 0x16, 0xfe, 0x8a,
    0x01, 0x32, 0x9c, 0x8d, 0xf2, 0xe8, 0x4a, 0xe6, 0x90, 0x8e, 0x15, 0x68, 0xe8, 0x2d, 0xf4, 0x40,
    0x37, 0x9a, 0x72, 0xc7, 0x02, 0x0c, 0xd1, 0xd3, 0x58, 0xea, 0x62, 0xd1, 0x98, 0x36, 0x2b, 0xb2,
    0x16, 0xd5, 0xde, 0x93, 0xf1, 0xba, 0x74, 0xe3, 0x32, 0xc4, 0x9f, 0xf6, 0x12, 0xfe, 0x18, 0xc0,
    0xbb, 0x35, 0x79, 0x9c, 0x6b, 0x7a, 0x23, 0x7f, 0x2b, 0x15, 0x9b, 0x42, 0x07, 0x1a, 0xff, 0x69,
    0xfb, 0x9c, 0xbd, 0x23, 0x97, 0xa8, 0x22, 0x63, 0x8f, 0x32, 0xc8, 0xe9, 0x9b, 0x63, 0x1c, 0xee,
    0x2c, 0xd9, 0xed, 0x8d, 0x3a, 0x35, 0x9c, 0xb1, 0x60, 0xae, 0x5e, 0xf5, 0x97, 0x6b, 0x9f, 0x20,
    0x8c, 0xf7, 0x98, 0x2c, 0x43, 0x79, 0x95, 0x1d, 0xcd, 0x46, 0x36, 0x6c, 0xd9, 0x67, 0x20, 0xab,
    0x41, 0x22, 0x21, 0xe5, 0x55, 0x82, 0xf5, 0x27, 0x20, 0xf5, 0x08, 0x07, 0x3f, 0x6d, 0x69, 0xd9,
    0x1c, 0x4b, 0xf8, 0x26, 0x03, 0x6e, 0xb2, 0x3f, 0x1e, 0xe6, 0xca, 0x3d, 0x61, 0x44, 0xb0, 0x92,
    0xaf, 0xf0, 0x88, 0xca, 0xe0, 0x5f, 0x5d, 0xf4, 0xdf, 0xc6, 0x4c, 0xa4, 0xe0, 0xca, 0xb0, 0x20,
    0x5d, 0xc0, 0xfa, 0xdd, 0x9a, 0x34, 0x8f, 0x50, 0x79, 0x5a, 0x5f, 0x7c, 0x19, 0x9e, 0x40, 0x70,
    0x71, 0xb5, 0x45, 0x19, 0xb8, 0x53, 0xfc, 0xdf, 0x24, 0xbe, 0x22, 0x1c, 0x79, 0xbf, 0x42, 0x89,
];

#[cfg(test)]
mod tests {
    use super::*;

    const DRIVER: u32 = 61_664;
    const OLD_DRIVER: u32 = 56_694;

    fn user(value: Value) -> Setting {
        Setting {
            location: Location::Profile,
            current_predefined: false,
            predefined: false,
            value,
        }
    }

    fn nvidia(value: Value) -> Setting {
        Setting {
            location: Location::Profile,
            current_predefined: true,
            predefined: true,
            value,
        }
    }

    fn inherited(location: Location, value: Value) -> Setting {
        Setting {
            location,
            current_predefined: false,
            predefined: false,
            value,
        }
    }

    fn apply(settings: &RebarSettings, writes: &[Write]) -> RebarSettings {
        let mut next = settings.clone();
        for write in writes {
            match write {
                Write::Set { id, value } => next.set(*id, Some(user(value.clone()))),
                Write::Delete { id } => next.set(*id, None),
            }
        }
        next
    }

    #[test]
    fn nothing_set_is_off_by_driver_default() {
        let state = rebar_state(&RebarSettings::default(), DRIVER);
        assert_eq!(
            state,
            RebarState {
                on: false,
                source: RebarSource::Driver,
                changed: false
            }
        );
    }

    #[test]
    fn nvidia_enable_counts_while_the_app_setting_is_auto() {
        let settings = RebarSettings {
            app: Some(inherited(Location::Default, Value::Dword(1))),
            enable: Some(nvidia(Value::Dword(1))),
            ..Default::default()
        };
        let state = rebar_state(&settings, DRIVER);
        assert!(state.on);
        assert_eq!(state.source, RebarSource::Nvidia);
        assert!(!state.changed);
    }

    #[test]
    fn the_app_setting_decides_on_new_drivers_only() {
        let settings = RebarSettings {
            app: Some(user(Value::Dword(APP_OFF))),
            enable: Some(nvidia(Value::Dword(1))),
            ..Default::default()
        };
        assert!(!rebar_state(&settings, DRIVER).on);
        assert!(rebar_state(&settings, OLD_DRIVER).on);
    }

    #[test]
    fn inherited_all_games_values_report_their_source() {
        let settings = RebarSettings {
            enable: Some(inherited(Location::Global, Value::Dword(1))),
            ..Default::default()
        };
        let state = rebar_state(&settings, OLD_DRIVER);
        assert!(state.on);
        assert_eq!(state.source, RebarSource::AllGames);
    }

    #[test]
    fn masked_predefined_values_are_unmasked() {
        let masked = 1 ^ predefined_mask(ENABLE_ID);
        let settings = RebarSettings {
            enable: Some(nvidia(Value::Dword(masked))),
            ..Default::default()
        };
        assert!(rebar_state(&settings, OLD_DRIVER).on);
        let off = RebarSettings {
            enable: Some(nvidia(Value::Dword(predefined_mask(ENABLE_ID)))),
            ..Default::default()
        };
        assert!(!rebar_state(&off, OLD_DRIVER).on);
    }

    #[test]
    fn turning_on_writes_every_value_on_a_new_driver() {
        let writes = turn_on(&RebarSettings::default(), DRIVER);
        assert_eq!(
            writes,
            vec![
                set_dword(APP_SETTING_ID, APP_ON),
                set_dword(ENABLE_ID, 1),
                set_dword(OPTIONS_ID, OPTIONS_ON),
                Write::Set {
                    id: SIZE_LIMIT_ID,
                    value: Value::Qword(SIZE_LIMIT_ON)
                },
            ]
        );
        let state = rebar_state(&apply(&RebarSettings::default(), &writes), DRIVER);
        assert!(state.on && state.changed);
        assert_eq!(state.source, RebarSource::ThisPc);
    }

    #[test]
    fn turning_on_keeps_the_profiles_own_options_and_size() {
        let settings = RebarSettings {
            options: Some(nvidia(Value::Dword(0x41))),
            size_limit: Some(user(Value::Qword(4 << 30))),
            ..Default::default()
        };
        let writes = turn_on(&settings, DRIVER);
        assert_eq!(
            writes,
            vec![set_dword(APP_SETTING_ID, APP_ON), set_dword(ENABLE_ID, 1)]
        );
    }

    #[test]
    fn the_size_limit_uses_the_type_the_driver_reports() {
        let binary = RebarSettings {
            size_limit: Some(inherited(Location::Default, Value::Binary(vec![0; 8]))),
            ..Default::default()
        };
        assert!(turn_on(&binary, OLD_DRIVER).contains(&Write::Set {
            id: SIZE_LIMIT_ID,
            value: Value::Binary(SIZE_LIMIT_ON.to_le_bytes().to_vec())
        }));
        // R610 and later always take a QWORD, whatever an older tool left behind.
        assert!(turn_on(&binary, DRIVER).contains(&Write::Set {
            id: SIZE_LIMIT_ID,
            value: Value::Qword(SIZE_LIMIT_ON)
        }));
        // An old driver without a known type gets no size limit, and no app setting.
        let writes = turn_on(&RebarSettings::default(), OLD_DRIVER);
        assert_eq!(
            writes,
            vec![set_dword(ENABLE_ID, 1), set_dword(OPTIONS_ID, OPTIONS_ON)]
        );
    }

    #[test]
    fn turning_off_a_game_turned_on_here_removes_what_was_written() {
        let on = apply(
            &RebarSettings::default(),
            &turn_on(&RebarSettings::default(), DRIVER),
        );
        let cleared = apply(&on, &clear(&on));
        assert_eq!(cleared, RebarSettings::default());
        assert!(force_off(&cleared, DRIVER).is_empty());
        assert!(!rebar_state(&cleared, DRIVER).changed);
    }

    #[test]
    fn turning_off_keeps_options_and_sizes_chosen_elsewhere() {
        let settings = RebarSettings {
            enable: Some(user(Value::Dword(1))),
            options: Some(user(Value::Dword(0x41))),
            size_limit: Some(user(Value::Qword(4 << 30))),
            ..Default::default()
        };
        assert_eq!(clear(&settings), vec![Write::Delete { id: ENABLE_ID }]);
    }

    #[test]
    fn turning_off_a_game_nvidia_turned_on_writes_explicit_off() {
        let settings = RebarSettings {
            app: Some(inherited(Location::Default, Value::Dword(1))),
            enable: Some(nvidia(Value::Dword(1))),
            ..Default::default()
        };
        let cleared = apply(&settings, &clear(&settings));
        let writes = force_off(&cleared, DRIVER);
        assert_eq!(
            writes,
            vec![set_dword(APP_SETTING_ID, APP_OFF), set_dword(ENABLE_ID, 0)]
        );
        let off = apply(&cleared, &writes);
        let state = rebar_state(&off, DRIVER);
        assert!(!state.on && state.changed);
    }

    #[test]
    fn turning_off_under_an_all_games_on_writes_explicit_off() {
        let settings = RebarSettings {
            app: Some(inherited(Location::Global, Value::Dword(APP_ON))),
            enable: Some(inherited(Location::Global, Value::Dword(1))),
            ..Default::default()
        };
        assert!(clear(&settings).is_empty());
        assert_eq!(force_off(&settings, DRIVER).len(), 2);
    }
}
