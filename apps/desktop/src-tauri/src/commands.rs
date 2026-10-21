//! Tauri commands: pinned HTTP transport, TOFU probe, OS keychain secrets.

use crate::tls;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const KEYRING_SERVICE: &str = "com.vault-finance.desktop";

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("keychain error: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("{0}")]
    Other(String),
}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestArgs {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub pinned_fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    pub trusted_by_os: bool,
    /// Why the server couldn't be reached — the full error chain (DNS, refused,
    /// timeout, TLS…), which the startup screen turns into advice.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// HTTP status when something answered but not like a Vault server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

/// reqwest's Display hides the useful part ("connection refused", "dns
/// error") in the source chain; flatten it.
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    while let Some(e) = source {
        let s = e.to_string();
        if !out.contains(&s) {
            out.push_str(": ");
            out.push_str(&s);
        }
        source = e.source();
    }
    out
}

/// All API traffic. With a pin: only that certificate is accepted. Without:
/// normal OS trust validation (proper CA deployments).
#[tauri::command]
pub async fn http_request(args: HttpRequestArgs) -> Result<HttpResponse, CommandError> {
    let client = match &args.pinned_fingerprint {
        Some(fp) => tls::client_with_verifier(Arc::new(tls::PinnedVerifier {
            pinned_fingerprint: fp.clone(),
        }))?,
        None => tls::os_trust_client()?,
    };

    let method = reqwest::Method::from_bytes(args.method.as_bytes())
        .map_err(|e| CommandError::Other(format!("bad method: {e}")))?;
    let mut req = client.request(method, &args.url);
    for (k, v) in &args.headers {
        req = req.header(k, v);
    }
    if let Some(body) = args.body {
        req = req.body(body);
    }

    let res = req.send().await?;
    Ok(HttpResponse {
        status: res.status().as_u16(),
        body: res.text().await?,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<String>,
}

/// Streaming variant of http_request for the AI chat endpoint (ADR-0005):
/// response bytes are pushed over an IPC channel as they arrive, with the
/// same certificate-pinning policy.
#[tauri::command]
pub async fn http_request_stream(
    args: HttpRequestArgs,
    on_chunk: tauri::ipc::Channel<StreamEvent>,
) -> Result<HttpResponse, CommandError> {
    let client = match &args.pinned_fingerprint {
        Some(fp) => tls::client_with_verifier(Arc::new(tls::PinnedVerifier {
            pinned_fingerprint: fp.clone(),
        }))?,
        None => tls::os_trust_client()?,
    };

    let method = reqwest::Method::from_bytes(args.method.as_bytes())
        .map_err(|e| CommandError::Other(format!("bad method: {e}")))?;
    let mut req = client.request(method, &args.url);
    for (k, v) in &args.headers {
        req = req.header(k, v);
    }
    if let Some(body) = args.body {
        req = req.body(body);
    }

    let mut res = req.send().await?;
    let status = res.status().as_u16();
    while let Some(bytes) = res.chunk().await? {
        let _ = on_chunk.send(StreamEvent {
            chunk: Some(String::from_utf8_lossy(&bytes).into_owned()),
        });
    }
    Ok(HttpResponse {
        status,
        body: String::new(),
    })
}

/// TOFU probe: capture the certificate (accept-any verifier — the probe sends
/// nothing sensitive), then check whether the OS trust store would have
/// accepted it so the UI can skip the fingerprint step for real CAs.
#[tauri::command]
pub async fn probe_server(address: String) -> Result<ProbeResult, CommandError> {
    let version_url = format!("{}/api/v1/version", address.trim_end_matches('/'));

    let seen_cert = Arc::new(Mutex::new(None::<Vec<u8>>));
    let capturing = tls::client_with_verifier(Arc::new(tls::CapturingVerifier {
        seen_cert: Arc::clone(&seen_cert),
    }))?;

    let (reachable, error, http_status) = match capturing
        .get(&version_url)
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => (true, None, None),
        Ok(res) => (false, None, Some(res.status().as_u16())),
        Err(e) => (false, Some(error_chain(&e)), None),
    };
    if !reachable {
        return Ok(ProbeResult {
            reachable: false,
            fingerprint: None,
            trusted_by_os: false,
            error,
            http_status,
        });
    }

    let fingerprint = seen_cert
        .lock()
        .unwrap()
        .as_deref()
        .map(tls::fingerprint_hex);

    let trusted_by_os = match tls::os_trust_client() {
        Ok(client) => client.get(&version_url).send().await.is_ok(),
        Err(_) => false,
    };

    Ok(ProbeResult {
        reachable: true,
        fingerprint,
        trusted_by_os,
        error: None,
        http_status: None,
    })
}

// ── Tailscale (src/tailscale.rs). The CLI calls block, so they run on the
//    blocking pool rather than stalling the async runtime. ──

#[tauri::command]
pub async fn tailscale_status() -> Result<crate::tailscale::TailscaleStatus, CommandError> {
    tauri::async_runtime::spawn_blocking(crate::tailscale::status)
        .await
        .map_err(|e| CommandError::Other(e.to_string()))
}

#[tauri::command]
pub async fn tailscale_up() -> Result<crate::tailscale::TailscaleActionResult, CommandError> {
    tauri::async_runtime::spawn_blocking(crate::tailscale::up)
        .await
        .map_err(|e| CommandError::Other(e.to_string()))
}

#[tauri::command]
pub async fn tailscale_down() -> Result<crate::tailscale::TailscaleActionResult, CommandError> {
    tauri::async_runtime::spawn_blocking(crate::tailscale::down)
        .await
        .map_err(|e| CommandError::Other(e.to_string()))
}

/// Open a link in the user's browser (Tailscale sign-in, download pages).
/// https only, so the webview can't use this to launch local files or apps.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), CommandError> {
    let ok = url.starts_with("https://")
        && !url.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '`');
    if !ok {
        return Err(CommandError::Other("only https links can be opened".into()));
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        // rundll32 hands the URL to the default browser without a shell parse.
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x0800_0000)
            .spawn()
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    result
        .map(|_| ())
        .map_err(|e| CommandError::Other(format!("couldn't open the browser: {e}")))
}

/// A launcher that manages this install itself (e.g. an extracted AppImage,
/// which Tauri's updater can't replace) registers via `VF_EXTERNAL_UPDATER`:
/// an absolute path to an executable that understands `update-and-restart`.
/// Only the launching process can set it, never the webview.
fn external_updater() -> Option<std::path::PathBuf> {
    if !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some() {
        return None;
    }
    let path = std::path::PathBuf::from(std::env::var_os("VF_EXTERNAL_UPDATER")?);
    (path.is_absolute() && path.is_file()).then_some(path)
}

#[tauri::command]
pub fn external_updater_available() -> bool {
    external_updater().is_some()
}

/// Hand the update to the external updater and quit: it waits for this
/// process to exit, installs the verified release, then starts the app again.
#[tauri::command]
pub fn run_external_updater(app: tauri::AppHandle) -> Result<(), CommandError> {
    let path = external_updater()
        .ok_or_else(|| CommandError::Other("no external updater registered".into()))?;
    std::process::Command::new(&path)
        .arg("update-and-restart")
        .spawn()
        .map_err(|e| CommandError::Other(format!("couldn't start the updater: {e}")))?;
    app.exit(0);
    Ok(())
}

/// Reveal the pre-declared, normally-hidden admin console window. Its webview
/// is a separate capability group (`admin.json`) so a fault in the main window
/// can't reach it and vice-versa.
#[tauri::command]
pub fn open_admin_window(app: tauri::AppHandle) -> Result<(), CommandError> {
    use tauri::Manager;
    let window = app
        .get_webview_window("admin")
        .ok_or_else(|| CommandError::Other("admin window not found".into()))?;
    window
        .show()
        .and_then(|_| window.unminimize())
        .and_then(|_| window.set_focus())
        .map_err(|e| CommandError::Other(e.to_string()))
}

// ── Secrets: OS keychain (macOS Keychain, Windows Credential Manager,
//    Secret Service on Linux). Refresh tokens never touch plain files. ──

#[tauri::command]
pub fn get_secret(key: String) -> Result<Option<String>, CommandError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn set_secret(key: String, value: String) -> Result<(), CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, &key)?.set_password(&value)?;
    Ok(())
}

#[tauri::command]
pub fn delete_secret(key: String) -> Result<(), CommandError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
