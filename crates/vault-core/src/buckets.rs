//! Mirrors packages/shared/src/schemas/buckets.ts, plus the logic of
//! apps/desktop/src/screens/shell/BucketsView.tsx.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::goals::non_empty;
use crate::money::js_round;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub color: String,
    pub allocated_cents: i64,
    pub target_cents: Option<i64>,
    pub goal_id: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketAccount {
    pub account_id: String,
    pub account_name: String,
    pub account_type: String,
    pub balance_cents: i64,
    pub allocated_cents: i64,
    /// balance − allocated; negative when the buckets add up to more.
    pub unassigned_cents: i64,
    pub buckets: Vec<Bucket>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BucketListResponse {
    pub accounts: Vec<BucketAccount>,
}

impl BucketListResponse {
    /// Savings accounts and anything already split, or every account.
    pub fn shown(&self, show_all: bool) -> Vec<&BucketAccount> {
        self.accounts
            .iter()
            .filter(|a| show_all || a.account_type == "savings" || !a.buckets.is_empty())
            .collect()
    }
}

impl BucketAccount {
    pub fn over(&self) -> bool {
        self.unassigned_cents < 0
    }

    /// Width of a bucket's slice of the split bar, in percent.
    pub fn bar_percent(&self, bucket: &Bucket) -> f64 {
        let total = self.balance_cents.max(self.allocated_cents).max(1);
        bucket.allocated_cents as f64 / total as f64 * 100.0
    }

    /// Goals already backed by another bucket in this account (they can't
    /// be picked again).
    pub fn goals_linked_elsewhere(&self, editing: Option<&str>) -> HashSet<String> {
        self.buckets
            .iter()
            .filter(|b| Some(b.id.as_str()) != editing)
            .filter_map(|b| non_empty(&b.goal_id).map(str::to_string))
            .collect()
    }

    /// What can go into a bucket: unassigned plus what it already holds.
    pub fn available_for(&self, editing: Option<&Bucket>) -> i64 {
        self.unassigned_cents + editing.map_or(0, |b| b.allocated_cents)
    }

    pub fn bucket(&self, id: &str) -> Option<&Bucket> {
        self.buckets.iter().find(|b| b.id == id)
    }
}

impl Bucket {
    /// "40% of $5,000": capped at 100, `None` without a target.
    pub fn target_percent(&self) -> Option<(i64, i64)> {
        let target = self.target_cents.filter(|&t| t != 0)?;
        let pct = js_round(self.allocated_cents as f64 / target as f64 * 100.0).min(100);
        Some((pct, target))
    }
}

/// Body of `updateBucket` (and, with the account id, `createBucket`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub name: String,
    pub allocated_cents: i64,
    pub target_cents: Option<i64>,
    pub goal_id: Option<String>,
}

impl BucketBody {
    /// From the dialog's fields, exactly as BucketDialog builds it.
    pub fn from_form(
        account_id: Option<String>,
        name: &str,
        amount: &str,
        target: &str,
        goal_id: &str,
    ) -> Self {
        use crate::money::parse_amount_to_cents as parse;
        BucketBody {
            account_id,
            name: crate::goals::trim_js(name).to_string(),
            allocated_cents: parse(if amount.is_empty() { "0" } else { amount }).unwrap_or(0),
            target_cents: if target.is_empty() {
                None
            } else {
                parse(target)
            },
            goal_id: (!goal_id.is_empty()).then(|| goal_id.to_string()),
        }
    }
}

/// Body of `moveBucketMoney` (`None` = Unassigned).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveBody {
    pub from_bucket_id: Option<String>,
    pub to_bucket_id: Option<String>,
    pub amount_cents: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r##"{"accounts":[
      {"accountId":"0e5d2a51-5b8e-4b8e-8e0e-2f6a1c9d7b31","accountName":"High-yield savings","accountType":"savings",
       "balanceCents":1200000,"allocatedCents":900000,"unassignedCents":300000,"buckets":[
        {"id":"b1000000-0000-4000-8000-000000000001","accountId":"0e5d2a51-5b8e-4b8e-8e0e-2f6a1c9d7b31",
         "name":"Emergency","color":"#3ecf8e","allocatedCents":600000,"targetCents":1500000,
         "goalId":"6b0e1f0a-4a1c-4f6e-9a51-1f1d2b1c3c4d","sortOrder":0},
        {"id":"b1000000-0000-4000-8000-000000000002","accountId":"0e5d2a51-5b8e-4b8e-8e0e-2f6a1c9d7b31",
         "name":"Vacation","color":"#6f8ef2","allocatedCents":300000,"targetCents":null,"goalId":null,"sortOrder":1}
       ]},
      {"accountId":"1f6e3b62-6c9f-4c9f-9f1f-3a7b2d0e8c42","accountName":"Everyday checking","accountType":"checking",
       "balanceCents":250000,"allocatedCents":0,"unassignedCents":250000,"buckets":[]},
      {"accountId":"2a7f4c73-7d0a-4d0a-8a2a-4b8c3e1f9d53","accountName":"Joint checking","accountType":"checking",
       "balanceCents":100000,"allocatedCents":150000,"unassignedCents":-50000,"buckets":[
        {"id":"b1000000-0000-4000-8000-000000000003","accountId":"2a7f4c73-7d0a-4d0a-8a2a-4b8c3e1f9d53",
         "name":"Car","color":"#d8b23c","allocatedCents":150000,"targetCents":100000,"goalId":null,"sortOrder":0}
       ]}
    ]}"##;

    fn data() -> BucketListResponse {
        serde_json::from_str(SAMPLE).unwrap()
    }

    #[test]
    fn parses_server_shape() {
        let d = data();
        assert_eq!(d.accounts.len(), 3);
        assert_eq!(d.accounts[0].buckets[0].target_cents, Some(1_500_000));
        assert_eq!(d.accounts[2].unassigned_cents, -50_000);
    }

    #[test]
    fn shown_accounts() {
        let d = data();
        let names =
            |v: Vec<&BucketAccount>| v.iter().map(|a| a.account_name.clone()).collect::<Vec<_>>();
        assert_eq!(
            names(d.shown(false)),
            ["High-yield savings", "Joint checking"]
        );
        assert_eq!(d.shown(true).len(), 3);
    }

    #[test]
    fn split_bar_and_targets() {
        let d = data();
        let a = &d.accounts[0];
        assert_eq!(a.bar_percent(&a.buckets[0]), 50.0);
        assert_eq!(a.buckets[0].target_percent(), Some((40, 1_500_000)));
        assert_eq!(a.buckets[1].target_percent(), None);
        let over = &d.accounts[2];
        assert!(over.over());
        assert_eq!(over.bar_percent(&over.buckets[0]), 100.0);
        assert_eq!(over.buckets[0].target_percent(), Some((100, 100_000)));
        assert_eq!(a.available_for(Some(&a.buckets[1])), 600_000);
        assert_eq!(a.available_for(None), 300_000);
    }

    #[test]
    fn goals_taken_by_other_buckets() {
        let d = data();
        let a = &d.accounts[0];
        assert!(a
            .goals_linked_elsewhere(None)
            .contains("6b0e1f0a-4a1c-4f6e-9a51-1f1d2b1c3c4d"));
        assert!(a.goals_linked_elsewhere(Some(&a.buckets[0].id)).is_empty());
    }

    #[test]
    fn bodies() {
        let b = BucketBody::from_form(Some("acct".into()), " Trip ", "", "5,000", "");
        assert_eq!(
            serde_json::to_string(&b).unwrap(),
            r#"{"accountId":"acct","name":"Trip","allocatedCents":0,"targetCents":500000,"goalId":null}"#
        );
        let b = BucketBody::from_form(None, "Trip", "12.5", "x", "g");
        assert_eq!(
            serde_json::to_string(&b).unwrap(),
            r#"{"name":"Trip","allocatedCents":1250,"targetCents":null,"goalId":"g"}"#
        );
        let m = MoveBody {
            from_bucket_id: None,
            to_bucket_id: Some("b".into()),
            amount_cents: 500,
        };
        assert_eq!(
            serde_json::to_string(&m).unwrap(),
            r#"{"fromBucketId":null,"toBucketId":"b","amountCents":500}"#
        );
    }
}
