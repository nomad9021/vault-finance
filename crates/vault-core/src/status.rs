//! Mirrors packages/shared/src/schemas/status.ts: the health checks on the
//! startup screen and in Settings → System status.

use serde::{Deserialize, Serialize};

/// ok = working, warn = needs attention, error = blocks the app, off = an
/// optional feature that's turned off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusLevel {
    Ok,
    Warn,
    Error,
    Off,
}

impl StatusLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Off => "off",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusCheck {
    pub id: String,
    pub label: String,
    pub level: StatusLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// GET /status (unauthenticated, coarse).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusResponse {
    pub api_version: String,
    pub started_at: String,
    pub checks: Vec<StatusCheck>,
}

/// GET /status/details (signed in): AI, bank sync, server updates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusDetailsResponse {
    pub checks: Vec<StatusCheck>,
}

/// Worst level in a list (error > warn > ok/off).
pub fn worst_level<'a>(levels: impl IntoIterator<Item = &'a StatusLevel>) -> StatusLevel {
    let levels: Vec<StatusLevel> = levels.into_iter().copied().collect();
    if levels.contains(&StatusLevel::Error) {
        StatusLevel::Error
    } else if levels.contains(&StatusLevel::Warn) {
        StatusLevel::Warn
    } else {
        StatusLevel::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_status() {
        let s: ServerStatusResponse = serde_json::from_str(
            r#"{"apiVersion":"0.2.2","startedAt":"2026-11-24T06:00:01.000Z","checks":[
                {"id":"database","label":"Database","level":"ok","detail":"PostgreSQL 16, 41 MB."},
                {"id":"backups","label":"Backups","level":"warn","detail":"Last backup was 9 days ago.",
                 "hint":"Check the backup job on the server."}]}"#,
        )
        .unwrap();
        assert_eq!(s.checks[1].level, StatusLevel::Warn);
        assert_eq!(s.checks[0].hint, None);
        let d: StatusDetailsResponse = serde_json::from_str(
            r#"{"checks":[{"id":"ai","label":"AI assistant","level":"off"}]}"#,
        )
        .unwrap();
        assert_eq!(d.checks[0].level, StatusLevel::Off);
        assert_eq!(
            worst_level(s.checks.iter().map(|c| &c.level)),
            StatusLevel::Warn
        );
        assert_eq!(
            worst_level(&[StatusLevel::Off, StatusLevel::Ok]),
            StatusLevel::Ok
        );
        assert_eq!(
            worst_level(&[StatusLevel::Warn, StatusLevel::Error]),
            StatusLevel::Error
        );
        assert_eq!(worst_level(&[]), StatusLevel::Ok);
    }
}
