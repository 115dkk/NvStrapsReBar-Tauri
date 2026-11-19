use std::{env, fs, path::PathBuf};

fn main() {
    tauri_build::build();
    copy_resources_beside_the_binary();
}

/// Copies the bundle resources to where the binary is written when tauri-build put them one
/// directory too deep.
///
/// tauri-build 2.6 takes the directory three levels above `OUT_DIR` for the one Cargo writes the
/// binary to. Since Cargo 1.100 the build script's output is one level deeper
/// (`<profile>/build/<package>/<hash>/out`), so that directory is `<profile>/build` and the
/// driver file and the external EFI programs end up there, away from the application, the
/// installer and the release archive that expect them beside the binary. With an older Cargo
/// tauri-build is right and this does nothing. tauri-build 2.7 finds the directory itself; remove
/// this when the project moves to it.
fn copy_resources_beside_the_binary() {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
    let Some(guessed) = out_dir.ancestors().nth(3) else {
        return;
    };
    if guessed.file_name().and_then(|name| name.to_str()) != Some("build") {
        return;
    }
    let Some(beside_binary) = guessed.parent() else {
        return;
    };
    let config: serde_json::Value = serde_json::from_str(
        &fs::read_to_string("tauri.conf.json").expect("src-tauri/tauri.conf.json is readable"),
    )
    .expect("src-tauri/tauri.conf.json is JSON");
    let Some(resources) = config["bundle"]["resources"].as_object() else {
        return;
    };
    for destination in resources.values().filter_map(|value| value.as_str()) {
        let from = guessed.join(destination);
        let to = beside_binary.join(destination);
        if let Some(directory) = to.parent() {
            fs::create_dir_all(directory)
                .unwrap_or_else(|error| panic!("cannot create {}: {error}", directory.display()));
        }
        fs::copy(&from, &to).unwrap_or_else(|error| {
            panic!(
                "cannot copy the resource {} to {}: {error}",
                from.display(),
                to.display()
            )
        });
    }
}
