//! An in-memory driver settings database for tests. Values resolve the way the driver reports
//! them: the profile's own value, then the all-games profile, then the driver default.

use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

use super::{
    drs::{
        DrsDriver, DrsError, DrsResult, DrsSession, NVAPI_ERROR, NVAPI_INVALID_USER_PRIVILEGE,
        ProfileHandle, ProfileInfo,
    },
    policy::{APP_SETTING_ID, ENABLE_ID, Location, OPTIONS_ID, SIZE_LIMIT_ID, Setting, Value},
};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FakeProfile {
    pub name: String,
    pub predefined: bool,
    pub apps: Vec<String>,
    /// NVIDIA's predefined values.
    pub nvidia: BTreeMap<u32, Value>,
    /// Values written on this PC.
    pub user: BTreeMap<u32, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FakeDb {
    pub profiles: Vec<FakeProfile>,
    pub global: usize,
    pub defaults: BTreeMap<u32, Value>,
}

impl FakeDb {
    pub fn find(&self, name: &str) -> Option<usize> {
        self.profiles
            .iter()
            .position(|profile| profile.name.eq_ignore_ascii_case(name))
    }

    pub fn setting(&self, index: usize, id: u32) -> Option<Setting> {
        let profile = &self.profiles[index];
        let predefined = profile.nvidia.get(&id);
        if let Some(value) = profile.user.get(&id) {
            return Some(Setting {
                location: Location::Profile,
                current_predefined: false,
                predefined: predefined.is_some(),
                value: value.clone(),
            });
        }
        if let Some(value) = predefined {
            return Some(Setting {
                location: Location::Profile,
                current_predefined: true,
                predefined: true,
                value: value.clone(),
            });
        }
        let global = &self.profiles[self.global];
        let inherited = (index != self.global)
            .then(|| global.user.get(&id).or_else(|| global.nvidia.get(&id)))
            .flatten();
        if let Some(value) = inherited {
            return Some(Setting {
                location: Location::Global,
                current_predefined: false,
                predefined: false,
                value: value.clone(),
            });
        }
        self.defaults.get(&id).map(|value| Setting {
            location: Location::Default,
            current_predefined: false,
            predefined: false,
            value: value.clone(),
        })
    }
}

fn game(name: &str, apps: &[&str], nvidia: &[(u32, Value)]) -> FakeProfile {
    FakeProfile {
        name: name.into(),
        predefined: true,
        apps: apps.iter().map(|app| (*app).into()).collect(),
        nvidia: nvidia.iter().cloned().collect(),
        user: BTreeMap::new(),
    }
}

/// A global profile, a game NVIDIA turned on, two games it did not, and a profile without
/// programs.
pub fn sample_db() -> FakeDb {
    FakeDb {
        profiles: vec![
            game("Base Profile", &[], &[]),
            game(
                "Cyberpunk 2077",
                &["cyberpunk2077.exe"],
                &[
                    (ENABLE_ID, Value::Dword(1)),
                    (OPTIONS_ID, Value::Dword(0x41)),
                    (SIZE_LIMIT_ID, Value::Qword(0x6000_0000)),
                ],
            ),
            game(
                "Elden Ring",
                &["eldenring.exe", "start_protected_game.exe"],
                &[],
            ),
            game("Counter-Strike 2", &["cs2.exe"], &[]),
            game("Driver Telemetry", &[], &[]),
        ],
        global: 0,
        defaults: [
            (APP_SETTING_ID, Value::Dword(1)),
            (ENABLE_ID, Value::Dword(0)),
        ]
        .into_iter()
        .collect(),
    }
}

pub struct FakeDriver {
    pub system: RefCell<FakeDb>,
    pub version: u32,
    pub administrator: Cell<bool>,
    /// The driver accepts a save but keeps the old values.
    pub ignore_saves: Cell<bool>,
    /// Profiles whose information the driver refuses to return.
    pub broken: RefCell<Vec<String>>,
    /// The driver refuses every profile except the all-programs one.
    pub break_games: Cell<bool>,
    files: RefCell<HashMap<PathBuf, FakeDb>>,
}

impl FakeDriver {
    pub fn new(db: FakeDb, version: u32) -> Self {
        Self {
            system: RefCell::new(db),
            version,
            administrator: Cell::new(true),
            ignore_saves: Cell::new(false),
            broken: RefCell::new(Vec::new()),
            break_games: Cell::new(false),
            files: RefCell::new(HashMap::new()),
        }
    }
}

impl DrsDriver for FakeDriver {
    type Session<'a> = FakeSession<'a>;

    fn driver_version(&self) -> DrsResult<u32> {
        Ok(self.version)
    }

    fn open(&self) -> DrsResult<FakeSession<'_>> {
        Ok(FakeSession {
            driver: self,
            db: self.system.borrow().clone(),
        })
    }

    fn open_empty(&self) -> DrsResult<FakeSession<'_>> {
        Ok(FakeSession {
            driver: self,
            db: FakeDb::default(),
        })
    }
}

pub struct FakeSession<'a> {
    driver: &'a FakeDriver,
    db: FakeDb,
}

fn index(profile: ProfileHandle) -> usize {
    profile.0 - 1
}

impl DrsSession for FakeSession<'_> {
    fn profile(&mut self, index: u32) -> DrsResult<Option<ProfileHandle>> {
        Ok(
            ((index as usize) < self.db.profiles.len())
                .then_some(ProfileHandle(index as usize + 1)),
        )
    }

    fn profile_info(&mut self, profile: ProfileHandle) -> DrsResult<ProfileInfo> {
        let entry = &self.db.profiles[index(profile)];
        let refused = self.driver.broken.borrow().contains(&entry.name)
            || (self.driver.break_games.get() && index(profile) != self.db.global);
        if refused {
            return Err(DrsError::new("NvAPI_DRS_GetProfileInfo", NVAPI_ERROR));
        }
        Ok(ProfileInfo {
            name: entry.name.clone(),
            predefined: entry.predefined,
            app_count: entry.apps.len() as u32,
        })
    }

    fn applications(&mut self, profile: ProfileHandle, count: u32) -> DrsResult<Vec<String>> {
        Ok(self.db.profiles[index(profile)]
            .apps
            .iter()
            .take(count as usize)
            .cloned()
            .collect())
    }

    fn find_profile(&mut self, name: &str) -> DrsResult<Option<ProfileHandle>> {
        Ok(self.db.find(name).map(|index| ProfileHandle(index + 1)))
    }

    fn global_profile(&mut self) -> DrsResult<ProfileHandle> {
        Ok(ProfileHandle(self.db.global + 1))
    }

    fn setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<Option<Setting>> {
        Ok(self.db.setting(index(profile), id))
    }

    fn set_setting(&mut self, profile: ProfileHandle, id: u32, value: &Value) -> DrsResult<()> {
        self.db.profiles[index(profile)]
            .user
            .insert(id, value.clone());
        Ok(())
    }

    fn delete_setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<()> {
        self.db.profiles[index(profile)].user.remove(&id);
        Ok(())
    }

    fn save(&mut self) -> DrsResult<()> {
        if !self.driver.administrator.get() {
            return Err(DrsError::new(
                "NvAPI_DRS_SaveSettings",
                NVAPI_INVALID_USER_PRIVILEGE,
            ));
        }
        if !self.driver.ignore_saves.get() {
            *self.driver.system.borrow_mut() = self.db.clone();
        }
        Ok(())
    }

    fn save_to_file(&mut self, path: &Path) -> DrsResult<()> {
        fs::write(path, format!("{:?}", self.db))
            .map_err(|_| DrsError::new("NvAPI_DRS_SaveSettingsToFile", NVAPI_ERROR))?;
        self.driver
            .files
            .borrow_mut()
            .insert(path.to_path_buf(), self.db.clone());
        Ok(())
    }

    fn load_from_file(&mut self, path: &Path) -> DrsResult<()> {
        let saved = fs::read_to_string(path)
            .map_err(|_| DrsError::new("NvAPI_DRS_LoadSettingsFromFile", NVAPI_ERROR))?;
        let files = self.driver.files.borrow();
        let db = files
            .values()
            .find(|db| format!("{db:?}") == saved)
            .ok_or(DrsError::new("NvAPI_DRS_LoadSettingsFromFile", NVAPI_ERROR))?;
        self.db = db.clone();
        Ok(())
    }
}
