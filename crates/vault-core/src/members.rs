//! Mirrors packages/shared/src/schemas/members.ts: household members,
//! invites and the owner's connected mailbox.

use serde::{Deserialize, Serialize};

use crate::common::UserRole;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_image: Option<String>,
    pub email: String,
    pub role: UserRole,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInvite {
    pub id: String,
    pub display_name: String,
    pub email: String,
    pub invited_by_name: Option<String>,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberListResponse {
    pub members: Vec<Member>,
    pub invites: Vec<PendingInvite>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteMemberRequest {
    /// Optional: the invited person can set their own name when they accept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub email: String,
    /// The address the owner's app uses; builds the link when APP_PUBLIC_URL is unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    /// False creates the invite and returns its link without emailing anyone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_email: Option<bool>,
}

/// Defaults fill in what an older server leaves out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteMemberResponse {
    pub invite_url: String,
    /// True only once a mail server accepted the message.
    #[serde(default)]
    pub emailed: bool,
    #[serde(default)]
    pub sent_from: Option<String>,
    /// Why it wasn't emailed, in words to show the owner.
    #[serde(default)]
    pub email_problem: Option<String>,
}

/// The owner's connected mailbox. The password is never returned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailConnectionStatus {
    pub connected: bool,
    pub from_email: Option<String>,
    /// A server-wide SMTP relay exists, so invites can send without connecting.
    pub server_mail_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectEmailRequest {
    pub email: String,
    pub password: String,
    /// Only for providers without a known mail server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MailServer {
    pub host: &'static str,
    pub port: u16,
}

const MAIL_SERVERS: &[(&str, MailServer)] = &[
    (
        "gmail.com",
        MailServer {
            host: "smtp.gmail.com",
            port: 465,
        },
    ),
    (
        "googlemail.com",
        MailServer {
            host: "smtp.gmail.com",
            port: 465,
        },
    ),
    (
        "yahoo.com",
        MailServer {
            host: "smtp.mail.yahoo.com",
            port: 465,
        },
    ),
    (
        "aol.com",
        MailServer {
            host: "smtp.aol.com",
            port: 465,
        },
    ),
    (
        "icloud.com",
        MailServer {
            host: "smtp.mail.me.com",
            port: 587,
        },
    ),
    (
        "me.com",
        MailServer {
            host: "smtp.mail.me.com",
            port: 587,
        },
    ),
    (
        "mac.com",
        MailServer {
            host: "smtp.mail.me.com",
            port: 587,
        },
    ),
    (
        "fastmail.com",
        MailServer {
            host: "smtp.fastmail.com",
            port: 465,
        },
    ),
];

/// The mail server for well-known providers, so most owners never see one.
pub fn mail_server_for(email: &str) -> Option<MailServer> {
    let lower = crate::serde_util::js_trim(email).to_lowercase();
    // `split("@")[1]`: the part between the first and second "@".
    let domain = lower.split('@').nth(1)?;
    MAIL_SERVERS
        .iter()
        .find(|(d, _)| *d == domain)
        .map(|(_, s)| *s)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMemberRequest {
    pub display_name: String,
    pub email: String,
    pub temp_password: String,
}

/// Public: what the invite-accept page shows before the person sets a password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreviewResponse {
    pub display_name: String,
    pub email: String,
    pub invited_by_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInviteRequest {
    pub password: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_members_and_invites() {
        let r: MemberListResponse = serde_json::from_str(
            r##"{"members":[{"id":"5b0c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f","displayName":"Pat Carter","avatarColor":"#4f7cff",
                 "avatarImage":null,"email":"pat@carter.family","role":"owner","createdAt":"2026-01-04T15:22:10.000Z"},
                {"id":"6c1d7a1f-2b3c-4d4e-9f50-6b7c8d9e0f1a","displayName":"Sam","email":"sam@carter.family",
                 "role":"member","createdAt":"2026-02-11T08:00:00.000Z"}],
               "invites":[{"id":"d3e4f5a6-b7c8-4d9e-8f0a-1b2c3d4e5f60","displayName":"Jordan","email":"jordan@example.com",
                 "invitedByName":"Pat Carter","createdAt":"2026-11-20T12:00:00.000Z","expiresAt":"2026-11-27T12:00:00.000Z"}]}"##,
        )
        .unwrap();
        assert_eq!(r.members[1].avatar_color, None);
        assert_eq!(r.invites[0].invited_by_name.as_deref(), Some("Pat Carter"));
        // An older server only sends the link.
        let old: InviteMemberResponse =
            serde_json::from_str(r#"{"inviteUrl":"/invite?token=a.b"}"#).unwrap();
        assert!(!old.emailed && old.sent_from.is_none() && old.email_problem.is_none());
        let new: InviteMemberResponse = serde_json::from_str(
            r#"{"inviteUrl":"https://vault.example/invite?token=a.b","emailed":false,"sentFrom":null,
                "emailProblem":"Gmail turned the password down. Use an app password."}"#,
        )
        .unwrap();
        assert!(new.email_problem.is_some());
        let e: EmailConnectionStatus = serde_json::from_str(
            r#"{"connected":true,"fromEmail":"pat@gmail.com","serverMailAvailable":false}"#,
        )
        .unwrap();
        assert!(e.connected);
        let body = InviteMemberRequest {
            email: "jordan@example.com".into(),
            send_email: Some(false),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"email":"jordan@example.com","sendEmail":false}"#
        );
    }

    #[test]
    fn knows_common_mail_servers() {
        assert_eq!(
            mail_server_for(" Pat@GMail.com "),
            Some(MailServer {
                host: "smtp.gmail.com",
                port: 465
            })
        );
        assert_eq!(mail_server_for("sam@icloud.com").unwrap().port, 587);
        assert_eq!(mail_server_for("pat@carter.family"), None);
        assert_eq!(mail_server_for("no-at-sign"), None);
    }
}
