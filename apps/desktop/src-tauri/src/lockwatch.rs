//! Tells the app to lock itself when the computer does: the screen locks,
//! the session locks, or the machine goes to sleep (lid closed). The app also
//! notices sleep on its own (a jump in its clock) and locks after idle time,
//! so this only adds the cases the webview can't see.
//!
//! Linux: logind on the system bus (PrepareForSleep, the session's Lock signal
//! and LockedHint) and the screensaver on the session bus (KDE, GNOME).
//! Windows: the input desktop can't be opened while the workstation is locked.
//! iOS: the moment the app stops being active (swiping up to the app
//! switcher or home, Control Centre, a call) it locks and covers its window,
//! so the app switcher's snapshot shows only a padlock.
//! macOS: not watched here (sleep and idle locking still apply).

use tauri::{AppHandle, Emitter};

/// Event the webview listens for (platform/tauri.ts → onSystemLock).
pub const EVENT: &str = "vault-system-lock";
/// iOS: the app is active (in front, able to show Face ID) again.
#[allow(dead_code)] // emitted only by the iOS watcher
pub const ACTIVE_EVENT: &str = "vault-app-active";

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

/// iOS privacy cover. iOS takes the app-switcher snapshot as the app resigns
/// active, before the web page hears anything, so the cover is a native view
/// added on UIApplicationWillResignActive and removed on DidBecomeActive.
/// Locking at the same moment means coming back always asks for Face ID or
/// the password, and the cover hides the unlock screen's transition too.
#[cfg(target_os = "ios")]
mod imp {
    use super::notify;
    use block2::RcBlock;
    use objc2::encode::{Encode, Encoding};
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ptr::{self, NonNull};
    use tauri::AppHandle;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }
    // SAFETY: layouts match CoreGraphics' 64-bit CGPoint/CGSize/CGRect.
    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    fn rect(x: f64, y: f64, width: f64, height: f64) -> CGRect {
        CGRect { origin: CGPoint { x, y }, size: CGSize { width, height } }
    }

    /// The lock-screen padlock (icons/lock-cover.png), built into the binary.
    static LOCK_PNG: &[u8] = include_bytes!("../icons/lock-cover.png");

    /// Marks the cover view so it can be found and removed again.
    const COVER_TAG: isize = 0x5641_554C; // "VAUL"

    #[link(name = "UIKit", kind = "framework")]
    extern "C" {
        static UIApplicationWillResignActiveNotification: *const AnyObject;
        static UIApplicationDidBecomeActiveNotification: *const AnyObject;
    }

    /// The app's window (one window, one scene).
    unsafe fn window() -> *mut AnyObject {
        let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
        let windows: *mut AnyObject = msg_send![app, windows];
        msg_send![windows, firstObject]
    }

    unsafe fn show_cover() {
        let win = window();
        if win.is_null() {
            return;
        }
        let existing: *mut AnyObject = msg_send![win, viewWithTag: COVER_TAG];
        if !existing.is_null() {
            return;
        }
        let b: CGRect = msg_send![win, bounds];
        let (w, h) = (b.size.width, b.size.height);

        let cover: Allocated<AnyObject> = msg_send![class!(UIView), alloc];
        let cover: Retained<AnyObject> = msg_send![cover, initWithFrame: b];
        let _: () = msg_send![&*cover, setTag: COVER_TAG];
        let _: () = msg_send![&*cover, setAutoresizingMask: 18usize]; // flexible width + height
        let bg: *mut AnyObject = msg_send![class!(UIColor), systemBackgroundColor];
        let _: () = msg_send![&*cover, setBackgroundColor: bg];

        // Just the padlock, centred: no name, no text, nothing else.
        let data: *mut AnyObject = msg_send![
            class!(NSData),
            dataWithBytes: LOCK_PNG.as_ptr().cast::<std::ffi::c_void>(),
            length: LOCK_PNG.len()
        ];
        let img: *mut AnyObject = msg_send![class!(UIImage), imageWithData: data];
        let icon: Allocated<AnyObject> = msg_send![class!(UIImageView), alloc];
        let icon: Retained<AnyObject> = msg_send![icon, initWithImage: img];
        let _: () = msg_send![&*icon, setFrame: rect(w / 2.0 - 36.0, h / 2.0 - 37.0, 72.0, 74.0)];
        let _: () = msg_send![&*icon, setContentMode: 1isize]; // scale aspect fit
        let _: () = msg_send![&*icon, setAutoresizingMask: 45usize]; // keep centred on rotation

        let _: () = msg_send![&*cover, addSubview: &*icon];
        let _: () = msg_send![win, addSubview: &*cover];
    }

    unsafe fn hide_cover() {
        let win = window();
        if win.is_null() {
            return;
        }
        let cover: *mut AnyObject = msg_send![win, viewWithTag: COVER_TAG];
        if !cover.is_null() {
            let _: () = msg_send![cover, removeFromSuperview];
        }
    }

    pub fn start(app: AppHandle) {
        // SAFETY: called from Tauri's setup on the main thread; the blocks
        // run on the main queue, where UIKit may be used.
        unsafe {
            let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
            let queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];

            let app_resign = app.clone();
            let resign = RcBlock::new(move |_note: NonNull<AnyObject>| {
                show_cover();
                notify(&app_resign, "app-inactive");
            });
            // Face ID can only be asked for once the app is active again, so
            // the lock screen waits for this before prompting.
            let active = RcBlock::new(move |_note: NonNull<AnyObject>| {
                hide_cover();
                let _ = app.emit(super::ACTIVE_EVENT, ());
            });

            // The centre keeps the observers (and copies the blocks) for the
            // life of the app; nothing ever removes them.
            let _: *mut AnyObject = msg_send![center, addObserverForName: UIApplicationWillResignActiveNotification, object: ptr::null::<AnyObject>(), queue: queue, usingBlock: &*resign];
            let _: *mut AnyObject = msg_send![center, addObserverForName: UIApplicationDidBecomeActiveNotification, object: ptr::null::<AnyObject>(), queue: queue, usingBlock: &*active];
        }
    }
}

#[cfg(not(any(target_os = "linux", windows, target_os = "ios")))]
mod imp {
    pub fn start(_app: tauri::AppHandle) {}
}
