mod app;
mod config;
mod devices;
mod error;
mod firmware;
mod machine;
mod status;

pub fn run() {
    tauri::Builder::default()
        .manage(app::AppState::default())
        .invoke_handler(tauri::generate_handler![
            app::get_system_snapshot,
            app::refresh_system,
            app::validate_config,
            app::save_config,
            app::request_elevation,
            app::get_machine_identity,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run NvStrapsReBar");
}
