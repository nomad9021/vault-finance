//! Mirrors packages/shared/src/schemas/updates.ts (server updates) and
//! version.ts (app/server compatibility).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelfUpdateState {
    Idle,
    Requested,
    Running,
    Succeeded,
    Failed,
}

/// Progress of an update started from the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfUpdateStatus {
    pub state: SelfUpdateState,
    pub message: Option<String>,
    pub target_version: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusResponse {
    pub current_version: String,
    /// Null when the check couldn't reach the manifest.
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub notes_url: Option<String>,
    /// Part of an operator-managed fleet (the owner doesn't self-update).
    pub operator_managed: bool,
    pub checked_at: Option<String>,
    /// Null without an update agent; absent on servers older than 0.1.9
    /// (both read as `None`).
    #[serde(default)]
    pub self_update: Option<SelfUpdateStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionResponse {
    pub api_version: String,
    pub min_client_version: String,
}

/// `Number(part)` for one dotted part: blank is 0, anything else unparsable
/// is NaN.
fn js_number(part: &str) -> f64 {
    let t = crate::serde_util::js_trim(part);
    if t.is_empty() {
        0.0
    } else {
        t.parse().unwrap_or(f64::NAN)
    }
}

/// Compare two plain semver strings ("1.2.3"): negative if a < b, 0 if
/// equal, positive if a > b. Like the JS, a NaN part compares as equal.
pub fn compare_semver(a: &str, b: &str) -> f64 {
    let pa: Vec<f64> = a.split('.').map(js_number).collect();
    let pb: Vec<f64> = b.split('.').map(js_number).collect();
    for i in 0..3 {
        let d = pa.get(i).copied().unwrap_or(0.0) - pb.get(i).copied().unwrap_or(0.0);
        // `if (d !== 0) return d` returns NaN too; NaN < 0 and > 0 are both false.
        if d != 0.0 {
            return d;
        }
    }
    0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_update_status() {
        let u: UpdateStatusResponse = serde_json::from_str(
            r#"{"currentVersion":"0.2.1","latestVersion":"0.2.2","updateAvailable":true,
                "notesUrl":"https://github.com/nomad9021/vault-finance/releases/tag/v0.2.2","operatorManaged":false,
                "checkedAt":"2026-11-24T06:00:05.000Z",
                "selfUpdate":{"state":"failed","message":"Docker couldn't pull the image.","targetVersion":"0.2.2",
                  "startedAt":"2026-11-24T07:00:00.000Z","finishedAt":"2026-11-24T07:01:12.000Z"}}"#,
        )
        .unwrap();
        assert_eq!(u.self_update.unwrap().state, SelfUpdateState::Failed);
        let old: UpdateStatusResponse = serde_json::from_str(
            r#"{"currentVersion":"0.1.8","latestVersion":null,"updateAvailable":false,"notesUrl":null,
                "operatorManaged":true,"checkedAt":null}"#,
        )
        .unwrap();
        assert_eq!(old.self_update, None);
        let v: VersionResponse =
            serde_json::from_str(r#"{"apiVersion":"0.2.2","minClientVersion":"0.2.0"}"#).unwrap();
        assert_eq!(v.min_client_version, "0.2.0");
    }

    #[test]
    fn compares_versions() {
        assert!(compare_semver("0.2.0", "0.10.0") < 0.0);
        assert!(compare_semver("1.0.0", "0.9.9") > 0.0);
        assert_eq!(compare_semver("0.2", "0.2.0"), 0.0);
        assert_eq!(compare_semver("0.2.0.7", "0.2.0"), 0.0);
        let nan = compare_semver("0.x.0", "0.2.0");
        // Neither older nor newer, like the JS.
        assert!(nan.is_nan());
    }
}
