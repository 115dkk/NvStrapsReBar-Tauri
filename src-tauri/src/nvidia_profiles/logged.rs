//! A DRS driver wrapper that sends every failed call, and every call that changes the driver
//! settings, to the journal with its arguments. Reads that succeed stay out of the log; the
//! commands log the values they act on.

use std::path::Path;

use super::{
    drs::{DrsDriver, DrsResult, DrsSession, ProfileHandle, ProfileInfo},
    journal::Journal,
    policy::{Setting, Value},
};

pub struct LoggedDriver<'a, D> {
    inner: &'a D,
    journal: &'a Journal,
}

impl<'a, D: DrsDriver> LoggedDriver<'a, D> {
    pub fn new(inner: &'a D, journal: &'a Journal) -> Self {
        Self { inner, journal }
    }
}

fn failed<T>(
    journal: &Journal,
    call: &str,
    args: std::fmt::Arguments<'_>,
    result: DrsResult<T>,
) -> DrsResult<T> {
    if let Err(error) = &result {
        journal.error(call, format_args!("{args} -> {error}"));
    }
    result
}

fn changed<T>(
    journal: &Journal,
    call: &str,
    args: std::fmt::Arguments<'_>,
    result: DrsResult<T>,
) -> DrsResult<T> {
    match &result {
        Ok(_) => journal.info(call, format_args!("{args} -> ok")),
        Err(error) => journal.error(call, format_args!("{args} -> {error}")),
    }
    result
}

impl<D: DrsDriver> DrsDriver for LoggedDriver<'_, D> {
    type Session<'s>
        = LoggedSession<'s, D::Session<'s>>
    where
        Self: 's;

    fn driver_version(&self) -> DrsResult<u32> {
        failed(
            self.journal,
            "drs.driver_version",
            format_args!(""),
            self.inner.driver_version(),
        )
    }

    fn open(&self) -> DrsResult<Self::Session<'_>> {
        let inner = failed(
            self.journal,
            "drs.open",
            format_args!("load settings"),
            self.inner.open(),
        )?;
        Ok(LoggedSession {
            inner,
            journal: self.journal,
        })
    }

    fn open_empty(&self) -> DrsResult<Self::Session<'_>> {
        let inner = failed(
            self.journal,
            "drs.open",
            format_args!("empty"),
            self.inner.open_empty(),
        )?;
        Ok(LoggedSession {
            inner,
            journal: self.journal,
        })
    }
}

pub struct LoggedSession<'a, S> {
    inner: S,
    journal: &'a Journal,
}

impl<S: DrsSession> DrsSession for LoggedSession<'_, S> {
    fn profile(&mut self, index: u32) -> DrsResult<Option<ProfileHandle>> {
        failed(
            self.journal,
            "drs.enum_profiles",
            format_args!("index={index}"),
            self.inner.profile(index),
        )
    }

    fn profile_info(&mut self, profile: ProfileHandle) -> DrsResult<ProfileInfo> {
        failed(
            self.journal,
            "drs.profile_info",
            format_args!("profile={:#x}", profile.0),
            self.inner.profile_info(profile),
        )
    }

    fn applications(&mut self, profile: ProfileHandle, count: u32) -> DrsResult<Vec<String>> {
        failed(
            self.journal,
            "drs.enum_applications",
            format_args!("profile={:#x} count={count}", profile.0),
            self.inner.applications(profile, count),
        )
    }

    fn find_profile(&mut self, name: &str) -> DrsResult<Option<ProfileHandle>> {
        let result = failed(
            self.journal,
            "drs.find_profile",
            format_args!("name={name:?}"),
            self.inner.find_profile(name),
        );
        if let Ok(None) = &result {
            self.journal.warn(
                "drs.find_profile",
                format_args!("name={name:?} -> not found"),
            );
        }
        result
    }

    fn global_profile(&mut self) -> DrsResult<ProfileHandle> {
        failed(
            self.journal,
            "drs.global_profile",
            format_args!(""),
            self.inner.global_profile(),
        )
    }

    fn setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<Option<Setting>> {
        failed(
            self.journal,
            "drs.get_setting",
            format_args!("profile={:#x} id={id:#010x}", profile.0),
            self.inner.setting(profile, id),
        )
    }

    fn set_setting(&mut self, profile: ProfileHandle, id: u32, value: &Value) -> DrsResult<()> {
        changed(
            self.journal,
            "drs.set_setting",
            format_args!("profile={:#x} id={id:#010x} value={value:?}", profile.0),
            self.inner.set_setting(profile, id, value),
        )
    }

    fn delete_setting(&mut self, profile: ProfileHandle, id: u32) -> DrsResult<()> {
        changed(
            self.journal,
            "drs.delete_setting",
            format_args!("profile={:#x} id={id:#010x}", profile.0),
            self.inner.delete_setting(profile, id),
        )
    }

    fn save(&mut self) -> DrsResult<()> {
        changed(
            self.journal,
            "drs.save",
            format_args!(""),
            self.inner.save(),
        )
    }

    fn save_to_file(&mut self, path: &Path) -> DrsResult<()> {
        changed(
            self.journal,
            "drs.save_to_file",
            format_args!("path={}", path.display()),
            self.inner.save_to_file(path),
        )
    }

    fn load_from_file(&mut self, path: &Path) -> DrsResult<()> {
        changed(
            self.journal,
            "drs.load_from_file",
            format_args!("path={}", path.display()),
            self.inner.load_from_file(path),
        )
    }
}
