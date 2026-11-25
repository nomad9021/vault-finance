//! Settings page, part B (apps/desktop/src/screens/shell/SettingsPage.tsx
//! from AiSection to ServerSection): the store snapshot the host hands over
//! and the sections' pure logic.

use serde::{Deserialize, Serialize};

use crate::ai::{AiProvider, AiStatus};
use crate::auth::{ApprovedVia, DeviceApprovalSettings};
use crate::bank::{BankLinkState, BankLinkStatus};
use crate::common::UserRole;
use crate::platform::TailscaleStatus;
use crate::reports::SlideId;
use crate::startup_checks::UiCheck;

/// `BiometricStatus` (platform/types.ts).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricStatus {
    pub available: bool,
    /// "Windows Hello", "Touch ID", "Fingerprint".
    pub label: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `BiometricResult`: `{ ok: true }` or `{ ok: false, reason, message? }`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BiometricResult {
    pub ok: bool,
    /// "cancelled" | "interrupted" | "failed" | "unavailable" …
    pub reason: Option<String>,
    pub message: Option<String>,
}

impl BiometricResult {
    /// BiometricSection's `turnOn` error, if the outcome is worth showing.
    pub fn error(&self, label: &str) -> Option<String> {
        let reason = self.reason.as_deref().unwrap_or("");
        if self.ok || reason == "cancelled" || reason == "interrupted" {
            return None;
        }
        Some(self.message.clone().unwrap_or_else(|| {
            if reason == "failed" {
                format!("{label} didn't recognize you.")
            } else {
                format!("{label} isn't available.")
            }
        }))
    }
}

/// `TailscaleActionResult`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TailscaleActionResult {
    pub ok: bool,
    pub message: Option<String>,
    pub status: TailscaleStatus,
}

/// `SaveAlternateResult` (state/store.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum SaveAlternateResult {
    Saved,
    Confirm {
        address: String,
        fingerprint: String,
    },
    Error {
        message: String,
    },
}

/// What `host.settingsState()` returns: the `useApp` fields these sections
/// read.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsState {
    pub user_id: Option<String>,
    pub role: Option<UserRole>,
    pub theme: String,
    pub show_sankey: bool,
    pub ai_visible: bool,
    pub ai_auto_apply: bool,
    pub ai_level: String,
    pub auto_lock_minutes: f64,
    pub biometric: Option<BiometricStatus>,
    pub biometric_user_ids: Vec<String>,
    pub server_address: Option<String>,
    pub alternate_address: Option<String>,
    pub active_address: Option<String>,
    pub tailscale: Option<TailscaleStatus>,
    /// `Boolean(platform.tailscaleStatus)`.
    pub tailscale_supported: bool,
    /// "tauri" | "browser".
    pub platform: String,
}

impl SettingsState {
    pub fn is_owner(&self) -> bool {
        self.role == Some(UserRole::Owner)
    }
    /// The signed-in user has biometric sign-in on this device.
    pub fn biometric_enrolled(&self) -> bool {
        self.user_id
            .as_ref()
            .is_some_and(|id| self.biometric_user_ids.contains(id))
    }
    pub fn biometric_label(&self) -> String {
        self.biometric
            .as_ref()
            .map(|b| b.label.clone())
            .unwrap_or_else(|| "Biometric sign-in".into())
    }
}

/// `THEMES` with `THEME_LABELS[t].split(" ")[0]` (the segmented control).
pub const THEMES: [(&str, &str); 5] = [
    ("automatic", "Automatic"),
    ("dark", "Dark"),
    ("light", "Light"),
    ("oled", "OLED"),
    ("contrast", "High"),
];

/// Auto-lock choices in minutes (0, "Never", is listed last).
pub const AUTO_LOCK_CHOICES: [u32; 7] = [1, 2, 5, 10, 15, 30, 60];

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// AiSection's `statusLine`.
pub fn ai_status_line(s: &AiStatus) -> String {
    if !s.enabled {
        return "Off".into();
    }
    if !s.configured {
        return "Needs configuration".into();
    }
    if s.reachable {
        let n = s.available_models.len();
        return if n > 0 {
            format!("Connected — {n} model{} available", plural(n))
        } else {
            "Connected".into()
        };
    }
    "Unreachable".into()
}

/// The status dot next to it.
pub fn ai_status_color(s: &AiStatus) -> &'static str {
    if !s.enabled {
        "var(--color-neutral-600)"
    } else if s.configured && s.reachable {
        "var(--color-positive)"
    } else {
        "var(--color-negative)"
    }
}

/// The model saved for a local provider: the Normal tier, else the first
/// installed model, else what's typed, else the default.
pub fn resolved_model(
    provider: AiProvider,
    model: &str,
    normal: Option<&str>,
    installed: &[String],
) -> String {
    if !provider.is_local() {
        return model.to_string();
    }
    [normal, installed.first().map(String::as_str), Some(model)]
        .into_iter()
        .flatten()
        .find(|m| !m.is_empty())
        .unwrap_or("llama3.2:3b")
        .to_string()
}

/// The base URL after switching provider: that provider's example when the
/// field is blank or still another provider's example.
pub fn base_url_after_switch(next: AiProvider, base_url: &str) -> Option<&'static str> {
    let example = next.base_url_example()?;
    let trimmed = crate::serde_util::js_trim(base_url);
    let is_example = AiProvider::ALL
        .iter()
        .any(|p| p.base_url_example() == Some(trimmed));
    (trimmed.is_empty() || is_example).then_some(example)
}

/// The test result's "Connected · 3 models · 42 ms".
pub fn ai_test_summary(models: usize, latency_ms: i64) -> String {
    format!(
        "Connected · {models} model{} · {latency_ms} ms",
        plural(models)
    )
}

/// What a finished Plaid sign-in says: `Ok` for the status line, `Err` for
/// the error line. `None` while still waiting.
pub fn bank_link_outcome(r: &BankLinkStatus) -> Option<Result<String, String>> {
    match r.status {
        BankLinkState::Waiting => None,
        BankLinkState::Connected | BankLinkState::Reconnected => {
            let parts: Vec<String> = r
                .results
                .iter()
                .map(|x| {
                    format!(
                        "{}: {} account{}, {} transactions",
                        x.institution_name,
                        x.accounts_linked,
                        if x.accounts_linked == 1 { "" } else { "s" },
                        x.imported
                    )
                })
                .collect();
            let lead = if r.status == BankLinkState::Reconnected {
                "Reconnected. "
            } else {
                "Connected. "
            };
            let extra = r
                .message
                .as_ref()
                .map(|m| format!(" ({m})"))
                .unwrap_or_default();
            Some(Ok(format!(
                "{lead}{}{extra}. Older history can take a few minutes to arrive; it comes in with the next sync.",
                parts.join("; ")
            )))
        }
        BankLinkState::Exited => Some(Err(r
            .message
            .clone()
            .unwrap_or_else(|| "Plaid was closed before a bank was connected.".into()))),
        _ => Some(Err(r.message.clone().unwrap_or_else(|| {
            "The sign-in session ended. Press Link a bank to try again.".into()
        }))),
    }
}

/// `${n} account${n === 1 ? "" : "s"}`.
pub fn accounts_label(n: i64) -> String {
    format!("{n} account{}", if n == 1 { "" } else { "s" })
}

/// SystemStatusSection's summary line.
pub fn checks_summary(running: bool, checks: &[UiCheck]) -> String {
    use crate::startup_checks::UiLevel;
    if running {
        return "Checking…".into();
    }
    let problems = checks
        .iter()
        .filter(|c| matches!(c.level, UiLevel::Error | UiLevel::Warn))
        .count();
    if problems == 0 {
        "Everything is working.".into()
    } else {
        let one = problems == 1;
        format!(
            "{problems} thing{} need{} attention.",
            if one { "" } else { "s" },
            if one { "s" } else { "" }
        )
    }
}

/// TailscaleControl's `describe`: text and dot colour.
pub fn tailscale_describe(s: &TailscaleStatus, label: &str) -> (String, &'static str) {
    match s.state.as_str() {
        "Running" => {
            let ip = s.ips.iter().find(|i| !i.contains(':'));
            (
                format!(
                    "Connected{}",
                    ip.map(|ip| format!(" · {ip}")).unwrap_or_default()
                ),
                "var(--color-positive)",
            )
        }
        "NeedsLogin" => ("Needs you to sign in".into(), "var(--color-warning)"),
        "NeedsMachineAuth" => (
            format!("Waiting for approval in the {label} admin console"),
            "var(--color-warning)",
        ),
        "Starting" => ("Connecting…".into(), "var(--color-warning)"),
        "DaemonDown" => (
            "Tailscale service isn't running".into(),
            "var(--color-negative)",
        ),
        "NotInstalled" => ("Not installed".into(), "var(--content-tertiary)"),
        _ => ("Off".into(), "var(--content-tertiary)"),
    }
}

/// The TOTP secret in groups of four: `secret.replace(/(.{4})/g, "$1 ").trim()`.
pub fn group_secret(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    chars
        .chunks(4)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// Digits only (the 6-digit code field).
pub fn digits_only(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

/// `code.replace(/\s/g, "")`.
pub fn strip_whitespace(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// TrustedDevicesSection's intro sentence after the dash.
pub fn approval_methods_sentence(methods: Option<&DeviceApprovalSettings>) -> String {
    let device = methods.is_none_or(|m| m.trusted_device);
    let console = methods.is_none_or(|m| m.server_console);
    let mut s = String::new();
    if device {
        s.push_str(" from a device that's already approved (by typing the code it shows)");
    }
    if device && console {
        s.push_str(" or");
    }
    if console {
        s.push_str(" on the server with “vault approve <code>”");
    }
    s.push('.');
    s
}

impl ApprovedVia {
    /// `VIA_LABEL`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Device => "approved from another device",
            Self::Console => "approved on the server",
            Self::Bootstrap => "first device",
            Self::ExistingSession => "already signed in at upgrade",
            Self::DeviceKey => "biometric sign-in",
        }
    }
}

impl SlideId {
    /// `REVIEW_SLIDE_LABELS[id]`: title and hint.
    pub fn label(self) -> (&'static str, &'static str) {
        match self {
            Self::Overview => (
                "Overview",
                "Income, spending and saved, vs the period before",
            ),
            Self::Categories => ("Spending by category", "Pie chart and the biggest movers"),
            Self::Daily => ("Day by day", "A bar for each day's spending"),
            Self::Merchants => ("Top merchants", "Where the money went most often"),
            Self::Largest => ("Largest purchases", "The five biggest single charges"),
            Self::Budgets => ("Budgets", "This month's budgets — spent vs planned"),
            Self::Bills => ("Upcoming bills", "What's due in the next period"),
            Self::Goals => ("Savings goals", "Progress and on-track status"),
            Self::Ai => ("AI summary", "Assistant commentary (closed months, AI on)"),
        }
    }
}

/// `PLATFORM_LABEL` in DeviceApprovalPrompt.
pub fn approval_platform_label(p: crate::common::Platform) -> &'static str {
    use crate::common::Platform::*;
    match p {
        Windows => "Windows",
        Macos => "Mac",
        Linux => "Linux",
        Ios => "phone",
    }
}

/// `describeRequest` with the time already formatted.
pub fn describe_request(p: &crate::auth::PendingApproval, when: &str) -> String {
    format!(
        "{} · {} ({}){} · {when}",
        p.user_display_name,
        p.device_name,
        approval_platform_label(p.platform),
        p.ip_address
            .as_ref()
            .map(|ip| format!(" · from {ip}"))
            .unwrap_or_default()
    )
}

/// Swap slide `i` with its neighbour `i + by`; false when that's off the end.
pub fn move_item<T>(items: &mut [T], i: usize, by: isize) -> bool {
    let j = i as isize + by;
    if j < 0 || j as usize >= items.len() {
        return false;
    }
    items.swap(i, j as usize);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bank::BankSyncResponse;

    #[test]
    fn parses_settings_state() {
        let s: SettingsState = serde_json::from_str(
            r#"{"userId":"5b0c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f","role":"owner","theme":"dark","showSankey":true,
                "aiVisible":true,"aiAutoApply":false,"aiLevel":"medium","autoLockMinutes":5,
                "biometric":{"available":false,"label":"Fingerprint","reason":"No fingerprint reader was found."},
                "biometricUserIds":["5b0c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f"],
                "serverAddress":"https://vault.local:8443","alternateAddress":null,"activeAddress":"https://vault.local:8443",
                "tailscale":{"installed":true,"state":"Running","ips":["fd7a:115c::1","100.64.0.7"],"dnsName":"desk.tail1234.ts.net","health":[]},
                "tailscaleSupported":true,"platform":"tauri"}"#,
        )
        .unwrap();
        assert!(s.is_owner() && s.biometric_enrolled());
        assert_eq!(s.biometric_label(), "Fingerprint");
        let ts = s.tailscale.unwrap();
        assert_eq!(
            tailscale_describe(&ts, "Tailscale").0,
            "Connected · 100.64.0.7"
        );
        assert_eq!(
            SettingsState::default().biometric_label(),
            "Biometric sign-in"
        );
    }

    #[test]
    fn parses_results() {
        let r: SaveAlternateResult = serde_json::from_str(
            r#"{"status":"confirm","address":"https://100.64.0.5:8443","fingerprint":"AB:CD"}"#,
        )
        .unwrap();
        assert!(matches!(r, SaveAlternateResult::Confirm { .. }));
        let b: BiometricResult = serde_json::from_str(r#"{"ok":false,"reason":"failed"}"#).unwrap();
        assert_eq!(
            b.error("Touch ID").unwrap(),
            "Touch ID didn't recognize you."
        );
        let b: BiometricResult =
            serde_json::from_str(r#"{"ok":false,"reason":"cancelled"}"#).unwrap();
        assert_eq!(b.error("Touch ID"), None);
        let b: BiometricResult = serde_json::from_str(r#"{"ok":true}"#).unwrap();
        assert_eq!(b.error("x"), None);
        let t: TailscaleActionResult = serde_json::from_str(
            r#"{"ok":true,"status":{"installed":true,"state":"NeedsLogin","ips":[],"authUrl":"https://login.tailscale.com/a/1","health":[]}}"#,
        )
        .unwrap();
        assert!(t.status.auth_url.is_some());
    }

    #[test]
    fn ai_helpers() {
        let mut s: AiStatus = serde_json::from_str(
            r#"{"enabled":true,"configured":true,"reachable":true,"provider":"ollama","model":"llama3.2:3b",
                "baseUrl":"http://ollama:11434","hasApiKey":false,"availableModels":["llama3.2:3b"],
                "qualityModels":{"normal":"llama3.2:3b"},"showModelNames":false}"#,
        )
        .unwrap();
        assert_eq!(ai_status_line(&s), "Connected — 1 model available");
        s.available_models.push("qwen".into());
        assert_eq!(ai_status_line(&s), "Connected — 2 models available");
        s.reachable = false;
        assert_eq!(ai_status_line(&s), "Unreachable");
        assert_eq!(ai_status_color(&s), "var(--color-negative)");
        s.enabled = false;
        assert_eq!(ai_status_line(&s), "Off");
        let installed = vec!["a".to_string()];
        assert_eq!(
            resolved_model(AiProvider::Ollama, "m", Some(""), &installed),
            "a"
        );
        assert_eq!(
            resolved_model(AiProvider::Ollama, "", None, &[]),
            "llama3.2:3b"
        );
        assert_eq!(
            resolved_model(AiProvider::Openai, "gpt", Some("x"), &installed),
            "gpt"
        );
        assert_eq!(ai_test_summary(1, 40), "Connected · 1 model · 40 ms");
        let ex = AiProvider::Ollama.base_url_example();
        assert_eq!(base_url_after_switch(AiProvider::Ollama, ""), ex);
        assert_eq!(
            base_url_after_switch(AiProvider::Ollama, "http://192.168.1.9:11434"),
            None
        );
        assert_eq!(base_url_after_switch(AiProvider::Openai, ""), None);
    }

    #[test]
    fn bank_outcome() {
        let mut r = BankLinkStatus {
            status: BankLinkState::Connected,
            results: vec![BankSyncResponse {
                connection_id: "c".into(),
                institution_name: "First Platypus".into(),
                accounts_linked: 1,
                imported: 40,
                skipped_duplicates: 0,
            }],
            message: None,
        };
        assert_eq!(
            bank_link_outcome(&r).unwrap().unwrap(),
            "Connected. First Platypus: 1 account, 40 transactions. Older history can take a few minutes to arrive; it comes in with the next sync."
        );
        r.status = BankLinkState::Exited;
        assert_eq!(
            bank_link_outcome(&r).unwrap().unwrap_err(),
            "Plaid was closed before a bank was connected."
        );
        r.status = BankLinkState::Expired;
        assert!(bank_link_outcome(&r)
            .unwrap()
            .unwrap_err()
            .starts_with("The sign-in session ended"));
        r.status = BankLinkState::Waiting;
        assert!(bank_link_outcome(&r).is_none());
        assert_eq!(accounts_label(2), "2 accounts");
    }

    #[test]
    fn small_helpers() {
        assert_eq!(group_secret("JBSWY3DPEHPK3PXPA"), "JBSW Y3DP EHPK 3PXP A");
        assert_eq!(group_secret(""), "");
        assert_eq!(digits_only("12 3a4"), "1234");
        assert_eq!(strip_whitespace("123 456"), "123456");
        assert_eq!(checks_summary(true, &[]), "Checking…");
        assert_eq!(checks_summary(false, &[]), "Everything is working.");
        let both = DeviceApprovalSettings {
            trusted_device: true,
            server_console: true,
        };
        assert_eq!(
            approval_methods_sentence(Some(&both)),
            " from a device that's already approved (by typing the code it shows) or on the server with “vault approve <code>”."
        );
        let console = DeviceApprovalSettings {
            trusted_device: false,
            server_console: true,
        };
        assert_eq!(
            approval_methods_sentence(Some(&console)),
            " on the server with “vault approve <code>”."
        );
        assert_eq!(
            approval_methods_sentence(None),
            approval_methods_sentence(Some(&both))
        );
        let mut v = vec![1, 2, 3];
        assert!(move_item(&mut v, 0, 1));
        assert_eq!(v, [2, 1, 3]);
        assert!(!move_item(&mut v, 0, -1));
        assert!(!move_item(&mut v, 2, 1));
    }
}
