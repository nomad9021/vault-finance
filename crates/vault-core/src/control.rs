//! Mirrors packages/shared/src/schemas/control.ts: the control plane's view
//! of hosted family instances.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FamilyMode {
    #[default]
    Port,
    Proxy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlFamily {
    pub slug: String,
    pub port: String,
    pub mode: FamilyMode,
    pub domain: Option<String>,
    /// Docker container state, or "-" when not running.
    pub state: String,
    pub db_size: String,
    pub owner_email: Option<String>,
    pub app_public_url: Option<String>,
    pub running_version: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlFamilyListResponse {
    pub families: Vec<ControlFamily>,
    pub latest_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFamilyRequest {
    /// Lowercase letters/digits, starts with a letter, 2–31 long.
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_email: Option<String>,
    #[serde(default)]
    pub mode: FamilyMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// `/^[a-z][a-z0-9]{1,30}$/`.
pub fn is_family_slug(s: &str) -> bool {
    let b = s.as_bytes();
    (2..=31).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFamilyResponse {
    pub slug: String,
    pub connect_url: String,
    pub welcome_email_sent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlActionResponse {
    pub ok: bool,
    pub log: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_family_list() {
        let r: ControlFamilyListResponse = serde_json::from_str(
            r#"{"families":[{"slug":"carter","port":"8450","mode":"proxy","domain":"carter.vault.example.com",
                 "state":"running","dbSize":"14M","ownerEmail":"pat@carter.family",
                 "appPublicUrl":"https://carter.vault.example.com","runningVersion":"0.2.1","createdAt":"2026-03-02"},
                {"slug":"smith","port":"8451","mode":"port","domain":null,"state":"-","dbSize":"0",
                 "ownerEmail":null,"appPublicUrl":null,"runningVersion":null,"createdAt":null}],
               "latestVersion":"0.2.2"}"#,
        )
        .unwrap();
        assert_eq!(r.families[0].mode, FamilyMode::Proxy);
        assert_eq!(r.families[1].running_version, None);
        let req: CreateFamilyRequest = serde_json::from_str(r#"{"slug":"smith"}"#).unwrap();
        assert_eq!(req.mode, FamilyMode::Port);
        assert!(
            is_family_slug("smith2")
                && !is_family_slug("s")
                && !is_family_slug("2smith")
                && !is_family_slug("Smith")
        );
    }
}
