//! The handoff checks (docs/NVIDIA_DRIVER_SETTINGS_HANDOFF.md) against the installed NVIDIA
//! driver. The tests are ignored: they need a Windows PC with an NVIDIA driver, and the ones that
//! change driver profiles also need administrator rights and `NVSTRAPS_DRIVER_WRITE=1`.
//!
//! `NVSTRAPS_RESTORE_PROFILE` names a profile whose NVIDIA values a delete removed; the restore
//! test brings back NVIDIA's value for each Resizable BAR setting that holds no value written on
//! this PC.
//!
//! `NVSTRAPS_APP_DATA` names the app's local data folder
//! (`%LOCALAPPDATA%\io.github.nvstrapsrebar.desktop`), so the backup, the undo record, and the
//! log land where the games screen reads them. `NVSTRAPS_OFF_GAME` and `NVSTRAPS_NVIDIA_GAME`
//! pick the profiles to switch; without them the test takes the first game that is off by
//! default and the first game NVIDIA turned on.
//!
//! Each write is followed by a read in an independent session, printed with `describe_settings`.
//! The write test ends with the undo and fails unless every profile it touched reads exactly as
//! it did before the test.

use std::{
    collections::BTreeMap,
    env,
    panic::{self, AssertUnwindSafe},
    path::PathBuf,
    time::Instant,
};

use super::{
    GameSettingsCatalog, Journal, Paths, RebarSource, Store, Target, change, describe_settings,
    describe_state,
    drs::{DrsDriver, DrsSession},
    load_catalog,
    nvapi::{self, NvapiDriver, NvapiSession},
    policy::{
        APP_ON, APP_SETTING_ID, ENABLE_ID, OPTIONS_ID, OPTIONS_ON, REBAR_SETTING_IDS,
        RebarSettings, SIZE_LIMIT_ID, SIZE_LIMIT_ON, Value,
    },
    undo, with_driver,
};
use crate::{error::BackendResult, firmware::inspect_access};

fn paths() -> Paths {
    let root = PathBuf::from(
        env::var_os("NVSTRAPS_APP_DATA").expect("NVSTRAPS_APP_DATA names the app data folder"),
    );
    Paths {
        store: Store::under(&root.join("nvidia-driver-settings")),
        log: root.join("logs").join("driver-settings.log"),
    }
}

fn catalog(paths: &Paths, journal: &Journal) -> GameSettingsCatalog {
    let started = Instant::now();
    let catalog = with_driver(journal, |driver| {
        load_catalog(driver, &paths.store, journal)
    })
    .expect("the driver lists its profiles");
    println!(
        "catalog: driver {} app_setting={} games={} skipped={} ms={}",
        catalog.driver.version,
        catalog.driver.app_setting,
        catalog.games.len(),
        catalog.skipped_profiles,
        started.elapsed().as_millis()
    );
    catalog
}

/// A profile's four values in a session of its own, outside the command code.
fn read(name: Option<&str>) -> RebarSettings {
    let api = nvapi::system_api().expect("NVAPI loads");
    let driver = NvapiDriver::new(api);
    let mut session = driver.open().expect("a driver session opens");
    let profile = match name {
        Some(name) => session
            .find_profile(name)
            .expect("the profile lookup answers")
            .expect("the profile exists"),
        None => session.global_profile().expect("the global profile"),
    };
    session.rebar_settings(profile).expect("the values read")
}

fn show(step: &str, name: Option<&str>) -> RebarSettings {
    let settings = read(name);
    println!(
        "{step}: {} {}",
        name.unwrap_or("<all programs>"),
        describe_settings(&settings)
    );
    settings
}

fn own_value(settings: &RebarSettings, id: u32) -> Option<&Value> {
    settings
        .get(id)
        .filter(|setting| setting.user_set())
        .map(|setting| &setting.value)
}

/// The handoff's table of values for a profile that had none of its own.
fn assert_turned_on(before: &RebarSettings, after: &RebarSettings) {
    assert_eq!(
        own_value(after, APP_SETTING_ID),
        Some(&Value::Dword(APP_ON))
    );
    assert_eq!(own_value(after, ENABLE_ID), Some(&Value::Dword(1)));
    if own_value(before, OPTIONS_ID).is_none() {
        assert_eq!(
            own_value(after, OPTIONS_ID),
            Some(&Value::Dword(OPTIONS_ON))
        );
    }
    if own_value(before, SIZE_LIMIT_ID).is_none() {
        assert_eq!(
            own_value(after, SIZE_LIMIT_ID),
            Some(&Value::Qword(SIZE_LIMIT_ON))
        );
    }
}

fn switch(paths: &Paths, journal: &Journal, target: Target<'_>, on: bool) -> BackendResult<()> {
    let started = Instant::now();
    let receipt = with_driver(journal, |driver| {
        change(driver, target, on, &paths.store, journal)
    })?;
    println!(
        "switch {target} on={on}: {} ms={}",
        describe_state(&receipt.state),
        started.elapsed().as_millis()
    );
    Ok(())
}

#[test]
#[ignore = "changes NVIDIA driver profiles; needs administrator rights and NVSTRAPS_DRIVER_WRITE=1"]
fn the_installed_driver_gives_nvidia_values_back() {
    assert_eq!(
        env::var("NVSTRAPS_DRIVER_WRITE").as_deref(),
        Ok("1"),
        "set NVSTRAPS_DRIVER_WRITE=1 to change driver profiles"
    );
    assert!(inspect_access().is_elevated, "run elevated");
    let name =
        env::var("NVSTRAPS_RESTORE_PROFILE").expect("NVSTRAPS_RESTORE_PROFILE names a profile");
    let paths = paths();
    let journal = Journal::file(paths.log.clone());
    show("before", Some(&name));
    with_driver(&journal, |driver| {
        let mut session = driver.open()?;
        let profile = session.find_profile(&name)?.expect("the profile exists");
        let settings = session.rebar_settings(profile)?;
        for id in [APP_SETTING_ID, ENABLE_ID, OPTIONS_ID, SIZE_LIMIT_ID] {
            if settings.get(id).is_some_and(|setting| setting.user_set()) {
                continue;
            }
            println!(
                "restore {id:#010x}: {:?}",
                session.restore_setting(profile, id)
            );
        }
        session.save()?;
        Ok(())
    })
    .expect("the restore saves");
    let after = show("after", Some(&name));
    for id in [APP_SETTING_ID, ENABLE_ID, OPTIONS_ID, SIZE_LIMIT_ID] {
        assert!(
            !after.get(id).is_some_and(|setting| setting.user_set()),
            "{id:#010x} holds a value written on this PC"
        );
    }
}

/// Profiles by name: the Resizable BAR values and the other values written on this PC.
type Profiles = BTreeMap<String, (RebarSettings, Vec<(u32, Value)>)>;

/// Every profile in the session.
fn profiles(session: &mut NvapiSession<'_>) -> Profiles {
    let mut profiles = BTreeMap::new();
    for index in 0.. {
        let Some(profile) = session.profile(index).expect("the profile list answers") else {
            break;
        };
        let name = session
            .profile_info(profile)
            .expect("the profile reads")
            .name;
        let rebar = session.rebar_settings(profile).expect("the values read");
        let others = session
            .values_written_here(profile)
            .expect("the profile's settings read")
            .into_iter()
            .filter(|(id, _)| !REBAR_SETTING_IDS.contains(id))
            .map(|(id, setting)| (id, setting.value))
            .collect();
        profiles.insert(name, (rebar, others));
    }
    profiles
}

/// Profiles whose Resizable BAR values differ, and profiles that differ in anything else.
fn differences(left: &Profiles, right: &Profiles) -> (Vec<String>, Vec<String>) {
    let (mut rebar, mut others) = (Vec::new(), Vec::new());
    for name in left
        .keys()
        .chain(right.keys().filter(|name| !left.contains_key(*name)))
    {
        match (left.get(name), right.get(name)) {
            (Some((left_rebar, left_others)), Some((right_rebar, right_others))) => {
                if left_rebar != right_rebar {
                    rebar.push(format!(
                        "{name:?}: {} -> {}",
                        describe_settings(left_rebar),
                        describe_settings(right_rebar)
                    ));
                }
                if left_others != right_others {
                    others.push(format!("{name:?}: {left_others:?} -> {right_others:?}"));
                }
            }
            (Some(_), None) => others.push(format!("{name:?} only in the system settings")),
            (None, _) => others.push(format!("{name:?} only in the copy")),
        }
    }
    (rebar, others)
}

/// Compares the full copy saved before the app's first change with the system settings. With
/// `NVSTRAPS_LOAD_BACKUP=1`, elevated, the same driver version, and no difference outside the
/// Resizable BAR values, it saves the copy as the system settings, which brings back NVIDIA values
/// a delete removed; neither `RestoreProfileDefaultSetting` nor `RestoreProfileDefault` does.
#[test]
#[ignore = "needs a Windows PC with an NVIDIA driver; loading the copy needs administrator rights"]
fn the_installed_driver_compares_the_backup() {
    let paths = paths();
    let journal = Journal::file(paths.log.clone());
    let backup = super::read_backup(&paths.store.backups, &journal)
        .expect("the backups read")
        .expect("a backup exists");
    let api = nvapi::system_api().expect("NVAPI loads");
    let driver = NvapiDriver::new(api);
    let version = super::driver_version_text(driver.driver_version().expect("the version reads"));
    println!(
        "backup: {} driver {} (installed {version})",
        backup.path.display(),
        backup.driver_version
    );
    let started = Instant::now();
    let system = profiles(&mut driver.open().expect("a driver session opens"));
    let mut copy_session = driver.open_file(&backup.path).expect("the copy loads");
    let copy = profiles(&mut copy_session);
    let (rebar, others) = differences(&system, &copy);
    println!(
        "profiles: system {} copy {} ms={}",
        system.len(),
        copy.len(),
        started.elapsed().as_millis()
    );
    println!("Resizable BAR differences: {}", rebar.len());
    rebar.iter().take(40).for_each(|line| println!("  {line}"));
    println!("other differences: {}", others.len());
    others.iter().take(40).for_each(|line| println!("  {line}"));
    journal.info(
        "backup.compare",
        format_args!("rebar={rebar:?} others={others:?}"),
    );

    if env::var("NVSTRAPS_LOAD_BACKUP").as_deref() != Ok("1") {
        return;
    }
    assert!(inspect_access().is_elevated, "run elevated");
    assert_eq!(
        backup.driver_version, version,
        "the copy is from this driver"
    );
    assert!(others.is_empty(), "the copy would undo other changes");
    copy_session
        .save()
        .expect("the copy saves as the system settings");
    drop(copy_session);
    journal.info(
        "backup.loaded",
        format_args!("path={}", backup.path.display()),
    );
    let reloaded = profiles(&mut driver.open().expect("a driver session opens"));
    let (rebar, others) = differences(&reloaded, &copy);
    println!(
        "after loading: Resizable BAR differences {} other differences {}",
        rebar.len(),
        others.len()
    );
    assert!(
        rebar.is_empty() && others.is_empty(),
        "the system settings match the copy"
    );
}

#[test]
#[ignore = "needs a Windows PC with an NVIDIA driver"]
fn the_installed_driver_lists_its_games() {
    let paths = paths();
    let journal = Journal::file(paths.log.clone());
    let catalog = catalog(&paths, &journal);
    println!(
        "accessors: {}",
        nvapi::system_api().expect("NVAPI loads").accessors()
    );
    println!("elevated: {}", inspect_access().is_elevated);
    println!("all games: {}", describe_state(&catalog.all_games));
    let by_nvidia = catalog
        .games
        .iter()
        .filter(|game| game.state.on && game.state.source == RebarSource::Nvidia)
        .count();
    println!("on by NVIDIA: {by_nvidia}");
    for game in catalog
        .games
        .iter()
        .filter(|game| game.name.to_lowercase().contains("cyberpunk"))
    {
        println!(
            "{}: {} apps={:?}",
            game.name,
            describe_state(&game.state),
            game.apps
        );
    }
    assert!(
        catalog.games.len() > 1000,
        "a driver ships thousands of game profiles"
    );
    assert!(
        by_nvidia > 0,
        "NVIDIA turns Resizable BAR on for some games"
    );
}

#[test]
#[ignore = "changes NVIDIA driver profiles; needs administrator rights and NVSTRAPS_DRIVER_WRITE=1"]
fn the_installed_driver_takes_the_switches_and_the_undo() {
    assert_eq!(
        env::var("NVSTRAPS_DRIVER_WRITE").as_deref(),
        Ok("1"),
        "set NVSTRAPS_DRIVER_WRITE=1 to change driver profiles"
    );
    assert!(inspect_access().is_elevated, "run elevated");
    let paths = paths();
    let journal = Journal::file(paths.log.clone());
    let listed = catalog(&paths, &journal);
    assert!(
        listed.undo.is_none(),
        "start from a PC where the app has changed nothing"
    );
    let pick = |variable: &str, wanted: &dyn Fn(&super::GameProfile) -> bool| {
        env::var(variable).unwrap_or_else(|_| {
            listed
                .games
                .iter()
                .find(|game| wanted(game))
                .map(|game| game.name.clone())
                .expect("a matching game")
        })
    };
    let off_game = pick("NVSTRAPS_OFF_GAME", &|game| {
        !game.state.on && !game.state.changed && game.state.source == RebarSource::Driver
    });
    let nvidia_game = pick("NVSTRAPS_NVIDIA_GAME", &|game| {
        game.state.on && !game.state.changed && game.state.source == RebarSource::Nvidia
    });
    let before_off = show("before", Some(&off_game));
    let before_nvidia = show("before", Some(&nvidia_game));
    let before_global = show("before", None);

    let steps = || -> BackendResult<()> {
        // 3-4: one game on, with the handoff's values.
        switch(&paths, &journal, Target::Game(&off_game), true)?;
        assert_turned_on(&before_off, &show("3 on", Some(&off_game)));
        // 6: off again; a game that was off by default has no values of its own left.
        switch(&paths, &journal, Target::Game(&off_game), false)?;
        let cleared = show("6 off", Some(&off_game));
        for id in [APP_SETTING_ID, ENABLE_ID, OPTIONS_ID, SIZE_LIMIT_ID] {
            assert_eq!(
                own_value(&cleared, id),
                own_value(&before_off, id),
                "{id:#010x}"
            );
        }
        // 7: a game NVIDIA turned on, forced off.
        switch(&paths, &journal, Target::Game(&nvidia_game), false)?;
        let forced = show("7 off", Some(&nvidia_game));
        assert_eq!(own_value(&forced, APP_SETTING_ID), Some(&Value::Dword(0)));
        assert_eq!(own_value(&forced, ENABLE_ID), Some(&Value::Dword(0)));
        // 7: on and off again; the off restores NVIDIA's value before forcing it off, so the
        // profile still carries NVIDIA's value.
        switch(&paths, &journal, Target::Game(&nvidia_game), true)?;
        // Enable=1 equals NVIDIA's value, so the driver may report it as NVIDIA's; only the
        // NVIDIA app setting is certain to read as written on this PC.
        let on = show("7 on", Some(&nvidia_game));
        assert_eq!(own_value(&on, APP_SETTING_ID), Some(&Value::Dword(APP_ON)));
        switch(&paths, &journal, Target::Game(&nvidia_game), false)?;
        let again = show("7 off", Some(&nvidia_game));
        assert_eq!(own_value(&again, ENABLE_ID), Some(&Value::Dword(0)));
        assert!(
            again
                .enable
                .as_ref()
                .is_some_and(|setting| setting.predefined)
        );
        // 8: all programs on, seen from a game, then off.
        switch(&paths, &journal, Target::AllGames, true)?;
        assert_turned_on(&before_global, &show("8 on", None));
        let seen = catalog(&paths, &journal);
        let game = seen
            .games
            .iter()
            .find(|game| game.name == off_game)
            .expect("the game is listed");
        println!("8 {off_game}: {}", describe_state(&game.state));
        assert!(game.state.on);
        assert_eq!(game.state.source, RebarSource::AllGames);
        switch(&paths, &journal, Target::AllGames, false)?;
        show("8 off", None);
        Ok(())
    };
    // A failed check above still reaches the undo.
    let outcome = panic::catch_unwind(AssertUnwindSafe(steps));

    // 9: the undo runs whatever happened above.
    let summary = undo::summary(&paths.store.originals, &journal).expect("an undo record");
    println!("9 undo: profiles={}", summary.profiles);
    with_driver(&journal, |driver| {
        undo::undo(driver, &paths.store.originals, &summary.revision, &journal)
    })
    .expect("the undo restores the earlier values");
    match outcome {
        Ok(result) => result.expect("every switch reads back"),
        Err(failure) => panic::resume_unwind(failure),
    }
    assert_eq!(show("9 undone", Some(&off_game)), before_off);
    assert_eq!(show("9 undone", Some(&nvidia_game)), before_nvidia);
    assert_eq!(show("9 undone", None), before_global);
}
