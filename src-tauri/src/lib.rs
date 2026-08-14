mod app;
mod config;
mod deployment;
mod deployment_workflow;
mod devices;
mod error;
mod firmware;
mod hardware_support;
mod machine;
mod profile_inspector;
mod reboot;
mod resizable_bar;
mod resizable_bar_commands;
mod status;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app::AppState::default())
        .invoke_handler(tauri::generate_handler![
            app::get_system_snapshot,
            app::refresh_system,
            app::validate_config,
            app::save_config,
            app::request_elevation,
            app::get_machine_identity,
            deployment::inspect_firmware_image,
            deployment::analyze_legacy_firmware,
            deployment::list_legacy_patch_catalogs,
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
            profile_inspector::install_nvidia_profile_inspector,
            profile_inspector::get_nvidia_profile_inspector_installation,
            profile_inspector::launch_nvidia_profile_inspector,
            profile_inspector::backup_nvidia_profiles,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run NvStrapsReBar");
}
