use serde::{Deserialize, Serialize};

/// Filter carried into a page by a cross-page link (mirrors `NavFilter` in
/// apps/desktop/src/screens/shell/nav.ts). Empty fields are left out so the
/// React side sees `{}` rather than `{ categoryId: null }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NavFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Which in-page tab to open on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
}

impl NavFilter {
    pub fn account(id: &str) -> Self {
        NavFilter {
            account_id: Some(id.to_string()),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_the_shell_passes() {
        let f: NavFilter = serde_json::from_str(r#"{"tab":"buckets"}"#).unwrap();
        assert_eq!(f.tab.as_deref(), Some("buckets"));
        assert_eq!(
            serde_json::to_string(&NavFilter::account("a")).unwrap(),
            r#"{"accountId":"a"}"#
        );
    }
}
