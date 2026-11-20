//! How the application fits a Linux desktop: WebKit's rendering beside NVIDIA's driver, the
//! file chooser and the window's title bar.

use std::{cell::RefCell, os::unix::process::CommandExt, path::PathBuf, process::Command, rc::Rc};

use gtk::{gio, prelude::*};
use serde::Deserialize;
use tauri::async_runtime::{Sender, channel};

use crate::error::{BackendError, BackendResult};

const USE_PORTAL: &str = "GTK_USE_PORTAL";
const PORTAL_BUS_NAME: &str = "org.freedesktop.portal.Desktop";
const PORTAL_OBJECT_PATH: &str = "/org/freedesktop/portal/desktop";
const FILE_CHOOSER_INTERFACE: &str = "org.freedesktop.portal.FileChooser";
/// GTK itself asks for this version before it lets the portal choose a folder.
const FILE_CHOOSER_VERSION_FOR_FOLDERS: u32 = 3;
/// The portal starts on demand, so its first answer can take a moment.
const PORTAL_ANSWER_TIMEOUT_MS: i32 = 1500;

/// Keeps WebKitGTK off the rendering paths that fail beside NVIDIA's driver.
///
/// Every PC this app is for has an NVIDIA GPU, and with NVIDIA's own driver WebKitGTK is known
/// to show a blank or flickering window under X11 and to lose its connection to the desktop at
/// the first frame under Wayland compositors that insist on explicit sync (KWin, Hyprland). An
/// environment variable avoids each failure, but none is right everywhere: turning the DMA-BUF
/// renderer off, which Tauri's guide shows, cures X11 and leaves a transparent window under
/// KWin on an RTX 2060 SUPER (WebKit bug 280210, comment 14). `webkit2gtk-nvidia-quirk` holds
/// the table of which variable belongs to which session and is kept current with the reports;
/// docs/LINUX.md repeats the table.
///
/// It sets at most one variable, which WebKit's processes inherit, and none when the boot GPU
/// does not run NVIDIA's driver or when the user has set one of these variables already. With
/// a variable set, a line on stderr says which.
///
/// This changes the environment, so `run` calls it before anything else, while the program
/// still has one thread.
pub(crate) fn avoid_nvidia_rendering_faults() {
    webkit2gtk_nvidia_quirk::apply_workaround_with_options(
        webkit2gtk_nvidia_quirk::ApplyWorkaroundOptions::default().verbose(true),
    );
}

/// Lets file choosers be the desktop's own (the file manager's on GNOME and KDE).
///
/// GTK asks xdg-desktop-portal for the desktop's dialog only when `GTK_USE_PORTAL=1`; otherwise
/// it draws its own, older one. With the variable set and no portal behind it, choosing a file
/// shows no dialog at all, so the portal is asked first.
///
/// Asking starts GLib's D-Bus thread, after which the environment can no longer be changed
/// safely. The program therefore starts itself again with the variable set. `run` calls this
/// before anything else.
pub(crate) fn prefer_desktop_file_chooser() {
    if std::env::var_os(USE_PORTAL).is_some() || !file_chooser_portal_answers() {
        return;
    }
    let Ok(program) = std::env::current_exe() else {
        return;
    };
    // `exec` returns only when it failed; the GTK dialog stays in use then.
    let error = Command::new(program)
        .args(std::env::args_os().skip(1))
        .env(USE_PORTAL, "1")
        .exec();
    eprintln!("NvStrapsReBar keeps the GTK file chooser: {error}");
}

fn file_chooser_portal_answers() -> bool {
    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else {
        return false;
    };
    bus.call_sync(
        Some(PORTAL_BUS_NAME),
        PORTAL_OBJECT_PATH,
        "org.freedesktop.DBus.Properties",
        "Get",
        Some(&(FILE_CHOOSER_INTERFACE, "version").to_variant()),
        None,
        gio::DBusCallFlags::NONE,
        PORTAL_ANSWER_TIMEOUT_MS,
        gio::Cancellable::NONE,
    )
    .ok()
    .and_then(|reply| reply.try_child_value(0))
    .and_then(|boxed| boxed.as_variant())
    .and_then(|version| version.get::<u32>())
    .is_some_and(|version| version >= FILE_CHOOSER_VERSION_FOR_FOLDERS)
}

/// What the frontend asks the user to choose (`PathRequest` in `src/native-dialogs.ts`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathChooser {
    kind: PathKind,
    /// Empty for the desktop's own title.
    title: String,
    /// The file name offered when a new file is saved.
    suggested_name: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PathKind {
    File,
    Folder,
    NewFile,
}

/// Shows the chooser as a modal child of `window` and waits for the answer; `None` when the
/// user cancels.
///
/// With the window as its parent, the desktop keeps the chooser on top of the app, gives it no
/// minimize or maximize button and takes no input for the app until it is answered. The
/// chooser gets no file type filter: on the Ubuntu 26.10 desktop of issue #63 it listed no file
/// at all under a pattern filter, "*.*" included, and the cause is not known.
pub(crate) async fn choose_path(
    window: tauri::WebviewWindow,
    chooser: PathChooser,
) -> BackendResult<Option<String>> {
    let failed = |message: String| BackendError::External {
        code: "path_chooser_failed",
        message,
    };
    let (answer, mut chosen) = channel(1);
    let parent = window.clone();
    window
        .run_on_main_thread(move || show_path_chooser(&parent, &chooser, answer))
        .map_err(|error| failed(format!("the file chooser could not be opened: {error}")))?;
    match chosen.recv().await.flatten() {
        None => Ok(None),
        Some(path) => path
            .into_os_string()
            .into_string()
            .map(Some)
            .map_err(|path| {
                failed(format!(
                    "the chosen path is not valid UTF-8: {}",
                    path.to_string_lossy()
                ))
            }),
    }
}

fn show_path_chooser(
    window: &tauri::WebviewWindow,
    chooser: &PathChooser,
    answer: Sender<Option<PathBuf>>,
) {
    let parent = window.gtk_window().ok();
    let action = match chooser.kind {
        PathKind::File => gtk::FileChooserAction::Open,
        PathKind::Folder => gtk::FileChooserAction::SelectFolder,
        PathKind::NewFile => gtk::FileChooserAction::Save,
    };
    let title = (!chooser.title.is_empty()).then_some(chooser.title.as_str());
    // No button labels: the desktop then uses its own, in the user's language.
    let dialog = gtk::FileChooserNative::new(title, parent.as_ref(), action, None, None);
    dialog.set_modal(true);
    if let Some(name) = &chooser.suggested_name {
        dialog.set_current_name(name);
        dialog.set_do_overwrite_confirmation(true);
    }
    // GTK holds no reference to a native dialog, so the handler keeps it until the answer.
    let shown = Rc::new(RefCell::new(Some(dialog.clone())));
    dialog.connect_response(move |dialog, response| {
        let path = (response == gtk::ResponseType::Accept)
            .then(|| dialog.filename())
            .flatten();
        // The command may have been dropped; the answer has nowhere to go then.
        let _ = answer.try_send(path);
        dialog.destroy();
        shown.borrow_mut().take();
    });
    dialog.show();
}

/// The style class of the app's main window. The title bar rules below start from it, so they
/// reach that window's title bar and no dialog's.
const MAIN_WINDOW_CLASS: &str = "nvstraps-rebar-main";

/// The colours of the app bar (`--bg`, `--ink` and `--muted` in `src/styles.css`).
///
/// The rules name the window and any header bar under it, not the header bar's place in the
/// window. Up to 1.1.9 they named the header bar tao built for Wayland (`.titlebar headerbar`).
/// tao 0.37 builds none: GTK adds its own, which carries the `titlebar` class itself, so the
/// rules matched nothing and 1.1.10 showed the desktop theme's title bar (issue #85). The title
/// is kept quiet: the app bar right below already shows the name.
const TITLE_BAR_CSS: &str = "
.nvstraps-rebar-main headerbar,
.nvstraps-rebar-main headerbar:backdrop {
    background: #11161d;
    border: none;
    box-shadow: none;
}
.nvstraps-rebar-main headerbar,
.nvstraps-rebar-main headerbar button.titlebutton {
    color: #edf2f7;
}
.nvstraps-rebar-main headerbar .title {
    color: #a0adbb;
    font-weight: normal;
}
.nvstraps-rebar-main headerbar:backdrop,
.nvstraps-rebar-main headerbar:backdrop button.titlebutton {
    color: #a0adbb;
}
";

/// Gives the title bar the colour of the app bar below it.
///
/// Where the window draws its own title bar (Wayland desktops that leave it to the window,
/// GNOME among them) the desktop theme painted it in its own colour, so the window looked like
/// two unrelated strips. Where the desktop draws the title bar (X11) this changes nothing.
pub(crate) fn blend_title_bar(window: &tauri::WebviewWindow) {
    let Ok(window) = window.gtk_window() else {
        return;
    };
    let Some(screen) = GtkWindowExt::screen(&window) else {
        return;
    };
    let provider = gtk::CssProvider::new();
    match provider.load_from_data(TITLE_BAR_CSS.as_bytes()) {
        Ok(()) => {
            window.style_context().add_class(MAIN_WINDOW_CLASS);
            gtk::StyleContext::add_provider_for_screen(
                &screen,
                &provider,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
        }
        Err(error) => eprintln!("NvStrapsReBar keeps the desktop's title bar colour: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{MAIN_WINDOW_CLASS, TITLE_BAR_CSS};

    /// The selectors of `TITLE_BAR_CSS`: the lines outside the declaration blocks.
    fn title_bar_selectors() -> Vec<&'static str> {
        let mut inside_block = false;
        let mut selectors = Vec::new();
        for line in TITLE_BAR_CSS.lines().map(str::trim) {
            if line == "}" {
                inside_block = false;
            } else if !inside_block && !line.is_empty() {
                inside_block = line.ends_with('{');
                selectors.push(line.trim_end_matches(['{', ',']).trim_end());
            }
        }
        selectors
    }

    #[test]
    fn title_bar_rules_reach_only_the_main_window() {
        let selectors = title_bar_selectors();
        assert!(!selectors.is_empty());
        let main_window_header_bar = format!(".{MAIN_WINDOW_CLASS} headerbar");
        for selector in selectors {
            let rest = selector
                .strip_prefix(&main_window_header_bar)
                .unwrap_or_else(|| panic!("`{selector}` would style other windows too"));
            assert!(
                rest.is_empty() || rest.starts_with([' ', ':']),
                "`{selector}` names something other than a header bar"
            );
        }
    }

    #[test]
    fn title_bar_uses_the_app_bar_colours() {
        let styles = include_str!("../../../src/styles.css");
        for (token, uses) in [("--bg", 1), ("--ink", 1), ("--muted", 2)] {
            let declared = styles
                .lines()
                .find_map(|line| line.trim().strip_prefix(&format!("{token}: ")))
                .unwrap_or_else(|| panic!("{token} is not declared in src/styles.css"))
                .trim_end_matches(';');
            assert_eq!(
                TITLE_BAR_CSS.matches(declared).count(),
                uses,
                "{token} is {declared} in src/styles.css"
            );
        }
    }
}
