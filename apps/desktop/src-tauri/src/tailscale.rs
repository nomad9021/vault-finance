//! Tailscale control from inside the app: read the status, turn it on/off.
//!
//! Drives the official `tailscale` CLI rather than the daemon's local API:
//! the CLI already knows how to reach tailscaled on every OS (unix socket,
//! named pipe, the macOS app's sandboxed socket) and how to authorise the
//! caller, so this stays a thin, auditable wrapper. Nothing here needs
//! Tauri, which keeps it testable on its own.

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    /// The CLI was found on this computer.
    pub installed: bool,
    /// "Running" | "Stopped" | "NeedsLogin" | "NeedsMachineAuth" | "Starting"
    /// | "NoState" | "DaemonDown" | "NotInstalled" | "Unknown"
    pub state: String,
    /// This device's Tailscale addresses (100.x / fd7a:…).
    pub ips: Vec<String>,
    /// This device's MagicDNS name, without the trailing dot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dns_name: Option<String>,
    /// Login link while state is NeedsLogin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_url: Option<String>,
    /// Problems tailscaled itself reports (e.g. "not connected to a DERP relay").
    pub health: Vec<String>,
    /// Plain-language reason when the status couldn't be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleActionResult {
    pub ok: bool,
    pub status: TailscaleStatus,
    /// What happened, phrased for the user (always set when ok is false).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Locate the CLI: well-known install paths first, then PATH.
pub fn find_cli() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    candidates.extend(
        [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
        ]
        .map(PathBuf::from),
    );
    #[cfg(windows)]
    {
        for var in ["ProgramFiles", "ProgramW6432"] {
            if let Some(dir) = std::env::var_os(var) {
                candidates.push(PathBuf::from(dir).join("Tailscale").join("tailscale.exe"));
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    candidates.extend(
        ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale", "/snap/bin/tailscale"]
            .map(PathBuf::from),
    );
    if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(found);
    }
    let exe = if cfg!(windows) { "tailscale.exe" } else { "tailscale" };
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(exe))
            .find(|p| p.is_file())
    })
}

fn command(program: &std::path::Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // no console flash
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run to completion, but give up (and kill the child) after `limit`.
fn run(mut cmd: Command, limit: Duration) -> std::io::Result<Output> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            return child.wait_with_output();
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn text(out: &Output) -> String {
    let mut s = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !stdout.trim().is_empty() {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str(stdout.trim());
    }
    s
}

fn not_installed() -> TailscaleStatus {
    TailscaleStatus {
        installed: false,
        state: "NotInstalled".into(),
        ips: vec![],
        dns_name: None,
        auth_url: None,
        health: vec![],
        error: None,
    }
}

/// Parse `tailscale status --json`. Only this device's own details are kept —
/// the peer list never leaves this function.
pub fn parse_status(json: &str) -> Result<TailscaleStatus, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("unreadable status: {e}"))?;
    let state = v["BackendState"].as_str().unwrap_or("Unknown").to_string();
    let ips = v["TailscaleIPs"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let dns_name = v["Self"]["DNSName"]
        .as_str()
        .map(|s| s.trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty());
    let auth_url = v["AuthURL"].as_str().map(String::from).filter(|s| !s.is_empty());
    let health = v["Health"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    Ok(TailscaleStatus {
        installed: true,
        state,
        ips,
        dns_name,
        auth_url,
        health,
        error: None,
    })
}

pub fn status() -> TailscaleStatus {
    let Some(cli) = find_cli() else {
        return not_installed();
    };
    let mut cmd = command(&cli);
    cmd.args(["status", "--json"]);
    match run(cmd, Duration::from_secs(8)) {
        // `status` exits non-zero when stopped/logged out but still prints JSON.
        Ok(out) if !out.stdout.is_empty() => {
            parse_status(&String::from_utf8_lossy(&out.stdout)).unwrap_or_else(|e| unknown(e))
        }
        Ok(out) => {
            let t = text(&out);
            if is_daemon_down(&t) {
                TailscaleStatus {
                    state: "DaemonDown".into(),
                    error: Some("The Tailscale service isn't running on this computer.".into()),
                    ..unknown(String::new())
                }
            } else {
                unknown(t)
            }
        }
        Err(e) => unknown(format!("couldn't run tailscale: {e}")),
    }
}

fn unknown(error: String) -> TailscaleStatus {
    TailscaleStatus {
        installed: true,
        state: "Unknown".into(),
        ips: vec![],
        dns_name: None,
        auth_url: None,
        health: vec![],
        error: if error.is_empty() { None } else { Some(error) },
    }
}

fn is_daemon_down(t: &str) -> bool {
    let t = t.to_lowercase();
    t.contains("failed to connect to local tailscale")
        || t.contains("is tailscaled running")
        || t.contains("tailscaled.sock: connect")
}

fn is_access_denied(t: &str) -> bool {
    let t = t.to_lowercase();
    t.contains("access denied") || t.contains("use 'sudo tailscale") || t.contains("permission denied")
}

/// When prefs were set with flags, a bare `tailscale up` refuses and prints the
/// exact command to use instead. Pull those arguments out so we can re-run it.
pub fn suggested_up_args(t: &str) -> Option<Vec<String>> {
    if !t.contains("requires mentioning all") {
        return None;
    }
    let line = t.lines().map(str::trim).rev().find(|l| l.starts_with("tailscale up"))?;
    let args: Vec<String> = line.split_whitespace().skip(1).map(String::from).collect();
    // Only flags tailscale itself suggested; never anything that isn't a flag.
    if args.first().map(String::as_str) != Some("up") || args.iter().skip(1).any(|a| !a.starts_with("--")) {
        return None;
    }
    Some(args)
}

/// On Linux, a one-time "make me the operator" so later on/off needs no root.
/// Uses polkit's graphical prompt (pkexec); returns false if it's unavailable
/// or the user cancelled.
#[cfg(all(unix, not(target_os = "macos")))]
fn become_operator(cli: &std::path::Path) -> bool {
    let Some(user) = std::env::var_os("USER") else {
        return false;
    };
    let mut arg = std::ffi::OsString::from("--operator=");
    arg.push(user);
    let mut cmd = Command::new("pkexec");
    cmd.arg(cli).arg("set").arg(arg).stdin(Stdio::null());
    matches!(run(cmd, Duration::from_secs(120)), Ok(out) if out.status.success())
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn become_operator(_cli: &std::path::Path) -> bool {
    false
}

fn up_once(cli: &std::path::Path, args: &[String]) -> std::io::Result<Output> {
    let mut cmd = command(cli);
    cmd.args(args).arg("--timeout=20s");
    run(cmd, Duration::from_secs(30))
}

/// Turn Tailscale on. If this device needs to sign in, `tailscale up` is left
/// running in the background (it finishes once the browser login completes)
/// and the returned status carries the login link.
pub fn up() -> TailscaleActionResult {
    let Some(cli) = find_cli() else {
        return TailscaleActionResult {
            ok: false,
            status: not_installed(),
            message: Some("Tailscale isn't installed on this computer.".into()),
        };
    };
    let before = status();
    if before.state == "Running" {
        return TailscaleActionResult { ok: true, status: before, message: None };
    }
    if before.state == "DaemonDown" {
        return TailscaleActionResult {
            ok: false,
            message: Some(daemon_down_message()),
            status: before,
        };
    }
    if before.state == "NeedsLogin" || before.state == "NoState" {
        return start_login(&cli);
    }

    let mut args = vec!["up".to_string()];
    let mut out = up_once(&cli, &args);
    for _ in 0..2 {
        let Ok(o) = &out else { break };
        if o.status.success() {
            break;
        }
        let t = text(o);
        if let Some(suggested) = suggested_up_args(&t) {
            args = suggested;
        } else if is_access_denied(&t) && become_operator(&cli) {
            // retry the same command now that we're the operator
        } else {
            break;
        }
        out = up_once(&cli, &args);
    }

    let after = status();
    match out {
        Ok(o) if o.status.success() || after.state == "Running" => {
            TailscaleActionResult { ok: true, status: after, message: None }
        }
        Ok(o) => {
            let t = text(&o);
            let message = if is_access_denied(&t) {
                access_denied_message()
            } else if after.state == "NeedsLogin" {
                return start_login(&cli);
            } else {
                format!("Tailscale didn't start: {}", first_line(&t))
            };
            TailscaleActionResult { ok: false, status: after, message: Some(message) }
        }
        Err(e) => TailscaleActionResult {
            ok: false,
            status: after,
            message: Some(format!("Couldn't run Tailscale: {e}")),
        },
    }
}

/// Start `tailscale up` without waiting and poll until it reports the login URL.
fn start_login(cli: &std::path::Path) -> TailscaleActionResult {
    let mut cmd = command(cli);
    cmd.arg("up").stdout(Stdio::null()).stderr(Stdio::null());
    if let Err(e) = cmd.spawn() {
        return TailscaleActionResult {
            ok: false,
            status: status(),
            message: Some(format!("Couldn't start Tailscale sign-in: {e}")),
        };
    }
    let started = Instant::now();
    let mut s = status();
    while s.auth_url.is_none() && s.state != "Running" && started.elapsed() < Duration::from_secs(15) {
        std::thread::sleep(Duration::from_millis(500));
        s = status();
    }
    let ok = s.state == "Running" || s.auth_url.is_some();
    TailscaleActionResult {
        ok,
        message: if s.auth_url.is_some() {
            Some("Sign in to Tailscale in your browser to finish connecting.".into())
        } else if ok {
            None
        } else {
            Some("Tailscale needs you to sign in, but didn't provide a login link. Open the Tailscale app to sign in.".into())
        },
        status: s,
    }
}

pub fn down() -> TailscaleActionResult {
    let Some(cli) = find_cli() else {
        return TailscaleActionResult { ok: true, status: not_installed(), message: None };
    };
    let mut cmd = command(&cli);
    cmd.arg("down");
    let mut out = run(cmd, Duration::from_secs(15));
    if let Ok(o) = &out {
        if !o.status.success() && is_access_denied(&text(o)) && become_operator(&cli) {
            let mut cmd = command(&cli);
            cmd.arg("down");
            out = run(cmd, Duration::from_secs(15));
        }
    }
    let after = status();
    match out {
        Ok(o) if o.status.success() => TailscaleActionResult { ok: true, status: after, message: None },
        Ok(o) => {
            let t = text(&o);
            TailscaleActionResult {
                ok: false,
                status: after,
                message: Some(if is_access_denied(&t) {
                    access_denied_message()
                } else {
                    format!("Tailscale didn't stop: {}", first_line(&t))
                }),
            }
        }
        Err(e) => TailscaleActionResult {
            ok: false,
            status: after,
            message: Some(format!("Couldn't run Tailscale: {e}")),
        },
    }
}

fn first_line(t: &str) -> String {
    t.lines().find(|l| !l.trim().is_empty()).unwrap_or("unknown error").trim().chars().take(200).collect()
}

fn daemon_down_message() -> String {
    if cfg!(windows) || cfg!(target_os = "macos") {
        "The Tailscale service isn't running. Open the Tailscale app once, then try again.".into()
    } else {
        "The Tailscale service isn't running. Start it with: sudo systemctl enable --now tailscaled".into()
    }
}

fn access_denied_message() -> String {
    if cfg!(all(unix, not(target_os = "macos"))) {
        "This account isn't allowed to control Tailscale. Run once in a terminal: sudo tailscale set --operator=$USER".into()
    } else {
        "This account isn't allowed to control Tailscale. Turn it on from the Tailscale app instead.".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_own_status_and_drops_peers() {
        let s = parse_status(
            r#"{"BackendState":"Running","TailscaleIPs":["100.64.0.5","fd7a::5"],
                "Self":{"DNSName":"laptop.example.ts.net."},"AuthURL":"","Health":[],
                "Peer":{"k":{"DNSName":"other."}}}"#,
        )
        .unwrap();
        assert_eq!(s.state, "Running");
        assert_eq!(s.ips, vec!["100.64.0.5", "fd7a::5"]);
        assert_eq!(s.dns_name.as_deref(), Some("laptop.example.ts.net"));
        assert!(s.auth_url.is_none());
    }

    #[test]
    fn reads_login_url() {
        let s = parse_status(r#"{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/x","Self":{}}"#)
            .unwrap();
        assert_eq!(s.auth_url.as_deref(), Some("https://login.tailscale.com/a/x"));
    }

    #[test]
    fn extracts_suggested_command() {
        let msg = "Error: changing settings via 'tailscale up' requires mentioning all\n\
                   non-default flags. To proceed, either re-run your command with --reset or\n\
                   use the command below:\n\n\ttailscale up --accept-routes --operator=sam\n";
        assert_eq!(
            suggested_up_args(msg).unwrap(),
            vec!["up", "--accept-routes", "--operator=sam"]
        );
        assert!(suggested_up_args("\ttailscale up; rm -rf /\nrequires mentioning all").is_none());
    }
}
