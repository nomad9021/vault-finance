//! Mirrors packages/shared/src/schemas/insights.ts.

use serde::Deserialize;

use crate::nav::NavFilter;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InsightSeverity {
    Critical,
    Warning,
    Info,
    Good,
}

impl InsightSeverity {
    /// Display order on the Insights page: most urgent first.
    pub const ORDER: [InsightSeverity; 4] = [Self::Critical, Self::Warning, Self::Info, Self::Good];

    pub fn label(self) -> &'static str {
        match self {
            Self::Critical => "Needs attention",
            Self::Warning => "Worth a look",
            Self::Info => "For information",
            Self::Good => "Going well",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub id: String,
    pub severity: InsightSeverity,
    pub title: String,
    pub detail: String,
    /// Page that resolves this (a `PageId` on the React side).
    pub page: String,
    pub category_id: Option<String>,
    pub account_id: Option<String>,
    pub amount_cents: Option<i64>,
}

impl Insight {
    pub fn filter(&self) -> NavFilter {
        NavFilter {
            category_id: self.category_id.clone(),
            account_id: self.account_id.clone(),
            tab: None,
        }
    }

    /// Budgets show exact cents; everything else rounds to whole dollars.
    pub fn amount_in_cents_exact(&self) -> bool {
        self.page == "budgets"
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightListResponse {
    pub insights: Vec<Insight>,
    pub critical_count: i64,
    pub warning_count: i64,
}

impl InsightListResponse {
    pub fn by_severity(&self, severity: InsightSeverity) -> Vec<&Insight> {
        self.insights
            .iter()
            .filter(|i| i.severity == severity)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "insights": [
        {"id":"a","severity":"critical","title":"Groceries 40% over","detail":"x","page":"budgets",
         "categoryId":"5d1c0c8e-8a43-4a4e-9a51-1f1d2b1c3c4d","accountId":null,"amountCents":12345},
        {"id":"b","severity":"good","title":"Emergency fund on track","detail":"y","page":"goals",
         "categoryId":null,"accountId":null,"amountCents":null}
      ],
      "criticalCount": 1,
      "warningCount": 0
    }"#;

    #[test]
    fn parses_server_shape() {
        let r: InsightListResponse = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(r.insights.len(), 2);
        assert_eq!(r.by_severity(InsightSeverity::Critical).len(), 1);
        assert_eq!(r.insights[0].amount_cents, Some(12345));
        assert!(r.insights[0].amount_in_cents_exact());
        assert!(!r.insights[1].amount_in_cents_exact());
    }

    #[test]
    fn filter_skips_empty_fields() {
        let r: InsightListResponse = serde_json::from_str(SAMPLE).unwrap();
        let f = serde_json::to_string(&r.insights[0].filter()).unwrap();
        assert_eq!(
            f,
            r#"{"categoryId":"5d1c0c8e-8a43-4a4e-9a51-1f1d2b1c3c4d"}"#
        );
        assert_eq!(
            serde_json::to_string(&r.insights[1].filter()).unwrap(),
            "{}"
        );
    }
}
