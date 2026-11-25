//! Mirrors packages/shared/src/schemas/common.ts: error codes, the error
//! envelope, platforms and roles.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Stable machine-readable error codes: clients switch on these, never on message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ValidationError,
    InvalidCredentials,
    SessionRevoked,
    SessionNotFound,
    TokenExpired,
    TokenInvalid,
    RefreshTokenReused,
    SetupAlreadyComplete,
    SetupRequired,
    Forbidden,
    NotFound,
    RateLimited,
    TotpRequired,
    TotpInvalid,
    DeviceApprovalRequired,
    DeviceNotTrusted,
    ClientVersionTooOld,
    CategoryInUse,
    AiUnavailable,
    AiHostStartFailed,
    AiDisabled,
    BankDisabled,
    BankUnconfigured,
    BankUnavailable,
    UpdateUnavailable,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorBody {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<BTreeMap<String, String>>,
}

/// `{ error: { code, message, fields? } }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiError {
    pub error: ApiErrorBody,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
    Ios,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Owner,
    #[default]
    Member,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_error_envelope() {
        let e: ApiError = serde_json::from_str(
            r#"{"error":{"code":"DEVICE_APPROVAL_REQUIRED","message":"Approve this device first.",
               "fields":{"approvalId":"3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b","code":"123456",
                         "expiresAt":"2026-11-24T18:10:00.000Z","methods":"trustedDevice,serverConsole"}}}"#,
        )
        .unwrap();
        assert_eq!(e.error.code, ErrorCode::DeviceApprovalRequired);
        assert_eq!(e.error.fields.as_ref().unwrap()["code"], "123456");
        let plain: ApiError = serde_json::from_str(
            r#"{"error":{"code":"AI_HOST_START_FAILED","message":"Proxmox said no."}}"#,
        )
        .unwrap();
        assert_eq!(plain.error.code, ErrorCode::AiHostStartFailed);
        assert_eq!(plain.error.fields, None);
        assert!(serde_json::from_str::<ErrorCode>(r#""TEAPOT""#).is_err());
        assert_eq!(
            serde_json::to_string(&ErrorCode::RefreshTokenReused).unwrap(),
            r#""REFRESH_TOKEN_REUSED""#
        );
        assert_eq!(
            serde_json::to_string(&Platform::Macos).unwrap(),
            r#""macos""#
        );
        assert_eq!(
            serde_json::from_str::<UserRole>(r#""owner""#).unwrap(),
            UserRole::Owner
        );
    }
}
