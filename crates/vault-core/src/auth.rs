//! Mirrors packages/shared/src/schemas/auth.ts: sign-in, sessions, 2FA,
//! device keys and device approval (ADR-0009).

use serde::{Deserialize, Serialize};

use crate::common::{Platform, UserRole};
use crate::user::User;

/// This install's identity on one server (kept in the OS keychain).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_secret: String,
}

/// `DeviceIdentity.partial()`, flattened into the sign-in requests.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaybeDeviceIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_secret: Option<String>,
}

impl From<Option<&DeviceIdentity>> for MaybeDeviceIdentity {
    fn from(d: Option<&DeviceIdentity>) -> Self {
        Self {
            device_id: d.map(|d| d.device_id.clone()),
            device_secret: d.map(|d| d.device_secret.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    pub device_name: String,
    pub platform: Platform,
    /// 6-digit TOTP code, only when the account has 2FA on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_code: Option<String>,
    #[serde(flatten)]
    pub device: MaybeDeviceIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user: User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRequest {
    pub refresh_token: String,
    #[serde(flatten)]
    pub device: MaybeDeviceIdentity,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutRequest {
    pub refresh_token: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSession {
    pub id: String,
    pub device_name: String,
    pub platform: Platform,
    pub ip_address: Option<String>,
    pub created_at: String,
    pub last_used_at: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListResponse {
    pub sessions: Vec<DeviceSession>,
}

/// Login-screen profile (unauthenticated; no email).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProfile {
    pub id: String,
    pub display_name: String,
    pub avatar_color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_image: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesResponse {
    pub profiles: Vec<PublicProfile>,
    /// "The Carters"; null (or absent on older servers) until the owner sets one.
    #[serde(default)]
    pub household_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginByIdRequest {
    pub user_id: String,
    pub password: String,
    pub device_name: String,
    pub platform: Platform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_code: Option<String>,
    #[serde(flatten)]
    pub device: MaybeDeviceIdentity,
}

// ── Two-factor authentication (TOTP) ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TotpStatusResponse {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpSetupResponse {
    /// Base32.
    pub secret: String,
    /// `otpauth://…` for the QR code.
    pub otpauth_uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TotpEnableRequest {
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TotpDisableRequest {
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

/// Claims carried in the access JWT.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessTokenClaims {
    /// User id.
    pub sub: String,
    /// Device session id.
    pub sid: String,
    pub role: UserRole,
}

// ── Device keys (biometric sign-in) ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDeviceKeyRequest {
    pub device_name: String,
    pub platform: Platform,
}

/// `key` is `<id>.<secret>`, shown exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateDeviceKeyResponse {
    pub id: String,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKey {
    pub id: String,
    pub device_name: String,
    pub platform: Platform,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceKeyListResponse {
    pub keys: Vec<DeviceKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKeyLoginRequest {
    pub key: String,
    pub device_name: String,
    pub platform: Platform,
    #[serde(flatten)]
    pub device: MaybeDeviceIdentity,
}

// ── Device approval (ADR-0009) ──

/// The `fields` of a 403 DEVICE_APPROVAL_REQUIRED.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceApprovalChallenge {
    pub approval_id: String,
    /// Six digits, shown on the new device.
    pub code: String,
    pub expires_at: String,
    /// Comma-separated: "trustedDevice", "serverConsole".
    pub methods: String,
}

impl DeviceApprovalChallenge {
    pub fn method_list(&self) -> Vec<&str> {
        self.methods
            .split(',')
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceApprovalStatusRequest {
    pub approval_id: String,
    pub device_id: String,
    pub device_secret: String,
}

/// Polled by the waiting device. `Approved` carries the session, once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum DeviceApprovalStatusResponse {
    Pending {
        #[serde(rename = "expiresAt")]
        expires_at: String,
    },
    Approved {
        login: LoginResponse,
    },
    Denied,
    Expired,
}

/// A sign-in waiting for approval, as an approver sees it (never the code).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub id: String,
    pub user_id: String,
    pub user_display_name: String,
    pub device_name: String,
    pub platform: Platform,
    pub ip_address: Option<String>,
    pub requested_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingApprovalListResponse {
    pub approvals: Vec<PendingApproval>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApproveDeviceRequest {
    pub code: String,
}

/// `ApproveDeviceRequest`'s rule: exactly six digits.
pub fn is_approval_code(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovedVia {
    Device,
    Console,
    Bootstrap,
    ExistingSession,
    DeviceKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedDevice {
    pub id: String,
    pub user_id: String,
    pub user_display_name: String,
    pub device_name: String,
    pub platform: Platform,
    pub approved_at: Option<String>,
    pub approved_via: Option<ApprovedVia>,
    pub last_seen_at: Option<String>,
    /// The device making this request.
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustedDeviceListResponse {
    pub devices: Vec<TrustedDevice>,
}

/// Which ways a new device can be approved. At least one stays on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceApprovalSettings {
    pub trusted_device: bool,
    pub server_console: bool,
}

impl DeviceApprovalSettings {
    pub fn problem(&self) -> Option<&'static str> {
        (!self.trusted_device && !self.server_console)
            .then_some("Keep at least one way to approve new devices turned on.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOGIN: &str = r##"{"accessToken":"eyJhbGciOiJIUzI1NiJ9.e30.sig","refreshToken":"r.0f9e8d7c",
        "user":{"id":"5b0c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f","email":"pat@carter.family","displayName":"Pat Carter",
                "avatarColor":"#4f7cff","role":"owner","createdAt":"2026-01-04T15:22:10.000Z"}}"##;

    #[test]
    fn parses_sign_in_and_sessions() {
        let l: LoginResponse = serde_json::from_str(LOGIN).unwrap();
        assert_eq!(l.user.display_name, "Pat Carter");
        let s: SessionListResponse = serde_json::from_str(
            r#"{"sessions":[{"id":"8d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f","deviceName":"Pat's MacBook Air",
                "platform":"macos","ipAddress":"192.168.1.44","createdAt":"2026-11-01T09:00:00.000Z",
                "lastUsedAt":"2026-11-24T17:58:12.000Z","isCurrent":true},
               {"id":"9e3f4051-6b7c-4d8e-9fa0-1b2c3d4e5f60","deviceName":"Sam's iPhone","platform":"ios",
                "ipAddress":null,"createdAt":"2026-10-12T19:30:00.000Z","lastUsedAt":"2026-11-20T07:12:00.000Z",
                "isCurrent":false}]}"#,
        )
        .unwrap();
        assert_eq!(s.sessions[1].platform, Platform::Ios);
        assert_eq!(s.sessions[1].ip_address, None);
        let p: ProfilesResponse = serde_json::from_str(
            r##"{"profiles":[{"id":"5b0c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f","displayName":"Pat Carter","avatarColor":"#4f7cff",
                "avatarImage":"data:image/png;base64,iVBORw0KGgo="},
               {"id":"6c1d7a1f-2b3c-4d4e-9f50-6b7c8d9e0f1a","displayName":"Sam","avatarColor":"#e85d75"}]}"##,
        )
        .unwrap();
        assert_eq!(p.household_name, None);
        assert!(p.profiles[0].avatar_image.is_some() && p.profiles[1].avatar_image.is_none());
    }

    #[test]
    fn sign_in_bodies_flatten_the_device_identity() {
        let req = LoginByIdRequest {
            user_id: "5b0c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f".into(),
            password: "maple otter canyon".into(),
            device_name: "Pat's MacBook Air".into(),
            platform: Platform::Macos,
            totp_code: None,
            device: Some(&DeviceIdentity {
                device_id: "11111111-2222-4333-8444-555555555555".into(),
                device_secret: "s".repeat(44),
            })
            .into(),
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["deviceId"], "11111111-2222-4333-8444-555555555555");
        assert!(v.get("totpCode").is_none() && v.get("device").is_none());
        let bare = RefreshRequest {
            refresh_token: "r".into(),
            device: None.into(),
        };
        assert_eq!(
            serde_json::to_string(&bare).unwrap(),
            r#"{"refreshToken":"r"}"#
        );
    }

    #[test]
    fn parses_device_approval() {
        let pending: DeviceApprovalStatusResponse =
            serde_json::from_str(r#"{"status":"pending","expiresAt":"2026-11-24T18:10:00.000Z"}"#)
                .unwrap();
        assert!(matches!(
            pending,
            DeviceApprovalStatusResponse::Pending { .. }
        ));
        let approved: DeviceApprovalStatusResponse =
            serde_json::from_str(&format!(r#"{{"status":"approved","login":{LOGIN}}}"#)).unwrap();
        let DeviceApprovalStatusResponse::Approved { login } = approved else {
            panic!("not approved")
        };
        assert_eq!(login.refresh_token, "r.0f9e8d7c");
        assert_eq!(
            serde_json::from_str::<DeviceApprovalStatusResponse>(r#"{"status":"denied"}"#).unwrap(),
            DeviceApprovalStatusResponse::Denied
        );
        let devices: TrustedDeviceListResponse = serde_json::from_str(
            r#"{"devices":[{"id":"a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d","userId":"5b0c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
                "userDisplayName":"Pat Carter","deviceName":"Pat's MacBook Air","platform":"macos",
                "approvedAt":"2026-11-01T09:00:00.000Z","approvedVia":"existing-session",
                "lastSeenAt":"2026-11-24T17:58:12.000Z","current":true},
               {"id":"b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e","userId":"6c1d7a1f-2b3c-4d4e-9f50-6b7c8d9e0f1a",
                "userDisplayName":"Sam","deviceName":"DESKTOP-7Q2","platform":"windows","approvedAt":null,
                "approvedVia":null,"lastSeenAt":null,"current":false}]}"#,
        )
        .unwrap();
        assert_eq!(
            devices.devices[0].approved_via,
            Some(ApprovedVia::ExistingSession)
        );
        let ch: DeviceApprovalChallenge = serde_json::from_str(
            r#"{"approvalId":"3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b","code":"042917",
                "expiresAt":"2026-11-24T18:10:00.000Z","methods":"trustedDevice,serverConsole"}"#,
        )
        .unwrap();
        assert_eq!(ch.method_list(), ["trustedDevice", "serverConsole"]);
        assert!(
            is_approval_code(&ch.code) && !is_approval_code("12345") && !is_approval_code("12a456")
        );
        assert!(DeviceApprovalSettings {
            trusted_device: false,
            server_console: false
        }
        .problem()
        .is_some());
    }

    #[test]
    fn parses_device_keys_and_totp() {
        let k: DeviceKeyListResponse = serde_json::from_str(
            r#"{"keys":[{"id":"c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f","deviceName":"Pat's MacBook Air",
                "platform":"macos","createdAt":"2026-11-02T10:00:00.000Z","lastUsedAt":null}]}"#,
        )
        .unwrap();
        assert_eq!(k.keys[0].last_used_at, None);
        let t: TotpSetupResponse = serde_json::from_str(
            r#"{"secret":"JBSWY3DPEHPK3PXP","otpauthUri":"otpauth://totp/Vault%20Finance:pat?secret=JBSWY3DPEHPK3PXP"}"#,
        )
        .unwrap();
        assert!(t.otpauth_uri.starts_with("otpauth://"));
        let c: AccessTokenClaims = serde_json::from_str(
            r#"{"sub":"5b0c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f","sid":"8d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f","role":"member"}"#,
        )
        .unwrap();
        assert_eq!(c.role, UserRole::Member);
    }
}
