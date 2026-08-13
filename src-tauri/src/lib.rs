mod app;
mod config;
mod devices;
mod error;
mod firmware;
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run NvStrapsReBar");
}
