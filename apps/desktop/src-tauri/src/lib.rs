mod biometric;
mod commands;
mod tls;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
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
            biometric::biometric_status,
            biometric::biometric_authenticate,
            biometric::biometric_cancel,
        ])
        .setup(|app| {
            // Tray: quick show/hide + quit. Closing the window hides to tray
            // on Windows/Linux (macOS apps conventionally keep running with
            // no windows; the Dock handles re-opening there).
            let show = MenuItem::with_id(app, "show", "Show Vault Finance", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().expect("bundled icon"))
                .tooltip("Vault Finance")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(not(target_os = "macos"))]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
            #[cfg(target_os = "macos")]
            let _ = (window, event);
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
