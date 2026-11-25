//! Mirrors packages/shared/src/schemas/subscriptions.ts: recurring charges
//! detected from transaction history.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubscriptionCadence {
    Weekly,
    Monthly,
    Quarterly,
    Yearly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    /// Stable id derived from the merchant name.
    pub id: String,
    pub merchant_name: String,
    /// Most recent charge.
    pub amount_cents: i64,
    /// Typical (median) charge as a monthly equivalent.
    pub monthly_cents: i64,
    pub cadence: SubscriptionCadence,
    pub occurrences: i64,
    /// YYYY-MM-DD.
    pub last_charged_at: String,
    pub next_expected_at: String,
    pub category_id: Option<String>,
    pub account_id: Option<String>,
    /// 0–1: how regular the intervals are.
    pub confidence: f64,
    /// Latest minus previous amount when it went up.
    pub price_increase_cents: Option<i64>,
    /// The next charge is overdue — possibly cancelled.
    pub stale: bool,
    /// Set when a tracked bill already covers this merchant.
    pub bill_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionListResponse {
    pub subscriptions: Vec<Subscription>,
    /// Marked "not a subscription" (default `[]` on older servers).
    #[serde(default)]
    pub dismissed: Vec<Subscription>,
    #[serde(default)]
    pub tracked_as_bill_count: i64,
    pub monthly_total_cents: i64,
    pub yearly_total_cents: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_detected_subscriptions() {
        let r: SubscriptionListResponse = serde_json::from_str(
            r#"{"subscriptions":[{"id":"netflix","merchantName":"Netflix","amountCents":1799,"monthlyCents":1799,
                 "cadence":"monthly","occurrences":11,"lastChargedAt":"2026-11-08","nextExpectedAt":"2026-12-08",
                 "categoryId":"0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d","accountId":"2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
                 "confidence":0.94,"priceIncreaseCents":250,"stale":false,"billId":null},
                {"id":"costco-membership","merchantName":"Costco Membership","amountCents":6500,"monthlyCents":542,
                 "cadence":"yearly","occurrences":2,"lastChargedAt":"2026-03-14","nextExpectedAt":"2027-03-14",
                 "categoryId":null,"accountId":null,"confidence":0.7,"priceIncreaseCents":null,"stale":false,"billId":null}],
               "monthlyTotalCents":2341,"yearlyTotalCents":28092}"#,
        )
        .unwrap();
        assert_eq!(r.subscriptions[1].cadence, SubscriptionCadence::Yearly);
        assert_eq!(r.subscriptions[0].price_increase_cents, Some(250));
        // Older servers leave these out.
        assert!(r.dismissed.is_empty());
        assert_eq!(r.tracked_as_bill_count, 0);
    }
}
