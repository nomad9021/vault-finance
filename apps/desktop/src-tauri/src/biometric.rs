//! Biometric user-presence check: Windows Hello, Touch ID, or a fingerprint
//! reader via fprintd on Linux.
//!
//! This is a local gate only — it answers "is the device owner here right
//! now?". The credential it unlocks (a per-device sign-in key issued by the
//! server) lives in the OS keychain next to the refresh tokens, and the server
//! can revoke it at any time. Nothing biometric ever leaves the OS.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricStatus {
    pub available: bool,
    /// What to call it in the UI: "Windows Hello", "Touch ID", "Fingerprint".
    pub label: String,
    /// Why it's unavailable, in words the user can act on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum BiometricError {
    #[error("cancelled")]
    Cancelled,
    #[error("not recognized")]
    Failed,
    #[error("{0}")]
    Unavailable(String),
}

impl Serialize for BiometricError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        // The frontend switches on these prefixes, not free text.
        s.serialize_str(&match self {
            BiometricError::Cancelled => "cancelled".to_string(),
            BiometricError::Failed => "failed".to_string(),
            BiometricError::Unavailable(why) => format!("unavailable: {why}"),
        })
    }
}

#[tauri::command]
pub async fn biometric_status() -> BiometricStatus {
    imp::status().await
}

#[tauri::command]
pub async fn biometric_authenticate(
    window: tauri::WebviewWindow,
    reason: String,
) -> Result<(), BiometricError> {
    imp::authenticate(&window, &reason).await
}

/// Abort an in-progress fingerprint scan (Linux only — Windows Hello and
/// Touch ID draw their own dialog with a Cancel button).
#[tauri::command]
pub fn biometric_cancel() {
    #[cfg(target_os = "linux")]
    imp::CANCEL.notify(usize::MAX);
}

fn unavailable(label: &str, reason: impl Into<String>) -> BiometricStatus {
    BiometricStatus {
        available: false,
        label: label.into(),
        reason: Some(reason.into()),
    }
}

fn available(label: &str) -> BiometricStatus {
    BiometricStatus {
        available: true,
        label: label.into(),
        reason: None,
    }
}

// ── Windows: Windows Hello (face, fingerprint, or PIN) ──

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::{factory, HSTRING};
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows_future::IAsyncOperation;

    const LABEL: &str = "Windows Hello";

    pub async fn status() -> BiometricStatus {
        tauri::async_runtime::spawn_blocking(|| {
            let availability = UserConsentVerifier::CheckAvailabilityAsync()
                .and_then(|op| op.get())
                .unwrap_or(UserConsentVerifierAvailability::DeviceNotPresent);
            match availability {
                UserConsentVerifierAvailability::Available => available(LABEL),
                UserConsentVerifierAvailability::NotConfiguredForUser => unavailable(
                    LABEL,
                    "Windows Hello isn't set up — add a face, fingerprint or PIN in Settings → Accounts → Sign-in options.",
                ),
                UserConsentVerifierAvailability::DisabledByPolicy => {
                    unavailable(LABEL, "Windows Hello is disabled by your organization's policy.")
                }
                _ => unavailable(LABEL, "No Windows Hello device found on this PC."),
            }
        })
        .await
        .unwrap_or_else(|_| unavailable(LABEL, "Couldn't check Windows Hello."))
    }

    pub async fn authenticate(
        window: &tauri::WebviewWindow,
        reason: &str,
    ) -> Result<(), BiometricError> {
        // Parent the prompt to our window; the plain RequestVerificationAsync
        // often opens behind the app with no taskbar entry.
        let hwnd = window
            .hwnd()
            .map_err(|e| BiometricError::Unavailable(e.to_string()))?
            .0 as isize;
        let reason = reason.to_owned();
        tauri::async_runtime::spawn_blocking(move || {
            let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                .map_err(|e| BiometricError::Unavailable(e.message().to_string()))?;
            let op: IAsyncOperation<UserConsentVerificationResult> = unsafe {
                interop.RequestVerificationForWindowAsync(HWND(hwnd as _), &HSTRING::from(reason))
            }
            .map_err(|e| BiometricError::Unavailable(e.message().to_string()))?;
            match op.get() {
                Ok(UserConsentVerificationResult::Verified) => Ok(()),
                Ok(UserConsentVerificationResult::Canceled) => Err(BiometricError::Cancelled),
                Ok(UserConsentVerificationResult::RetriesExhausted) => Err(BiometricError::Failed),
                Ok(_) => Err(BiometricError::Unavailable(
                    "Windows Hello isn't available right now.".into(),
                )),
                Err(e) => Err(BiometricError::Unavailable(e.message().to_string())),
            }
        })
        .await
        .map_err(|e| BiometricError::Unavailable(e.to_string()))?
    }
}

// ── macOS: Touch ID ──

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};

    const LABEL: &str = "Touch ID";
    const POLICY: LAPolicy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;

    // LAError codes (LAError.h) that mean "the user backed out", not "wrong finger".
    const LA_USER_CANCEL: isize = -2;
    const LA_USER_FALLBACK: isize = -3;
    const LA_SYSTEM_CANCEL: isize = -4;
    const LA_APP_CANCEL: isize = -9;
    const LA_BIOMETRY_NOT_ENROLLED: isize = -7;

    #[allow(unused_unsafe)]
    pub async fn status() -> BiometricStatus {
        let ctx = unsafe { LAContext::new() };
        match unsafe { ctx.canEvaluatePolicy_error(POLICY) } {
            Ok(()) => available(LABEL),
            Err(err) if err.code() == LA_BIOMETRY_NOT_ENROLLED => unavailable(
                LABEL,
                "Touch ID isn't set up — add a fingerprint in System Settings → Touch ID & Password.",
            ),
            Err(_) => unavailable(LABEL, "This Mac doesn't have Touch ID available."),
        }
    }

    #[allow(unused_unsafe)]
    pub async fn authenticate(
        _window: &tauri::WebviewWindow,
        reason: &str,
    ) -> Result<(), BiometricError> {
        let reason = reason.to_owned();
        // LAContext and the reply block aren't Send, so the whole exchange
        // lives on one blocking thread; the reply arrives on a
        // LocalAuthentication-owned queue and is handed back over a channel.
        tauri::async_runtime::spawn_blocking(move || {
            let (tx, rx) = std::sync::mpsc::channel::<Result<(), BiometricError>>();
            let ctx = unsafe { LAContext::new() };
            let reply = RcBlock::new(move |ok: Bool, err: *mut NSError| {
                let outcome = if ok.as_bool() {
                    Ok(())
                } else {
                    match unsafe { err.as_ref() }.map(|e| e.code()) {
                        Some(
                            LA_USER_CANCEL | LA_USER_FALLBACK | LA_SYSTEM_CANCEL | LA_APP_CANCEL,
                        ) => Err(BiometricError::Cancelled),
                        _ => Err(BiometricError::Failed),
                    }
                };
                let _ = tx.send(outcome);
            });
            unsafe {
                ctx.evaluatePolicy_localizedReason_reply(
                    POLICY,
                    &NSString::from_str(&reason),
                    &reply,
                )
            };
            rx.recv()
                .unwrap_or(Err(BiometricError::Unavailable("Touch ID stopped responding.".into())))
        })
        .await
        .map_err(|e| BiometricError::Unavailable(e.to_string()))?
    }
}

// ── Linux: fingerprint reader via fprintd (net.reactivated.Fprint on the system bus) ──

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use event_listener::Event;
    use futures_lite::{future, StreamExt};
    use std::time::Duration;
    use zbus::zvariant::OwnedObjectPath;
    use zbus::{Connection, Proxy};

    const LABEL: &str = "Fingerprint";
    const DEST: &str = "net.reactivated.Fprint";
    const DEVICE_IFACE: &str = "net.reactivated.Fprint.Device";
    /// fprintd itself never times out; don't leave the reader claimed forever.
    const SCAN_TIMEOUT: Duration = Duration::from_secs(30);

    pub static CANCEL: Event = Event::new();

    async fn device(conn: &Connection) -> Result<Proxy<'static>, String> {
        let manager = Proxy::new(
            conn,
            DEST,
            "/net/reactivated/Fprint/Manager",
            "net.reactivated.Fprint.Manager",
        )
        .await
        .map_err(|e| e.to_string())?;
        let path: OwnedObjectPath = manager
            .call("GetDefaultDevice", &())
            .await
            .map_err(|_| "No supported fingerprint reader found.".to_string())?;
        Proxy::new(conn, DEST, path, DEVICE_IFACE)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn status() -> BiometricStatus {
        let Ok(conn) = Connection::system().await else {
            return unavailable(LABEL, "Can't reach the system bus.");
        };
        let dev = match device(&conn).await {
            Ok(d) => d,
            Err(_) => {
                return unavailable(
                    LABEL,
                    "No supported fingerprint reader found (needs fprintd and a libfprint-supported reader).",
                )
            }
        };
        // "" = the user this process runs as.
        match dev.call::<_, _, Vec<String>>("ListEnrolledFingers", &("",)).await {
            Ok(fingers) if !fingers.is_empty() => available(LABEL),
            _ => unavailable(
                LABEL,
                "No fingerprints enrolled — add one in your desktop's user settings (or `fprintd-enroll`).",
            ),
        }
    }

    pub async fn authenticate(
        _window: &tauri::WebviewWindow,
        _reason: &str,
    ) -> Result<(), BiometricError> {
        let conn = Connection::system()
            .await
            .map_err(|e| BiometricError::Unavailable(e.to_string()))?;
        let dev = device(&conn).await.map_err(BiometricError::Unavailable)?;
        dev.call::<_, _, ()>("Claim", &("",))
            .await
            .map_err(|e| BiometricError::Unavailable(format!("fingerprint reader is busy: {e}")))?;

        let scan = async {
            // Subscribe before starting so the first status can't be missed.
            let mut statuses = dev
                .receive_signal("VerifyStatus")
                .await
                .map_err(|e| BiometricError::Unavailable(e.to_string()))?;
            dev.call::<_, _, ()>("VerifyStart", &("any",))
                .await
                .map_err(|e| BiometricError::Unavailable(e.to_string()))?;
            while let Some(msg) = statuses.next().await {
                let Ok((result, done)) = msg.body().deserialize::<(String, bool)>() else {
                    continue;
                };
                match result.as_str() {
                    "verify-match" => return Ok(()),
                    "verify-no-match" => return Err(BiometricError::Failed),
                    // verify-retry-scan / -swipe-too-short / -finger-not-centered /
                    // -remove-and-retry: the reader keeps going.
                    _ if !done => continue,
                    _ => {
                        return Err(BiometricError::Unavailable(format!(
                            "fingerprint reader error ({result})"
                        )))
                    }
                }
            }
            Err(BiometricError::Unavailable("fingerprint reader went away".into()))
        };
        let cancelled = async {
            CANCEL.listen().await;
            Err(BiometricError::Cancelled)
        };
        let timed_out = async {
            async_io::Timer::after(SCAN_TIMEOUT).await;
            Err(BiometricError::Cancelled)
        };
        let outcome = future::or(scan, future::or(cancelled, timed_out)).await;

        // Always hand the reader back, whatever happened above.
        let _ = dev.call::<_, _, ()>("VerifyStop", &()).await;
        let _ = dev.call::<_, _, ()>("Release", &()).await;
        outcome
    }
}

// ── Anything else (iOS is Phase 2 and will use tauri-plugin-biometric) ──

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod imp {
    use super::*;

    pub async fn status() -> BiometricStatus {
        unavailable("Biometrics", "Not supported on this platform yet.")
    }

    pub async fn authenticate(
        _window: &tauri::WebviewWindow,
        _reason: &str,
    ) -> Result<(), BiometricError> {
        Err(BiometricError::Unavailable("Not supported on this platform yet.".into()))
    }
}
