use serde::Serialize;

/// Filter carried into a page by a cross-page link (mirrors `NavFilter` in
/// apps/desktop/src/screens/shell/nav.ts). Empty fields are left out so the
/// React side sees `{}` rather than `{ categoryId: null }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}
