//! Mirrors packages/shared/src/schemas/subscriptions.ts, plus the pure logic of
//! apps/desktop/src/screens/shell/SubscriptionsPage.tsx.

use serde::{Deserialize, Serialize};

use crate::nav::NavFilter;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubscriptionCadence {
    Weekly,
    Monthly,
    Quarterly,
    Yearly,
}

impl SubscriptionCadence {
    /// The enum value as the server spells it (and as the page prints it).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
            Self::Quarterly => "quarterly",
            Self::Yearly => "yearly",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: String,
    pub merchant_name: String,
    pub amount_cents: i64,
    pub monthly_cents: i64,
    pub cadence: SubscriptionCadence,
    pub occurrences: i64,
    /// `YYYY-MM-DD`.
    pub last_charged_at: String,
    /// `YYYY-MM-DD`.
    pub next_expected_at: String,
    pub category_id: Option<String>,
    pub account_id: Option<String>,
    pub confidence: f64,
    pub price_increase_cents: Option<i64>,
    pub stale: bool,
    pub bill_id: Option<String>,
}

impl Subscription {
    /// A price rise is only flagged on rows that are still charging.
    pub fn shown_increase(&self) -> Option<i64> {
        self.price_increase_cents.filter(|_| !self.stale)
    }

    /// `Math.round(confidence * 100)`.
    pub fn regular_percent(&self) -> i64 {
        (self.confidence * 100.0 + 0.5).floor() as i64
    }

    /// "Charges" link: the transactions page, narrowed to the account when known.
    pub fn filter(&self) -> NavFilter {
        NavFilter {
            account_id: self.account_id.clone(),
            ..Default::default()
        }
    }

    /// The body `trackAsBill` sends to `createBill`.
    pub fn bill_request(&self) -> CreateBillRequest {
        CreateBillRequest {
            name: self.merchant_name.clone(),
            amount_cents: self.amount_cents,
            due_day: due_day(&self.next_expected_at),
            cadence: self.cadence,
            category_id: self.category_id.clone(),
            account_id: self.account_id.clone(),
        }
    }
}

/// `Number(iso.slice(8, 10))`: the day of month of a `YYYY-MM-DD` date.
pub fn due_day(iso: &str) -> u32 {
    iso.get(8..10).and_then(|d| d.parse().ok()).unwrap_or(0)
}

/// The subset of `CreateBillRequest` the Subscriptions page sends. Empty ids
/// are left out, like the React spread `...(id ? { id } : {})`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBillRequest {
    pub name: String,
    pub amount_cents: i64,
    pub due_day: u32,
    pub cadence: SubscriptionCadence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionListResponse {
    pub subscriptions: Vec<Subscription>,
    #[serde(default)]
    pub dismissed: Vec<Subscription>,
    #[serde(default)]
    pub tracked_as_bill_count: i64,
    pub monthly_total_cents: i64,
    pub yearly_total_cents: i64,
}

impl SubscriptionListResponse {
    pub fn active(&self) -> Vec<Subscription> {
        self.subscriptions
            .iter()
            .filter(|s| !s.stale)
            .cloned()
            .collect()
    }

    pub fn stale(&self) -> Vec<Subscription> {
        self.subscriptions
            .iter()
            .filter(|s| s.stale)
            .cloned()
            .collect()
    }

    /// How many still-charging subscriptions went up in price.
    pub fn increase_count(&self) -> usize {
        self.subscriptions
            .iter()
            .filter(|s| s.shown_increase().is_some())
            .count()
    }

    /// Nothing detected, hidden or tracked: show the empty state.
    pub fn is_empty(&self) -> bool {
        self.subscriptions.is_empty()
            && self.dismissed.is_empty()
            && self.tracked_as_bill_count == 0
    }

    pub fn active_subtitle(&self) -> String {
        if self.tracked_as_bill_count > 0 {
            format!(
                "Detected from your history · {} more tracked as bills",
                self.tracked_as_bill_count
            )
        } else {
            "Detected from your history".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "subscriptions": [
        {"id":"netflix","merchantName":"Netflix","amountCents":1799,"monthlyCents":1799,
         "cadence":"monthly","occurrences":6,"lastChargedAt":"2026-11-03","nextExpectedAt":"2026-12-03",
         "categoryId":"5d1c0c8e-8a43-4a4e-9a51-1f1d2b1c3c4d","accountId":"0b6f4a52-3c1e-4d0f-9a7e-2f6b8c1d9e04",
         "confidence":0.945,"priceIncreaseCents":200,"stale":false,"billId":null},
        {"id":"gym","merchantName":"City Gym","amountCents":4500,"monthlyCents":4500,
         "cadence":"monthly","occurrences":4,"lastChargedAt":"2026-08-15","nextExpectedAt":"2026-09-15",
         "categoryId":null,"accountId":null,"confidence":0.8,"priceIncreaseCents":500,"stale":true,"billId":null},
        {"id":"icloud","merchantName":"iCloud","amountCents":299,"monthlyCents":299,
         "cadence":"monthly","occurrences":12,"lastChargedAt":"2026-11-20","nextExpectedAt":"2026-12-20",
         "categoryId":null,"accountId":null,"confidence":1,"priceIncreaseCents":null,"stale":false,"billId":null}
      ],
      "monthlyTotalCents": 2098,
      "yearlyTotalCents": 25176
    }"#;

    fn sample() -> SubscriptionListResponse {
        serde_json::from_str(SAMPLE).unwrap()
    }

    #[test]
    fn parses_server_shape_with_defaults() {
        let r = sample();
        assert_eq!(r.subscriptions.len(), 3);
        assert!(r.dismissed.is_empty());
        assert_eq!(r.tracked_as_bill_count, 0);
        assert_eq!(r.subscriptions[0].cadence, SubscriptionCadence::Monthly);
        assert_eq!(r.subscriptions[0].price_increase_cents, Some(200));
    }

    #[test]
    fn splits_active_and_stale() {
        let r = sample();
        let active: Vec<_> = r.active().into_iter().map(|s| s.id).collect();
        assert_eq!(active, ["netflix", "icloud"]);
        assert_eq!(r.stale()[0].id, "gym");
        // The gym's rise doesn't count: it's stale.
        assert_eq!(r.increase_count(), 1);
        assert_eq!(r.subscriptions[1].shown_increase(), None);
        assert!(!r.is_empty());
    }

    #[test]
    fn empty_only_when_nothing_anywhere() {
        let mut r = sample();
        r.subscriptions.clear();
        assert!(r.is_empty());
        assert_eq!(r.active_subtitle(), "Detected from your history");
        r.tracked_as_bill_count = 2;
        assert!(!r.is_empty());
        assert_eq!(
            r.active_subtitle(),
            "Detected from your history · 2 more tracked as bills"
        );
    }

    #[test]
    fn rounds_confidence_like_math_round() {
        let r = sample();
        assert_eq!(r.subscriptions[0].regular_percent(), 95); // 94.5 → 95
        assert_eq!(r.subscriptions[1].regular_percent(), 80);
        assert_eq!(r.subscriptions[2].regular_percent(), 100);
    }

    #[test]
    fn bill_request_matches_track_as_bill() {
        let r = sample();
        assert_eq!(
            serde_json::to_string(&r.subscriptions[0].bill_request()).unwrap(),
            r#"{"name":"Netflix","amountCents":1799,"dueDay":3,"cadence":"monthly","categoryId":"5d1c0c8e-8a43-4a4e-9a51-1f1d2b1c3c4d","accountId":"0b6f4a52-3c1e-4d0f-9a7e-2f6b8c1d9e04"}"#
        );
        assert_eq!(
            serde_json::to_string(&r.subscriptions[1].bill_request()).unwrap(),
            r#"{"name":"City Gym","amountCents":4500,"dueDay":15,"cadence":"monthly"}"#
        );
        assert_eq!(due_day("2026-12-31"), 31);
    }

    #[test]
    fn filter_carries_account_only() {
        let r = sample();
        assert_eq!(
            serde_json::to_string(&r.subscriptions[0].filter()).unwrap(),
            r#"{"accountId":"0b6f4a52-3c1e-4d0f-9a7e-2f6b8c1d9e04"}"#
        );
        assert_eq!(
            serde_json::to_string(&r.subscriptions[2].filter()).unwrap(),
            "{}"
        );
    }
}
