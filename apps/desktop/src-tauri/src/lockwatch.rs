//! Tells the app to lock itself when the computer does: the screen locks,
//! the session locks, or the machine goes to sleep (lid closed). The app also
//! notices sleep on its own (a jump in its clock) and locks after idle time,
//! so this only adds the cases the webview can't see.
//!
//! Linux: logind on the system bus (PrepareForSleep, the session's Lock signal
//! and LockedHint) and the screensaver on the session bus (KDE, GNOME).
//! Windows: the input desktop can't be opened while the workstation is locked.
//! macOS: not watched here (sleep and idle locking still apply).

use tauri::{AppHandle, Emitter};

/// Event the webview listens for (platform/tauri.ts → onSystemLock).
pub const EVENT: &str = "vault-system-lock";

pub fn start(app: AppHandle) {
    imp::start(app);
}

fn notify(app: &AppHandle, reason: &str) {
    let _ = app.emit(EVENT, reason.to_string());
}

#[cfg(target_os = "linux")]
mod imp {
    use super::notify;
    use futures_lite::StreamExt;
    use std::collections::HashMap;
    use tauri::AppHandle;
    use zbus::zvariant::{OwnedObjectPath, OwnedValue};
    use zbus::{Connection, Proxy};

    pub fn start(app: AppHandle) {
        // Each watcher runs on its own thread; a missing service just ends it.
        let a = app.clone();
        std::thread::spawn(move || async_io::block_on(sleep_and_session(a)));
        for (dest, path, iface) in [
            ("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver"),
            ("org.freedesktop.ScreenSaver", "/ScreenSaver", "org.freedesktop.ScreenSaver"),
            ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver"),
        ] {
            let a = app.clone();
            std::thread::spawn(move || async_io::block_on(screensaver(a, dest, path, iface)));
        }
    }

    async fn sleep_and_session(app: AppHandle) {
        let Ok(conn) = Connection::system().await else { return };
        let Ok(manager) = Proxy::new(&conn, "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager").await
        else {
            return;
        };
        let session_path: Option<OwnedObjectPath> = manager.call("GetSessionByPID", &(std::process::id())).await.ok();
        let session = match &session_path {
            Some(p) => Proxy::new(&conn, "org.freedesktop.login1", p.clone(), "org.freedesktop.login1.Session").await.ok(),
            None => None,
        };
        let props = match &session_path {
            Some(p) => Proxy::new(&conn, "org.freedesktop.login1", p.clone(), "org.freedesktop.DBus.Properties").await.ok(),
            None => None,
        };

        let sleep = async {
            let Ok(mut s) = manager.receive_signal("PrepareForSleep").await else { return };
            while let Some(msg) = s.next().await {
                if matches!(msg.body().deserialize::<bool>(), Ok(true)) {
                    notify(&app, "sleep");
                }
            }
        };
        let lock = async {
            let Some(session) = &session else { return };
            let Ok(mut s) = session.receive_signal("Lock").await else { return };
            while s.next().await.is_some() {
                notify(&app, "session-lock");
            }
        };
        let hint = async {
            let Some(props) = &props else { return };
            let Ok(mut s) = props.receive_signal("PropertiesChanged").await else { return };
            while let Some(msg) = s.next().await {
                if let Ok((_, changed, _)) = msg.body().deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>() {
                    if changed.get("LockedHint").and_then(|v| bool::try_from(v.clone()).ok()) == Some(true) {
                        notify(&app, "session-lock");
                    }
                }
            }
        };
        futures_lite::future::zip(sleep, futures_lite::future::zip(lock, hint)).await;
    }

    async fn screensaver(app: AppHandle, dest: &'static str, path: &'static str, iface: &'static str) {
        let Ok(conn) = Connection::session().await else { return };
        let Ok(proxy) = Proxy::new(&conn, dest, path, iface).await else { return };
        let Ok(mut s) = proxy.receive_signal("ActiveChanged").await else { return };
        while let Some(msg) = s.next().await {
            if matches!(msg.body().deserialize::<bool>(), Ok(true)) {
                notify(&app, "screen-lock");
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::notify;
    use std::time::Duration;
    use tauri::AppHandle;
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_SWITCHDESKTOP};

    pub fn start(app: AppHandle) {
        std::thread::spawn(move || {
            let mut was_locked = false;
            loop {
                // While the workstation is locked the input desktop is the
                // secure desktop, which a normal process can't open.
                // SAFETY: plain Win32 calls; the handle is closed straight away.
                let locked = unsafe {
                    match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP) {
                        Ok(h) => {
                            let _ = CloseDesktop(h);
                            false
                        }
                        Err(_) => true,
                    }
                };
                if locked && !was_locked {
                    notify(&app, "screen-lock");
                }
                was_locked = locked;
                std::thread::sleep(Duration::from_secs(2));
            }
        });
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod imp {
    pub fn start(_app: tauri::AppHandle) {}
}
