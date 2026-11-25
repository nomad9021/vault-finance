//! Mirrors packages/shared/src/schemas/guiltFree.ts: each person's weekly
//! no-questions-asked money.

use serde::{Deserialize, Serialize};

use crate::budgets::WeekStart;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiltFreePurchase {
    /// The transaction's id.
    pub id: String,
    pub merchant_name: String,
    /// Spent, as a positive number (a refund is negative).
    pub amount_cents: i64,
    /// YYYY-MM-DD.
    pub posted_at: String,
    /// Entered by hand, so removing it deletes it.
    pub manual: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiltFreePerson {
    pub user_id: String,
    pub display_name: String,
    pub avatar_color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_image: Option<String>,
    pub is_me: bool,
    /// Null until it's been set up for them.
    pub category_id: Option<String>,
    /// 0 when none is set.
    pub weekly_cents: i64,
    /// Purchases minus refunds this week.
    pub spent_cents: i64,
    /// Newest first.
    pub purchases: Vec<GuiltFreePurchase>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiltFreeResponse {
    /// The "Guilt-free spending" parent category, once set up.
    pub category_id: Option<String>,
    /// This week's first day, and the day after its last.
    pub week_start: String,
    pub week_end: String,
    pub people: Vec<GuiltFreePerson>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiltFreeQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week_start: Option<WeekStart>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiltFreeAllowance {
    pub user_id: String,
    /// 0 removes the allowance; at most $100,000.
    pub weekly_cents: i64,
}

/// Set weekly amounts; people left out keep theirs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateGuiltFreeRequest {
    pub people: Vec<GuiltFreeAllowance>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_week() {
        let r: GuiltFreeResponse = serde_json::from_str(
            r##"{"categoryId":"b7c8d9e0-f1a2-4b3c-9d4e-5f6071829304","weekStart":"2026-11-23","weekEnd":"2026-11-30",
               "people":[{"userId":"5b0c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f","displayName":"Pat Carter","avatarColor":"#4f7cff",
                 "avatarImage":null,"isMe":true,"categoryId":"c8d9e0f1-a2b3-4c4d-8e5f-607182930415","weeklyCents":7500,
                 "spentCents":2350,"purchases":[
                   {"id":"d9e0f1a2-b3c4-4d5e-9f60-718293041526","merchantName":"Blue Bottle","amountCents":650,
                    "postedAt":"2026-11-24","manual":true},
                   {"id":"e0f1a2b3-c4d5-4e6f-8071-829304152637","merchantName":"Steam","amountCents":1999,
                    "postedAt":"2026-11-23","manual":false},
                   {"id":"f1a2b3c4-d5e6-4f70-9182-930415263748","merchantName":"Steam","amountCents":-299,
                    "postedAt":"2026-11-23","manual":false}]},
                {"userId":"6c1d7a1f-2b3c-4d4e-9f50-6b7c8d9e0f1a","displayName":"Sam","avatarColor":"#e85d75",
                 "isMe":false,"categoryId":null,"weeklyCents":0,"spentCents":0,"purchases":[]}]}"##,
        )
        .unwrap();
        assert_eq!(r.people.len(), 2);
        let pat = &r.people[0];
        assert_eq!(
            pat.purchases.iter().map(|p| p.amount_cents).sum::<i64>(),
            pat.spent_cents
        );
        assert_eq!(r.people[1].category_id, None);
        assert_eq!(
            serde_json::to_string(&GuiltFreeQuery {
                week_start: Some(WeekStart::Sunday)
            })
            .unwrap(),
            r#"{"weekStart":"sunday"}"#
        );
        let body = UpdateGuiltFreeRequest {
            people: vec![GuiltFreeAllowance {
                user_id: "u".into(),
                weekly_cents: 5000,
            }],
        };
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"people":[{"userId":"u","weeklyCents":5000}]}"#
        );
    }
}
