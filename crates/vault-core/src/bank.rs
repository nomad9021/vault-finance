//! Mirrors packages/shared/src/schemas/bank.ts: optional bank linking (ADR-0007).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BankProvider {
    Mock,
    Plaid,
}

impl BankProvider {
    /// `BANK_PROVIDER_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Mock => "Sandbox (local demo data)",
            Self::Plaid => "Plaid",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaidEnv {
    Sandbox,
    Production,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankConnection {
    pub id: String,
    pub provider: BankProvider,
    pub institution_name: String,
    pub account_count: i64,
    pub created_at: String,
    pub last_synced_at: Option<String>,
    /// The bank wants you to sign in again.
    pub needs_reconnect: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankStatus {
    pub enabled: bool,
    pub provider: BankProvider,
    pub configured: bool,
    pub has_plaid_credentials: bool,
    pub plaid_env: PlaidEnv,
    pub connections: Vec<BankConnection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBankSettingsRequest {
    pub enabled: bool,
    pub provider: BankProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plaid_client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plaid_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plaid_env: Option<PlaidEnv>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankSyncResponse {
    pub connection_id: String,
    pub institution_name: String,
    pub accounts_linked: i64,
    pub imported: i64,
    pub skipped_duplicates: i64,
}

/// "The app was just opened" sync: `ran` is false when it was skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BankOpenSyncResponse {
    pub ran: bool,
    pub imported: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankLinkStartRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankLinkStartResponse {
    pub session_id: String,
    pub url: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BankLinkState {
    Waiting,
    Connected,
    Reconnected,
    Exited,
    Expired,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BankLinkStatus {
    pub status: BankLinkState,
    pub results: Vec<BankSyncResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bank_status_and_link() {
        let s: BankStatus = serde_json::from_str(
            r#"{"enabled":true,"provider":"plaid","configured":true,"hasPlaidCredentials":true,"plaidEnv":"production",
                "connections":[{"id":"e4f5a6b7-c8d9-4e0f-9a1b-2c3d4e5f6071","provider":"plaid",
                  "institutionName":"First Platypus Bank","accountCount":3,"createdAt":"2026-09-01T10:00:00.000Z",
                  "lastSyncedAt":"2026-11-24T06:30:00.000Z","needsReconnect":false},
                 {"id":"f5a6b7c8-d9e0-4f1a-8b2c-3d4e5f607182","provider":"mock","institutionName":"Sandbox Credit Union",
                  "accountCount":1,"createdAt":"2026-08-10T10:00:00.000Z","lastSyncedAt":null,"needsReconnect":true}]}"#,
        )
        .unwrap();
        assert_eq!(s.plaid_env, PlaidEnv::Production);
        assert!(s.connections[1].needs_reconnect);
        assert_eq!(
            s.connections[1].provider.label(),
            "Sandbox (local demo data)"
        );
        let l: BankLinkStatus = serde_json::from_str(
            r#"{"status":"connected","results":[{"connectionId":"e4f5a6b7-c8d9-4e0f-9a1b-2c3d4e5f6071",
                "institutionName":"First Platypus Bank","accountsLinked":3,"imported":412,"skippedDuplicates":0}]}"#,
        )
        .unwrap();
        assert_eq!(l.status, BankLinkState::Connected);
        assert_eq!(l.results[0].imported, 412);
        let o: BankOpenSyncResponse =
            serde_json::from_str(r#"{"ran":false,"imported":0}"#).unwrap();
        assert!(!o.ran);
        assert_eq!(
            serde_json::to_string(&BankLinkStartRequest::default()).unwrap(),
            "{}"
        );
    }
}
