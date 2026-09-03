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

    let reachable = match capturing.get(&version_url).send().await {
        Ok(res) => res.status().is_success(),
        Err(_) => false,
    };
    if !reachable {
        return Ok(ProbeResult {
            reachable: false,
            fingerprint: None,
            trusted_by_os: false,
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
    })
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
