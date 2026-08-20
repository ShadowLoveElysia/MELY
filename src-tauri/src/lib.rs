mod commands;
pub mod solid_voxel;
pub mod system_capability;

use solid_voxel::manager::SolidVoxelManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SolidVoxelManager::new())
        .invoke_handler(tauri::generate_handler![
            system_capability::solid_voxel_capabilities,
            commands::solid_voxel::create_solid_voxel_job,
            commands::solid_voxel::upload_solid_voxel_snapshot,
            commands::solid_voxel::solid_voxel_job_status,
            commands::solid_voxel::cancel_solid_voxel_job,
            commands::solid_voxel::release_solid_voxel_job,
            commands::solid_voxel::get_solid_voxel_preview,
            commands::solid_voxel::pull_solid_voxel_chunks,
            commands::solid_voxel::write_solid_voxel_litematic,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build MELY desktop application");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app_handle.state::<SolidVoxelManager>().shutdown();
        }
    });
}
