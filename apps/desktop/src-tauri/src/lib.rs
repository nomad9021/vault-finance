mod biometric;
mod commands;
mod lockwatch;
mod tailscale;
mod tls;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init());
    // Auto-update is desktop-only; the Phase 2 iOS build updates via the App Store.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        // Second launch focuses the existing window instead of a new process.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::http_request,
            commands::http_request_stream,
            commands::probe_server,
            commands::get_secret,
            commands::set_secret,
            commands::delete_secret,
            commands::open_admin_window,
            commands::tailscale_status,
            commands::tailscale_up,
            commands::tailscale_down,
            commands::open_external,
            commands::external_updater_available,
            commands::run_external_updater,
            biometric::biometric_status,
            biometric::biometric_authenticate,
            biometric::biometric_cancel,
        ])
        .setup(|app| {
            // Lock the app when the screen locks or the computer sleeps.
            lockwatch::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window quits: nothing keeps running in the
            // background (no tray), and the next start is locked.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
