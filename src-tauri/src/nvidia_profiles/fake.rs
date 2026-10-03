//! An in-memory driver settings database for tests. Values resolve the way the driver reports
//! them: the profile's own value, then the all-games profile, then the driver default.

use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
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
    /// NVIDIA values removed by a delete.
    pub removed_nvidia: BTreeSet<u32>,
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
        let predefined = (!profile.removed_nvidia.contains(&id))
            .then(|| profile.nvidia.get(&id))
            .flatten();
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
        let inherited_nvidia = (!global.removed_nvidia.contains(&id))
            .then(|| global.nvidia.get(&id))
            .flatten();
        let inherited = (index != self.global)
            .then(|| global.user.get(&id).or(inherited_nvidia))
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
        removed_nvidia: BTreeSet::new(),
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

    fn delete_setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<bool> {
        let profile = &mut self.db.profiles[index(profile)];
        let user = profile.user.remove(&id).is_some();
        let nvidia = profile.nvidia.contains_key(&id) && !profile.removed_nvidia.contains(&id);
        if nvidia {
            profile.removed_nvidia.insert(id);
        }
        Ok(user || nvidia)
    }

    fn restore_setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<()> {
        let profile = &mut self.db.profiles[index(profile)];
        profile.user.remove(&id);
        profile.removed_nvidia.remove(&id);
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
            .map_err(|_| DrsError::new("NvAPI_DRS_SaveSettingsToFile", NVAPI_ERROR))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DRIVER: u32 = 61_664;

    #[test]
    fn delete_hides_nvidia_value_and_restore_brings_it_back() {
        let driver = FakeDriver::new(sample_db(), DRIVER);
        let mut session = driver.open().unwrap();
        let profile = session
            .find_profile("Cyberpunk 2077")
            .unwrap()
            .expect("sample profile");
        session
            .set_setting(profile, ENABLE_ID, &Value::Dword(0))
            .unwrap();

        assert!(session.delete_setting(profile, ENABLE_ID).unwrap());
        let deleted = session.setting(profile, ENABLE_ID).unwrap().unwrap();
        assert_eq!(deleted.location, Location::Default);
        assert_eq!(deleted.value, Value::Dword(0));
        assert!(!deleted.predefined);

        session.restore_setting(profile, ENABLE_ID).unwrap();
        let restored = session.setting(profile, ENABLE_ID).unwrap().unwrap();
        assert_eq!(restored.location, Location::Profile);
        assert_eq!(restored.value, Value::Dword(1));
        assert!(restored.current_predefined);
        assert!(restored.predefined);
    }
}
