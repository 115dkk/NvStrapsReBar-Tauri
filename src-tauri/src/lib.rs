mod app;
mod config;
mod deployment;
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
            deployment::inspect_firmware_image,
            deployment::list_legacy_patch_catalogs,
            deployment::create_machine_profile,
            deployment::list_machine_profiles,
            deployment::get_deployment_plan,
            deployment::compare_machine_profile,
            deployment::prepare_firmware_artifact,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run NvStrapsReBar");
}
