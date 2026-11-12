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
    // Auto-update and the one-copy rule are desktop-only; iOS installs the
    // app itself and never starts a second copy.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            // Second launch focuses the existing window instead of a new process.
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }));
    }
    // Face ID / Touch ID, and Safari for outside links. Only the Rust side
    // calls these plugins, so the webview gets no permissions for them.
    #[cfg(target_os = "ios")]
    {
        builder = builder
            .plugin(tauri_plugin_biometric::init())
            .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build());
    }
    builder
        .invoke_handler(tauri::generate_handler![
            commands::http_request,
            commands::http_request_stream,
            commands::cancel_stream,
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
