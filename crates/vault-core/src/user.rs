//! Mirrors the account half of packages/shared/src/schemas/user.ts. The
//! preferences half (`UserPreferences`, `DashboardWidget`) is in
//! [`crate::preferences`].

use serde::{Deserialize, Serialize};

use crate::common::UserRole;
use crate::serde_util;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: String,
    /// `#rrggbb`.
    pub avatar_color: String,
    /// A JPEG, PNG or WebP `data:` URL (nullish: absent or null = none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_image: Option<String>,
    pub role: UserRole,
    pub created_at: String,
}

/// `UpdateMeRequest`: every field optional; `avatar_image: Some(None)` sends
/// `null` to remove the picture.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_color: Option<String>,
    #[serde(
        default,
        deserialize_with = "serde_util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub avatar_image: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_password: Option<String>,
}

/// `#rrggbb`, as the avatar colour and category colour schemas require.
pub fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The `AvatarImage` schema: why `s` isn't a usable picture, or `None`.
pub fn avatar_image_problem(s: &str) -> Option<&'static str> {
    if s.len() > 300_000 {
        return Some("That picture is too large — pick a smaller one.");
    }
    let ok = ["jpeg", "png", "webp"].iter().any(|kind| {
        let prefix = format!("data:image/{kind};base64,");
        s.strip_prefix(prefix.as_str()).is_some_and(|b64| {
            !b64.is_empty()
                && b64
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
        })
    });
    if ok {
        None
    } else {
        Some("Use a JPEG, PNG or WebP picture.")
    }
}

impl UpdateMeRequest {
    /// The schema's refine: a new password needs the current one.
    pub fn problem(&self) -> Option<&'static str> {
        let new = self.new_password.as_deref().is_some_and(|p| !p.is_empty());
        let current = self
            .current_password
            .as_deref()
            .is_some_and(|p| !p.is_empty());
        (new && !current).then_some("currentPassword is required to set a new password")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_user() {
        let u: User = serde_json::from_str(
            r##"{"id":"5b0c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f","email":"pat@carter.family",
                "displayName":"Pat Carter","avatarColor":"#4f7cff","avatarImage":null,
                "role":"owner","createdAt":"2026-01-04T15:22:10.000Z"}"##,
        )
        .unwrap();
        assert_eq!(u.display_name, "Pat Carter");
        assert_eq!(u.role, UserRole::Owner);
        assert_eq!(u.avatar_image, None);
        let older: User = serde_json::from_str(
            r##"{"id":"6c1d7a1f-2b3c-4d4e-9f50-6b7c8d9e0f1a","email":"sam@carter.family",
                "displayName":"Sam","avatarColor":"#e85d75","role":"member",
                "createdAt":"2026-02-11T08:00:00.000Z"}"##,
        )
        .unwrap();
        assert_eq!(older.role, UserRole::Member);
    }

    #[test]
    fn update_me_body() {
        let remove_picture = UpdateMeRequest {
            avatar_image: Some(None),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&remove_picture).unwrap(),
            r#"{"avatarImage":null}"#
        );
        let pw = UpdateMeRequest {
            new_password: Some("maple otter canyon".into()),
            ..Default::default()
        };
        assert!(pw.problem().is_some());
        assert!(is_hex_color("#4f7cFF") && !is_hex_color("4f7cff") && !is_hex_color("#4f7cfg"));
        assert_eq!(
            avatar_image_problem("data:image/png;base64,iVBORw0KGgo="),
            None
        );
        assert!(avatar_image_problem("data:image/gif;base64,R0lG").is_some());
    }
}
