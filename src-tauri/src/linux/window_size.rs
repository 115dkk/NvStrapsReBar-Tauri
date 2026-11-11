//! The main window's size and maximized state, kept between runs.
//!
//! On Windows the window-state plugin keeps them. On Linux it left a window that had been
//! un-maximized as large as the screen, and the next run opened it that way (issue #63). Two
//! things lead there. GTK reports a window's new size and its new state as separate events, so
//! a size read when one of them arrives can belong to the other state. And a window that is
//! maximized before it is first shown does not return to the size it was given before that:
//! an X11 window manager returns it to the size it was created with, and under Wayland it can
//! keep the maximized size.
//!
//! This module reads size and state together, once both have settled, and gives a window that
//! leaves the maximized state its last normal size back.

use std::{
    cell::{Cell, RefCell},
    fs,
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};

use gtk::{gdk, glib, prelude::*};
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "window-size.json";
/// How long size and state must stay unchanged before they are read.
const SETTLE: Duration = Duration::from_millis(150);

type Size = (i32, i32);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
struct SavedWindow {
    width: i32,
    height: i32,
    maximized: bool,
}

/// What is known about the window from the settled readings so far.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Memory {
    /// The size the window has, or last had, while not maximized.
    normal: Size,
    maximized: bool,
}

impl Memory {
    fn starting_at(normal: Size) -> Self {
        Self {
            normal,
            maximized: false,
        }
    }

    /// Takes one settled reading. Returns the size to give the window when it left the
    /// maximized state at another size than its normal one.
    fn observe(&mut self, size: Size, maximized: bool) -> Option<Size> {
        if maximized {
            self.maximized = true;
            return None;
        }
        if std::mem::replace(&mut self.maximized, false) {
            return (size != self.normal).then_some(self.normal);
        }
        self.normal = size;
        None
    }

    fn saved(&self) -> SavedWindow {
        SavedWindow {
            width: self.normal.0,
            height: self.normal.1,
            maximized: self.maximized,
        }
    }
}

struct Tracker {
    file: Option<PathBuf>,
    memory: RefCell<Memory>,
    written: Cell<Option<SavedWindow>>,
    /// Counts size and state changes, so that only the last one of a burst is read.
    changes: Cell<u64>,
}

/// Opens the window as it was left and keeps `window-size.json` in `directory` up to date.
pub(crate) fn keep(window: &tauri::WebviewWindow, directory: Option<PathBuf>) {
    let Ok(window) = window.gtk_window() else {
        return;
    };
    let file = directory.map(|directory| directory.join(FILE_NAME));
    let saved = file.as_deref().and_then(read);
    if let Some(saved) = saved {
        window.resize(saved.width, saved.height);
        if saved.maximized {
            window.maximize();
        }
    }
    let normal = saved.map_or_else(|| window.size(), |saved| (saved.width, saved.height));
    let tracker = Rc::new(Tracker {
        file,
        memory: RefCell::new(Memory::starting_at(normal)),
        written: Cell::new(saved),
        changes: Cell::new(0),
    });
    window.connect_size_allocate({
        let tracker = Rc::clone(&tracker);
        move |window, _| read_when_settled(&tracker, window)
    });
    window.connect_is_maximized_notify(move |window| read_when_settled(&tracker, window));
}

fn read_when_settled(tracker: &Rc<Tracker>, window: &gtk::ApplicationWindow) {
    let change = tracker.changes.get().wrapping_add(1);
    tracker.changes.set(change);
    let tracker = Rc::clone(tracker);
    let window = window.clone();
    glib::timeout_add_local_once(SETTLE, move || {
        if tracker.changes.get() == change {
            tracker.read(&window);
        }
    });
}

impl Tracker {
    fn read(&self, window: &gtk::ApplicationWindow) {
        let Some(state) = window.window().map(|window| window.state()) else {
            return;
        };
        // None of these is a size the user chose for the window.
        if state.intersects(
            gdk::WindowState::WITHDRAWN
                | gdk::WindowState::ICONIFIED
                | gdk::WindowState::FULLSCREEN
                | gdk::WindowState::TILED,
        ) {
            return;
        }
        let give_back = self
            .memory
            .borrow_mut()
            .observe(window.size(), window.is_maximized());
        if let Some((width, height)) = give_back {
            // The resize comes back as a new reading, which becomes the normal size.
            window.resize(width, height);
            return;
        }
        let now = self.memory.borrow().saved();
        if self.written.get() != Some(now) {
            self.written.set(Some(now));
            if let Some(file) = &self.file {
                write(file, now);
            }
        }
    }
}

fn read(file: &Path) -> Option<SavedWindow> {
    let saved: SavedWindow = serde_json::from_slice(&fs::read(file).ok()?).ok()?;
    (saved.width > 0 && saved.height > 0).then_some(saved)
}

fn write(file: &Path, saved: SavedWindow) {
    let written = file
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| fs::write(file, serde_json::to_vec(&saved).unwrap_or_default()));
    if let Err(error) = written {
        eprintln!("NvStrapsReBar could not save the window size: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NORMAL: Size = (1180, 760);
    const FULL: Size = (1920, 1048);

    #[test]
    fn a_resized_window_is_remembered_at_its_new_size() {
        let mut memory = Memory::starting_at(NORMAL);
        assert_eq!(memory.observe((1000, 700), false), None);
        assert_eq!(
            memory.saved(),
            SavedWindow {
                width: 1000,
                height: 700,
                maximized: false
            }
        );
    }

    #[test]
    fn a_maximized_window_keeps_its_normal_size_for_later() {
        let mut memory = Memory::starting_at(NORMAL);
        assert_eq!(memory.observe(FULL, true), None);
        assert_eq!(
            memory.saved(),
            SavedWindow {
                width: 1180,
                height: 760,
                maximized: true
            }
        );
    }

    #[test]
    fn leaving_the_maximized_state_at_the_normal_size_changes_nothing() {
        let mut memory = Memory::starting_at(NORMAL);
        memory.observe(FULL, true);
        assert_eq!(memory.observe(NORMAL, false), None);
        assert_eq!(
            memory.saved(),
            SavedWindow {
                width: 1180,
                height: 760,
                maximized: false
            }
        );
    }

    #[test]
    fn leaving_the_maximized_state_at_another_size_gets_the_normal_size_back() {
        // Still as large as the screen (Wayland), or the size the window was created with (X11).
        for left_at in [FULL, (1920, 1040), (900, 620)] {
            let mut memory = Memory::starting_at(NORMAL);
            memory.observe(FULL, true);
            assert_eq!(memory.observe(left_at, false), Some(NORMAL));
            assert_eq!(
                memory.saved(),
                SavedWindow {
                    width: 1180,
                    height: 760,
                    maximized: false
                }
            );
            // The resize arrives as the next reading.
            assert_eq!(memory.observe(NORMAL, false), None);
            assert_eq!(memory.saved().width, 1180);
        }
    }

    #[test]
    fn a_window_resized_after_leaving_the_maximized_state_keeps_the_new_size() {
        let mut memory = Memory::starting_at(NORMAL);
        memory.observe(FULL, true);
        memory.observe(NORMAL, false);
        assert_eq!(memory.observe(FULL, false), None);
        assert_eq!(memory.saved().width, 1920);
    }

    #[test]
    fn a_saved_window_without_a_size_is_ignored() {
        let directory = std::env::temp_dir().join(format!(
            "nvstraps-window-size-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = directory.join(FILE_NAME);
        assert_eq!(read(&file), None);
        let saved = SavedWindow {
            width: 1000,
            height: 700,
            maximized: true,
        };
        write(&file, saved);
        assert_eq!(read(&file), Some(saved));
        fs::write(&file, br#"{"width":0,"height":700,"maximized":false}"#).unwrap();
        assert_eq!(read(&file), None);
        fs::write(&file, b"not json").unwrap();
        assert_eq!(read(&file), None);
        fs::remove_dir_all(&directory).unwrap();
    }
}
