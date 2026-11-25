//! Mirrors packages/shared/src/schemas/categorize.ts: keyword rules and the
//! bulk auto-categorization sweep.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorizationRule {
    pub id: String,
    /// Case-insensitive substring of the merchant name.
    pub keyword: String,
    pub category_id: String,
    pub priority: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRuleRequest {
    pub keyword: String,
    pub category_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleListResponse {
    pub rules: Vec<CategorizationRule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutocategorizeResponse {
    pub scanned: i64,
    pub categorized: i64,
    pub by_rule: i64,
    pub by_history: i64,
    pub by_ai: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rules_and_sweeps() {
        let r: RuleListResponse = serde_json::from_str(
            r#"{"rules":[{"id":"a6b7c8d9-e0f1-4a2b-8c3d-4e5f60718293","keyword":"shell",
                "categoryId":"7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","priority":100}]}"#,
        )
        .unwrap();
        assert_eq!(r.rules[0].keyword, "shell");
        let a: AutocategorizeResponse = serde_json::from_str(
            r#"{"scanned":58,"categorized":41,"byRule":12,"byHistory":27,"byAi":2}"#,
        )
        .unwrap();
        assert_eq!(a.by_rule + a.by_history + a.by_ai, a.categorized);
        let body = CreateRuleRequest {
            keyword: "shell".into(),
            category_id: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d".into(),
            priority: None,
        };
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"keyword":"shell","categoryId":"7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"}"#
        );
    }
}
