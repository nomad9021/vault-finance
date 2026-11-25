//! Mirrors packages/shared/src/schemas/setup.ts (first-run setup) and
//! household.ts (the household's own name).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatusResponse {
    pub needs_setup: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupCompleteRequest {
    pub owner_email: String,
    pub owner_password: String,
    pub owner_display_name: String,
    /// Optional: the owner can set or rename it later in Settings. Trimmed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub household_name: Option<String>,
}

/// The household is the server instance itself; `name` is null until set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Household {
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateHouseholdRequest {
    /// Trimmed, 1–60 characters.
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_setup_and_household() {
        let s: SetupStatusResponse = serde_json::from_str(r#"{"needsSetup":true}"#).unwrap();
        assert!(s.needs_setup);
        let h: Household = serde_json::from_str(r#"{"name":"The Carters"}"#).unwrap();
        assert_eq!(h.name.as_deref(), Some("The Carters"));
        assert_eq!(
            serde_json::from_str::<Household>(r#"{"name":null}"#)
                .unwrap()
                .name,
            None
        );
        let req = SetupCompleteRequest {
            owner_email: "pat@carter.family".into(),
            owner_password: "maple otter canyon".into(),
            owner_display_name: "Pat Carter".into(),
            household_name: None,
        };
        assert_eq!(
            serde_json::to_string(&req).unwrap(),
            r#"{"ownerEmail":"pat@carter.family","ownerPassword":"maple otter canyon","ownerDisplayName":"Pat Carter"}"#
        );
    }
}
