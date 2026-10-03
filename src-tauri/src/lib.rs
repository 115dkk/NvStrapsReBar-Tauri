use tauri::Manager;

mod app;
mod bar_settings;
mod bar_settings_commands;
mod config;
mod deployment;
mod deployment_workflow;
mod devices;
mod error;
mod firmware;
mod hardware_support;
mod machine;
mod nvidia_profiles;
mod reboot;
mod resizable_bar;
mod resizable_bar_commands;
mod settings_snapshot;
mod status;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            match app.path().app_local_data_dir() {
                Ok(root) => nvidia_profiles::install_panic_log(root.join("logs").join("panic.log")),
                Err(error) => eprintln!("NvStrapsReBar panic log is unavailable: {error}"),
            }
            Ok(())
        })
        .manage(app::AppState::default())
        .invoke_handler(tauri::generate_handler![
            app::get_system_snapshot,
            app::refresh_system,
            app::validate_config,
            app::save_config,
            bar_settings_commands::save_bar_settings,
            settings_snapshot::export_bar_settings_snapshot,
            settings_snapshot::inspect_bar_settings_snapshot,
            app::request_elevation,
            deployment::inspect_firmware_image,
            deployment::analyze_legacy_firmware,
            deployment::create_machine_profile,
            deployment::list_machine_profiles,
            deployment::get_deployment_plan,
            deployment::compare_machine_profile,
            deployment::prepare_firmware_artifact,
            deployment::export_deployment_package,
            deployment_workflow::get_recommended_deployment_config,
            deployment_workflow::save_deployment_config,
            deployment_workflow::preview_manual_deployment_step,
            deployment_workflow::confirm_manual_deployment_step,
            deployment_workflow::verify_deployment_driver,
            deployment_workflow::verify_configuration_reboot,
            reboot::preview_firmware_setup_reboot,
            reboot::reboot_to_firmware_setup,
            reboot::preview_configuration_reboot,
            reboot::reboot_after_configuration,
            resizable_bar_commands::inspect_resizable_bar_status,
            resizable_bar_commands::collect_nvidia_smi_evidence,
            nvidia_profiles::load_nvidia_game_settings,
            nvidia_profiles::set_nvidia_game_rebar,
            nvidia_profiles::set_nvidia_all_games_rebar,
            nvidia_profiles::restore_nvidia_driver_settings,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run NvStrapsReBar");
}
