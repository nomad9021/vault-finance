//! apps/desktop/src/lib/startupChecks.ts: the startup screen's health
//! checks, in the order a connection depends on them (this computer →
//! private network → reaching the server → its identity → versions → the
//! server's components → signed-in details).
//!
//! `runChecks` is async in the shell; here it's [`CheckRun`], one method per
//! step, so the Rust shell can await each host call in between and show the
//! rows after every step. A step returning `false` means stop.

use serde::{Deserialize, Serialize};

use crate::platform::{HostKind, PrivateNetworkId, ProbeResult, TailscaleStatus};
use crate::serde_util::js_slice_to;
use crate::server_route::Picked;
use crate::status::{ServerStatusResponse, StatusCheck, StatusDetailsResponse, StatusLevel};
use crate::updates::{compare_semver, VersionResponse};
use crate::url::Url;

pub const TAILSCALE_DOWNLOAD_URL: &str = "https://tailscale.com/download";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckAction {
    TailscaleUp,
    TailscaleLogin,
    TailscaleInstall,
    ChangeServer,
    UpdateApp,
}

/// A row's level: a server [`StatusLevel`], or still running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UiLevel {
    Ok,
    Warn,
    Error,
    Off,
    Pending,
}

impl From<StatusLevel> for UiLevel {
    fn from(l: StatusLevel) -> Self {
        match l {
            StatusLevel::Ok => Self::Ok,
            StatusLevel::Warn => Self::Warn,
            StatusLevel::Error => Self::Error,
            StatusLevel::Off => Self::Off,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiCheck {
    pub id: String,
    pub label: String,
    pub level: UiLevel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<CheckAction>,
}

impl UiCheck {
    fn new(id: &str, label: &str, level: UiLevel) -> Self {
        UiCheck {
            id: id.into(),
            label: label.into(),
            level,
            detail: None,
            hint: None,
            action: None,
        }
    }
    fn detail(mut self, d: impl Into<String>) -> Self {
        self.detail = Some(d.into());
        self
    }
    fn hint(mut self, h: impl Into<String>) -> Self {
        self.hint = Some(h.into());
        self
    }
    fn action(mut self, a: CheckAction) -> Self {
        self.action = Some(a);
        self
    }
}

/// Tailscale addresses: 100.64.0.0/10, fd7a:115c:a1e0::/48, or *.ts.net.
pub fn looks_like_tailnet(address: &str) -> bool {
    let Some(u) = Url::parse(address) else {
        return false;
    };
    let h = u.hostname.trim_start_matches('[').trim_end_matches(']');
    if h.ends_with(".ts.net") || h.starts_with("fd7a:115c:a1e0:") {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    parts.len() == 4
        && parts[0] == "100"
        && parts[1..]
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && parts[1]
            .parse::<u64>()
            .is_ok_and(|b| (64..=127).contains(&b))
}

/// The host and port to name in messages.
pub fn host_port(address: &str) -> (String, String) {
    match Url::parse(address) {
        Some(u) => {
            let port = u.port.map_or_else(
                || {
                    if u.scheme == "https" {
                        "443".into()
                    } else {
                        "80".into()
                    }
                },
                |p| p.to_string(),
            );
            (u.hostname, port)
        }
        None => (address.into(), "8443".into()),
    }
}

fn mentions(e: &str, words: &[&str]) -> bool {
    words.iter().any(|w| e.contains(w))
}

/// Turn a failed probe into what happened (`detail`) and what to try (`hint`).
pub fn describe_probe_failure(
    probe: &ProbeResult,
    address: &str,
    network: PrivateNetworkId,
) -> (String, String) {
    let (host, port) = host_port(address);
    let vpn = network.network_name();
    if let Some(status) = probe.http_status {
        return (
            format!("Something answered at {host}:{port}, but it isn't a Vault Finance server (HTTP {status})."),
            "Check the port number — the Vault server uses 8443 unless you changed it.".into(),
        );
    }
    let e = probe.error.as_deref().unwrap_or("").to_lowercase();
    if mentions(
        &e,
        &[
            "dns error",
            "failed to lookup",
            "name or service not known",
            "no such host",
            "nodename nor servname",
            "name resolution",
        ],
    ) {
        return (
            format!("Couldn't find a computer called “{host}”."),
            format!(
                "Check the spelling, or use the server's IP address.{}",
                vpn.map(|v| format!(" If it's a name on {v}, {v} has to be on."))
                    .unwrap_or_default()
            ),
        );
    }
    if mentions(&e, &["connection refused", "actively refused"]) {
        return (
            format!("{host} answered, but the Vault server isn't running on port {port}."),
            "On the server machine, start it from the vault-finance/docker folder with: docker compose up -d".into(),
        );
    }
    if mentions(
        &e,
        &[
            "timed out",
            "timeout",
            "deadline",
            "no route to host",
            "network is unreachable",
            "host is unreachable",
        ],
    ) {
        let hint = if looks_like_tailnet(address) {
            format!(
                "This address only works through {}. Turn it on, or choose Change server and use the server's home network address.",
                vpn.unwrap_or("a VPN")
            )
        } else {
            format!(
                "Make sure the server machine is switched on.{}",
                vpn.map(|v| format!(" If you reach it through {v}, make sure that's connected."))
                    .unwrap_or_default()
            )
        };
        return (format!("No answer from {host}."), hint);
    }
    if mentions(&e, &["certificate", "tls", "handshake", "ssl"]) {
        return (
            "A secure connection to the server couldn't be set up.".into(),
            "Make sure the address starts with https://, then try again. If it keeps happening, check the server's certificate.".into(),
        );
    }
    (
        format!("Couldn't reach the server at {host}:{port}."),
        match probe.error.as_deref().filter(|e| !e.is_empty()) {
            Some(err) => format!("Details: {}", js_slice_to(err, 160)),
            None => "Check the address and that the server is running.".into(),
        },
    )
}

/// The Tailscale row. Being off is normal, so it never blocks; `server_down`
/// raises it to a likely culprit.
pub fn tailscale_check(
    ts: &TailscaleStatus,
    address: &str,
    server_down: bool,
    label: &str,
) -> UiCheck {
    let needed = looks_like_tailnet(address);
    let not_needed = "Not needed right now: the server is reachable.";
    let row = |level| UiCheck::new("tailscale", label, level);
    if !ts.installed {
        return if server_down && needed {
            row(UiLevel::Warn)
                .detail(format!("This server's address is on {label}, but Tailscale isn't installed on this computer."))
                .hint("Install Tailscale and sign in with the same account as the server.")
                .action(CheckAction::TailscaleInstall)
        } else {
            row(UiLevel::Off).detail("Not installed.")
        };
    }
    match ts.state.as_str() {
        "Running" => {
            let ip = ts.ips.iter().find(|i| !i.contains(':')).or(ts.ips.first());
            let name = ts.dns_name.as_deref().and_then(|d| d.split('.').next());
            let who = [name, ip.map(String::as_str)]
                .into_iter()
                .flatten()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
            let who = if who.is_empty() {
                String::new()
            } else {
                format!(" ({who})")
            };
            match ts.health.first() {
                Some(problem) => row(UiLevel::Warn)
                    .detail(format!("Connected{who}, with a problem."))
                    .hint(problem.clone()),
                None => row(UiLevel::Ok).detail(format!("Connected{who}.")),
            }
        }
        "NeedsLogin" | "NeedsMachineAuth" => {
            if !server_down {
                return row(UiLevel::Off).detail(format!("Signed out. {not_needed}"));
            }
            let c = row(UiLevel::Warn)
                .detail(if ts.state == "NeedsMachineAuth" {
                    format!("This computer is waiting for approval in your {label} admin console.")
                } else {
                    format!("{label} needs you to sign in.")
                })
                .hint(format!(
                    "Sign in with the same {label} account as your server."
                ));
            if ts.state == "NeedsLogin" {
                c.action(CheckAction::TailscaleLogin)
            } else {
                c
            }
        }
        "DaemonDown" => {
            if !server_down {
                return row(UiLevel::Off).detail(format!("Service not running. {not_needed}"));
            }
            row(UiLevel::Warn)
                .detail(
                    ts.error
                        .clone()
                        .unwrap_or_else(|| "The Tailscale service isn't running.".into()),
                )
                .hint("Start the Tailscale app (or the tailscaled service), then retry.")
        }
        "Starting" => row(if server_down {
            UiLevel::Warn
        } else {
            UiLevel::Off
        })
        .detail("Connecting…"),
        _ => {
            if server_down {
                row(UiLevel::Warn)
                    .detail(if needed {
                        format!("{label} is off, and this server's address only works through it.")
                    } else {
                        format!("{label} is off. If your server is on {label}, that's why it can't be reached.")
                    })
                    .action(CheckAction::TailscaleUp)
            } else {
                row(UiLevel::Off)
                    .detail(format!("Off. {not_needed}"))
                    .action(CheckAction::TailscaleUp)
            }
        }
    }
}

fn from_server(c: &StatusCheck) -> UiCheck {
    UiCheck {
        id: c.id.clone(),
        label: c.label.clone(),
        level: c.level.into(),
        detail: c.detail.clone().filter(|d| !d.is_empty()),
        hint: c.hint.clone().filter(|h| !h.is_empty()),
        action: None,
    }
}

/// How the version check failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestFailure {
    /// An `ApiRequestError`: its message and HTTP status.
    Api { message: String, status: u16 },
    /// Anything else (network, parse).
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckOutcome {
    pub checks: Vec<UiCheck>,
    /// Something blocks opening the app (any error row).
    pub blocked: bool,
    pub probe: Option<ProbeResult>,
    pub tailscale: Option<TailscaleStatus>,
}

/// One run of the checks. Read [`CheckRun::checks`] after each step to show progress.
#[derive(Debug, Clone)]
pub struct CheckRun {
    checks: Vec<UiCheck>,
    primary: String,
    alternate: Option<String>,
    network: PrivateNetworkId,
    can_read_network: bool,
    probe: Option<ProbeResult>,
    address: Option<String>,
    tailscale: Option<TailscaleStatus>,
}

impl CheckRun {
    /// The "This computer" row. `has_tailscale_status` = the host can read Tailscale.
    pub fn new(
        keychain_ok: bool,
        primary: &str,
        alternate: Option<&str>,
        network: PrivateNetworkId,
        has_tailscale_status: bool,
    ) -> Self {
        let mut run = CheckRun {
            checks: Vec::new(),
            primary: primary.into(),
            alternate: alternate.filter(|a| !a.is_empty()).map(Into::into),
            network,
            can_read_network: network.uses_tailscale_client() && has_tailscale_status,
            probe: None,
            address: None,
            tailscale: None,
        };
        run.put(if keychain_ok {
            UiCheck::new("device", "This computer", UiLevel::Ok)
                .detail("Secure storage is available.")
        } else {
            UiCheck::new("device", "This computer", UiLevel::Warn)
                .detail("Couldn't open the system keychain.")
                .hint("Vault Finance will work, but you'll have to sign in each time you open it.")
        });
        run
    }

    pub fn checks(&self) -> &[UiCheck] {
        &self.checks
    }

    fn put(&mut self, c: UiCheck) {
        match self.checks.iter_mut().find(|x| x.id == c.id) {
            Some(slot) => *slot = c,
            None => self.checks.push(c),
        }
    }

    /// Whether to ask the host for Tailscale status alongside the probe.
    pub fn wants_tailscale(&self) -> bool {
        self.can_read_network
    }

    /// Pending rows while Tailscale status and the probes run side by side.
    pub fn begin_probe(&mut self) {
        if self.can_read_network {
            self.put(UiCheck::new(
                "tailscale",
                self.network.label(),
                UiLevel::Pending,
            ));
        }
        let (host, _) = host_port(&self.primary);
        self.put(UiCheck::new("server", "Server connection", UiLevel::Pending).detail(host));
    }

    /// The probe result (and Tailscale status, `None` if it failed or wasn't
    /// read). Returns the address to route to (the shell's `onRoute`, which
    /// must run before any request), and whether to go on.
    pub fn after_probe(
        &mut self,
        tailscale: Option<TailscaleStatus>,
        picked: Picked,
    ) -> (Option<String>, bool) {
        let reachable = picked.probe.reachable;
        let route = reachable.then(|| picked.address.clone());
        let label = self.network.label();
        let vpn_address = match &self.alternate {
            Some(a) if looks_like_tailnet(a) => a.clone(),
            _ => self.primary.clone(),
        };
        match &tailscale {
            Some(ts) => {
                let row = tailscale_check(ts, &vpn_address, !reachable, label);
                self.put(row);
            }
            None if self.can_read_network => self.checks.retain(|c| c.id != "tailscale"),
            None => {}
        }
        self.tailscale = tailscale;
        self.address = Some(picked.address.clone());
        self.probe = Some(picked.probe.clone());

        if !reachable {
            let (mut detail, mut hint) =
                describe_probe_failure(&picked.probe, &self.primary, self.network);
            if let Some(alt) = &self.alternate {
                detail = format!(
                    "No answer from either address ({}, {}).",
                    host_port(&self.primary).0,
                    host_port(alt).0
                );
                hint = format!(
                    "Make sure the server machine is switched on, and that you're at home{}.",
                    self.network
                        .network_name()
                        .map(|n| format!(" or connected to {n}"))
                        .unwrap_or_default()
                );
            }
            self.put(
                UiCheck::new("server", "Server connection", UiLevel::Error)
                    .detail(detail)
                    .hint(hint)
                    .action(CheckAction::ChangeServer),
            );
            return (route, false);
        }
        let (host, _) = host_port(&picked.address);
        self.put(
            UiCheck::new("server", "Server connection", UiLevel::Ok)
                .detail(format!("Reachable at {host}.")),
        );
        (route, true)
    }

    /// The address whose pin the shell should look up.
    pub fn address(&self) -> Option<&str> {
        self.address.as_deref()
    }

    /// Identity: a pinned certificate that no longer matches is a hard stop.
    /// `pin` is the saved pin for [`CheckRun::address`] (`None` if the lookup failed).
    pub fn identity(&mut self, kind: HostKind, pin: Option<&str>) -> bool {
        let probe = self.probe.clone().unwrap_or_default();
        let pin = pin.filter(|p| !p.is_empty());
        if let (HostKind::Tauri, Some(pin), Some(fp)) = (kind, pin, probe.fingerprint()) {
            if pin.to_lowercase() != fp.to_lowercase() {
                self.put(
                    UiCheck::new("identity", "Server identity", UiLevel::Error)
                        .detail("The server's security certificate has changed since you last connected.")
                        .hint("If you reinstalled the server or replaced its certificate, choose Change server to verify it again. If not, don't continue — something may be intercepting the connection.")
                        .action(CheckAction::ChangeServer),
                );
                return false;
            }
        }
        if pin.is_some() || probe.trusted_by_os() {
            self.put(
                UiCheck::new("identity", "Server identity", UiLevel::Ok).detail(
                    if probe.trusted_by_os() {
                        "Valid certificate."
                    } else {
                        "Matches the certificate you verified."
                    },
                ),
            );
        }
        true
    }

    /// The pending version row, before `client.version()`.
    pub fn version_pending(&mut self) {
        self.put(UiCheck::new(
            "version",
            "App and server versions",
            UiLevel::Pending,
        ));
    }

    pub fn version(
        &mut self,
        result: Result<&VersionResponse, &RequestFailure>,
        app_version: &str,
    ) -> bool {
        const LABEL: &str = "App and server versions";
        let v = match result {
            Ok(v) => v,
            Err(err) => {
                self.put(
                    UiCheck::new("version", LABEL, UiLevel::Error)
                        .detail(match err {
                            RequestFailure::Api { message, .. } => message.clone(),
                            RequestFailure::Other => "The server didn't answer the version check.".into(),
                        })
                        .hint("If you just changed the server, choose Change server to connect again.")
                        .action(CheckAction::ChangeServer),
                );
                return false;
            }
        };
        if compare_semver(app_version, &v.min_client_version) < 0.0 {
            self.put(
                UiCheck::new("version", LABEL, UiLevel::Error)
                    .detail(format!(
                        "The server needs app version {} or newer; this is {app_version}.",
                        v.min_client_version
                    ))
                    .hint("Update Vault Finance, then open it again.")
                    .action(CheckAction::UpdateApp),
            );
            return false;
        }
        self.put(if compare_semver(&v.api_version, app_version) < 0.0 {
            UiCheck::new("version", LABEL, UiLevel::Warn)
                .detail(format!("The server ({}) is older than this app ({app_version}).", v.api_version))
                .hint("Newer features may not work until the server is updated (Settings → Server update).")
        } else {
            UiCheck::new("version", LABEL, UiLevel::Ok).detail(format!("App {app_version} · server {}.", v.api_version))
        });
        true
    }

    /// The server's own components. Older servers without /status (404) are skipped quietly.
    pub fn server_status(&mut self, result: Result<&ServerStatusResponse, &RequestFailure>) {
        match result {
            Ok(s) => s.checks.iter().for_each(|c| self.put(from_server(c))),
            Err(RequestFailure::Api { status: 404, .. }) => {}
            Err(_) => self.put(
                UiCheck::new("server-health", "Server health", UiLevel::Warn)
                    .detail("The server didn't report its health."),
            ),
        }
    }

    /// Signed-in details (only with a saved session). A failure is ignored:
    /// sign-in sorts it out.
    pub fn status_details(&mut self, result: Option<&StatusDetailsResponse>) {
        if let Some(d) = result {
            d.checks.iter().for_each(|c| self.put(from_server(c)));
        }
    }

    pub fn outcome(self) -> CheckOutcome {
        CheckOutcome {
            blocked: self.checks.iter().any(|c| c.level == UiLevel::Error),
            checks: self.checks,
            probe: self.probe,
            tailscale: self.tailscale,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server_route::pick_address;

    // apps/desktop/src/lib/startupChecks.test.ts
    fn ts(state: &str, ips: &[&str]) -> TailscaleStatus {
        TailscaleStatus {
            installed: true,
            state: state.into(),
            ips: ips.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }
    fn running() -> TailscaleStatus {
        ts("Running", &["100.70.1.2"])
    }
    fn unreachable(error: &str) -> ProbeResult {
        ProbeResult {
            reachable: false,
            error: Some(error.into()),
            ..Default::default()
        }
    }

    #[test]
    fn looks_like_tailnet_recognises_tailscale_addresses_and_names() {
        assert!(looks_like_tailnet("https://100.101.102.103:8443"));
        assert!(looks_like_tailnet("https://server.example.ts.net:8443"));
        assert!(looks_like_tailnet("https://[fd7a:115c:a1e0::1]:8443"));
        assert!(!looks_like_tailnet("https://100.12.0.1:8443"));
        assert!(!looks_like_tailnet("https://192.168.1.10:8443"));
    }

    #[test]
    fn describe_probe_failure_explains_each_error() {
        let at = "https://vault.lan:8443";
        let d =
            |e: &str| describe_probe_failure(&unreachable(e), at, PrivateNetworkId::Tailscale).0;
        assert!(
            d("error sending request: dns error: failed to lookup address information")
                .to_lowercase()
                .contains("couldn't find")
        );
        assert!(
            d("error sending request: tcp connect error: Connection refused (os error 111)")
                .contains("isn't running on port 8443")
        );
        assert!(d("error sending request: operation timed out")
            .to_lowercase()
            .contains("no answer"));
        assert!(d("invalid peer certificate: BadSignature")
            .to_lowercase()
            .contains("secure connection"));
        let http = ProbeResult {
            reachable: false,
            http_status: Some(404),
            ..Default::default()
        };
        assert!(
            describe_probe_failure(&http, at, PrivateNetworkId::Tailscale)
                .1
                .contains("8443")
        );
    }

    #[test]
    fn tailscale_points_at_itself_without_blocking_when_a_tailnet_server_is_down() {
        let c = tailscale_check(
            &ts("Stopped", &[]),
            "https://100.70.0.1:8443",
            true,
            "Tailscale",
        );
        assert_eq!(
            (c.level, c.action),
            (UiLevel::Warn, Some(CheckAction::TailscaleUp))
        );
        assert_eq!(
            tailscale_check(
                &ts("Stopped", &[]),
                "https://100.70.0.1:8443",
                false,
                "Tailscale"
            )
            .level,
            UiLevel::Off
        );
    }

    #[test]
    fn tailscale_never_blocks_over_being_signed_out_or_the_service_being_down() {
        for state in ["NeedsLogin", "NeedsMachineAuth", "DaemonDown"] {
            assert_eq!(
                tailscale_check(
                    &ts(state, &[]),
                    "https://100.70.0.1:8443",
                    false,
                    "Tailscale"
                )
                .level,
                UiLevel::Off
            );
            assert_eq!(
                tailscale_check(
                    &ts(state, &[]),
                    "https://100.70.0.1:8443",
                    true,
                    "Tailscale"
                )
                .level,
                UiLevel::Warn
            );
        }
        assert_eq!(
            tailscale_check(
                &ts("Stopped", &["100.70.1.2"]),
                "https://192.168.1.10:8443",
                false,
                "Tailscale"
            )
            .level,
            UiLevel::Off
        );
    }

    #[test]
    fn tailscale_suggests_installing_only_when_a_tailnet_server_cant_be_reached() {
        let missing = TailscaleStatus {
            installed: false,
            state: "NotInstalled".into(),
            ..Default::default()
        };
        let c = tailscale_check(&missing, "https://x.ts.net", true, "Tailscale");
        assert_eq!(
            (c.level, c.action),
            (UiLevel::Warn, Some(CheckAction::TailscaleInstall))
        );
        assert_eq!(
            tailscale_check(&missing, "https://x.ts.net", false, "Tailscale").level,
            UiLevel::Off
        );
    }

    #[test]
    fn tailscale_names_the_machine_when_connected() {
        let t = TailscaleStatus {
            dns_name: Some("pats-macbook.tail1234.ts.net.".into()),
            ips: vec!["fd7a:115c:a1e0::1".into(), "100.70.1.2".into()],
            ..running()
        };
        assert_eq!(
            tailscale_check(&t, "https://vault.lan", false, "Tailscale")
                .detail
                .as_deref(),
            Some("Connected (pats-macbook · 100.70.1.2).")
        );
    }

    /// The fakes from the TS test.
    struct Fakes {
        kind: HostKind,
        probe: Box<dyn Fn(&str) -> ProbeResult>,
        pin: Option<String>,
        tailscale: Option<TailscaleStatus>,
        version: Result<VersionResponse, RequestFailure>,
        server_status: Result<ServerStatusResponse, RequestFailure>,
    }

    fn fakes() -> Fakes {
        Fakes {
            kind: HostKind::Tauri,
            probe: Box::new(|_| ProbeResult {
                reachable: true,
                fingerprint: Some("ab".into()),
                trusted_by_os: Some(false),
                ..Default::default()
            }),
            pin: Some("ab".into()),
            tailscale: None,
            version: Ok(VersionResponse {
                api_version: "0.2.0".into(),
                min_client_version: "0.1.0".into(),
            }),
            server_status: Ok(ServerStatusResponse {
                api_version: "0.2.0".into(),
                started_at: "2026-11-24T06:00:00.000Z".into(),
                checks: vec![StatusCheck {
                    id: "database".into(),
                    label: "Database".into(),
                    level: StatusLevel::Ok,
                    detail: None,
                    hint: None,
                }],
            }),
        }
    }

    struct Deps<'a> {
        address: &'a str,
        alternate: Option<&'a str>,
        network: PrivateNetworkId,
    }

    fn deps(address: &str) -> Deps<'_> {
        Deps {
            address,
            alternate: None,
            network: PrivateNetworkId::Tailscale,
        }
    }

    /// `runChecks`, driven synchronously. Returns the outcome, the order of
    /// `onRoute`/version calls, whether Tailscale was asked, and the row count after each step.
    fn run(f: &Fakes, d: &Deps) -> (CheckOutcome, Vec<String>, bool, Vec<usize>) {
        let mut order = Vec::new();
        let mut seen = Vec::new();
        let mut r = CheckRun::new(
            true,
            d.address,
            d.alternate,
            d.network,
            f.tailscale.is_some(),
        );
        seen.push(r.checks().len());
        r.begin_probe();
        seen.push(r.checks().len());
        let asked = r.wants_tailscale();
        let ts = if asked { f.tailscale.clone() } else { None };
        let mut arrivals = vec![(d.address, (f.probe)(d.address))];
        if let Some(a) = d.alternate {
            arrivals.push((a, (f.probe)(a)));
        }
        let picked = pick_address(d.address, d.alternate, &arrivals);
        let (route, go) = r.after_probe(ts, picked);
        order.extend(route);
        seen.push(r.checks().len());
        let done = |r: CheckRun, order, seen| (r.outcome(), order, asked, seen);
        if !go || !r.identity(f.kind, f.pin.as_deref()) {
            return done(r, order, seen);
        }
        r.version_pending();
        order.push("version".into());
        if !r.version(f.version.as_ref(), "0.2.0") {
            return done(r, order, seen);
        }
        r.server_status(f.server_status.as_ref());
        seen.push(r.checks().len());
        let details = StatusDetailsResponse {
            checks: vec![StatusCheck {
                id: "ai".into(),
                label: "AI assistant".into(),
                level: StatusLevel::Off,
                detail: None,
                hint: None,
            }],
        };
        r.status_details(Some(&details));
        seen.push(r.checks().len());
        done(r, order, seen)
    }

    fn row<'a>(o: &'a CheckOutcome, id: &str) -> Option<&'a UiCheck> {
        o.checks.iter().find(|c| c.id == id)
    }

    #[test]
    fn passes_a_healthy_setup_and_includes_the_servers_own_checks() {
        let f = Fakes {
            tailscale: Some(running()),
            ..fakes()
        };
        let (out, ..) = run(&f, &deps("https://vault.lan:8443"));
        assert!(!out.blocked);
        let rows: Vec<(&str, UiLevel)> = out
            .checks
            .iter()
            .map(|c| (c.id.as_str(), c.level))
            .collect();
        assert_eq!(
            rows,
            [
                ("device", UiLevel::Ok),
                ("tailscale", UiLevel::Ok),
                ("server", UiLevel::Ok),
                ("identity", UiLevel::Ok),
                ("version", UiLevel::Ok),
                ("database", UiLevel::Ok),
                ("ai", UiLevel::Off)
            ]
        );
    }

    #[test]
    fn stops_at_an_unreachable_server_and_blames_tailscale_when_its_off() {
        let f = Fakes {
            probe: Box::new(|_| unreachable("operation timed out")),
            tailscale: Some(ts("Stopped", &[])),
            ..fakes()
        };
        let (out, ..) = run(&f, &deps("https://vault.lan:8443"));
        assert!(out.blocked);
        assert_eq!(row(&out, "tailscale").unwrap().level, UiLevel::Warn);
        assert_eq!(row(&out, "server").unwrap().level, UiLevel::Error);
        assert!(row(&out, "version").is_none());
    }

    #[test]
    fn isnt_blocked_by_tailscale_being_off_when_the_server_answers() {
        let f = Fakes {
            tailscale: Some(ts("Stopped", &[])),
            ..fakes()
        };
        let (out, ..) = run(&f, &deps("https://100.70.0.1:8443"));
        assert!(!out.blocked);
        assert_eq!(row(&out, "tailscale").unwrap().level, UiLevel::Off);
    }

    #[test]
    fn leaves_other_vpns_alone() {
        let f = Fakes {
            probe: Box::new(|_| unreachable("operation timed out")),
            tailscale: Some(running()),
            ..fakes()
        };
        let (out, _, asked, _) = run(
            &f,
            &Deps {
                network: PrivateNetworkId::Netbird,
                ..deps("https://100.70.0.1:8443")
            },
        );
        assert!(!asked);
        assert!(row(&out, "tailscale").is_none());
        let hint = row(&out, "server").unwrap().hint.clone().unwrap();
        assert!(hint.contains("NetBird") && !hint.contains("Tailscale"));
    }

    #[test]
    fn labels_the_row_headscale() {
        let f = Fakes {
            tailscale: Some(running()),
            ..fakes()
        };
        let (out, ..) = run(
            &f,
            &Deps {
                network: PrivateNetworkId::Headscale,
                ..deps("https://vault.lan:8443")
            },
        );
        assert_eq!(row(&out, "tailscale").unwrap().label, "Headscale");
    }

    #[test]
    fn uses_the_second_address_and_reports_it_before_asking_the_server_anything() {
        let f = Fakes {
            probe: Box::new(|a| {
                if a == "https://100.70.0.1:8443" {
                    unreachable("operation timed out")
                } else {
                    ProbeResult {
                        reachable: true,
                        fingerprint: Some("ab".into()),
                        ..Default::default()
                    }
                }
            }),
            ..fakes()
        };
        let (out, order, ..) = run(
            &f,
            &Deps {
                alternate: Some("https://192.168.1.10:8443"),
                ..deps("https://100.70.0.1:8443")
            },
        );
        assert!(!out.blocked);
        assert_eq!(order, ["https://192.168.1.10:8443", "version"]);
        assert!(row(&out, "server")
            .unwrap()
            .detail
            .as_deref()
            .unwrap()
            .contains("192.168.1.10"));
    }

    #[test]
    fn checks_the_certificate_of_whichever_address_answered() {
        let f = Fakes {
            probe: Box::new(|a| {
                if a == "https://home:8443" {
                    ProbeResult::default()
                } else {
                    ProbeResult {
                        reachable: true,
                        fingerprint: Some("evil".into()),
                        ..Default::default()
                    }
                }
            }),
            ..fakes()
        };
        let (out, ..) = run(
            &f,
            &Deps {
                alternate: Some("https://vpn:8443"),
                ..deps("https://home:8443")
            },
        );
        assert!(out.blocked);
        assert_eq!(row(&out, "identity").unwrap().level, UiLevel::Error);
    }

    #[test]
    fn says_both_addresses_were_tried_when_neither_answers() {
        let f = Fakes {
            probe: Box::new(|_| unreachable("operation timed out")),
            ..fakes()
        };
        let (out, order, ..) = run(
            &f,
            &Deps {
                alternate: Some("https://vpn:8443"),
                ..deps("https://home:8443")
            },
        );
        assert!(out.blocked);
        assert!(order.is_empty());
        assert!(row(&out, "server")
            .unwrap()
            .detail
            .as_deref()
            .unwrap()
            .contains("either address"));
    }

    #[test]
    fn refuses_a_server_whose_certificate_changed() {
        let f = Fakes {
            pin: Some("aa".into()),
            probe: Box::new(|_| ProbeResult {
                reachable: true,
                fingerprint: Some("bb".into()),
                ..Default::default()
            }),
            ..fakes()
        };
        let (out, ..) = run(&f, &deps("https://vault.lan:8443"));
        let id = row(&out, "identity").unwrap();
        assert_eq!(
            (id.level, id.action),
            (UiLevel::Error, Some(CheckAction::ChangeServer))
        );
    }

    #[test]
    fn blocks_an_app_thats_too_old_for_the_server() {
        let f = Fakes {
            version: Ok(VersionResponse {
                api_version: "0.2.0".into(),
                min_client_version: "0.3.0".into(),
            }),
            ..fakes()
        };
        let (out, ..) = run(&f, &deps("https://vault.lan:8443"));
        let v = row(&out, "version").unwrap();
        assert_eq!(
            (v.level, v.action),
            (UiLevel::Error, Some(CheckAction::UpdateApp))
        );
    }

    #[test]
    fn warns_without_blocking_when_the_server_is_older_than_the_app() {
        let f = Fakes {
            version: Ok(VersionResponse {
                api_version: "0.1.0".into(),
                min_client_version: "0.1.0".into(),
            }),
            ..fakes()
        };
        let (out, ..) = run(&f, &deps("https://vault.lan:8443"));
        assert!(!out.blocked);
        assert_eq!(row(&out, "version").unwrap().level, UiLevel::Warn);
    }

    #[test]
    fn skips_server_health_quietly_on_an_older_server_without_status() {
        let f = Fakes {
            server_status: Err(RequestFailure::Api {
                message: "Not found".into(),
                status: 404,
            }),
            ..fakes()
        };
        let (out, ..) = run(&f, &deps("https://vault.lan:8443"));
        assert!(row(&out, "server-health").is_none());
        assert!(!out.blocked);
        let f = Fakes {
            server_status: Err(RequestFailure::Other),
            ..fakes()
        };
        assert_eq!(
            row(&run(&f, &deps("https://vault.lan:8443")).0, "server-health")
                .unwrap()
                .level,
            UiLevel::Warn
        );
    }

    #[test]
    fn reports_progress_row_by_row() {
        let (_, _, _, seen) = run(&fakes(), &deps("https://vault.lan:8443"));
        assert_eq!(seen[0], 1);
        assert!(seen.iter().max().unwrap() > &3);
    }

    #[test]
    fn version_check_failures() {
        let f = Fakes {
            version: Err(RequestFailure::Api {
                message: "Signed out".into(),
                status: 401,
            }),
            ..fakes()
        };
        let (out, ..) = run(&f, &deps("https://vault.lan:8443"));
        let v = row(&out, "version").unwrap();
        assert_eq!(
            (v.detail.as_deref(), v.action),
            (Some("Signed out"), Some(CheckAction::ChangeServer))
        );
        assert!(out.blocked);
    }
}
