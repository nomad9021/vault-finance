//! Mirrors packages/shared/src/schemas/guiltFree.ts: each person's weekly
//! no-questions-asked money.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::accounts::{Account, AccountType};
use crate::budgets::WeekStart;
use crate::money::{cents_to_fixed2, parse_amount_to_cents};
use crate::transactions::Transaction;

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

// ── GuiltFreeCard.tsx ──

/// Shown on the card: anyone with an amount or spending this week.
pub fn active_people(people: &[GuiltFreePerson]) -> Vec<GuiltFreePerson> {
    people
        .iter()
        .filter(|p| p.weekly_cents > 0 || p.spent_cents > 0)
        .cloned()
        .collect()
}

/// The tile's bar: share of the week's amount spent (full when spending
/// with no amount).
pub fn spent_share(p: &GuiltFreePerson) -> f64 {
    if p.weekly_cents > 0 {
        p.spent_cents as f64 / p.weekly_cents as f64
    } else if p.spent_cents > 0 {
        1.0
    } else {
        0.0
    }
}

/// The setup field's starting text: "75.00", or empty for none.
pub fn weekly_input(weekly_cents: i64) -> String {
    if weekly_cents != 0 {
        cents_to_fixed2(weekly_cents)
    } else {
        String::new()
    }
}

/// The setup dialog's amounts; `None` when any is invalid (or negative).
/// An empty field is 0.
pub fn parse_allowances(values: &[(String, String)]) -> Option<Vec<GuiltFreeAllowance>> {
    values
        .iter()
        .map(|(user_id, text)| {
            let cents = if text.trim().is_empty() {
                Some(0)
            } else {
                parse_amount_to_cents(text)
            };
            cents.filter(|c| *c >= 0).map(|c| GuiltFreeAllowance {
                user_id: user_id.clone(),
                weekly_cents: c,
            })
        })
        .collect()
}

/// `spendAccounts`: accounts people pay with, most likely first.
pub fn spend_accounts(accounts: &[Account]) -> Vec<Account> {
    let rank = |a: &Account| match a.kind {
        AccountType::CreditCard => 0,
        AccountType::Checking => 1,
        _ => 2,
    };
    let mut out: Vec<Account> = accounts
        .iter()
        .filter(|a| {
            a.archived_at.is_none()
                && matches!(
                    a.kind,
                    AccountType::Checking
                        | AccountType::CreditCard
                        | AccountType::Savings
                        | AccountType::Other
                )
        })
        .cloned()
        .collect();
    out.sort_by_key(rank);
    out
}

/// "Already in transactions": this week's spending that isn't a transfer
/// and isn't anyone's guilt-free already.
pub fn pickable(transactions: &[Transaction], people: &[GuiltFreePerson]) -> Vec<Transaction> {
    let taken: HashSet<&str> = people
        .iter()
        .filter_map(|p| p.category_id.as_deref())
        .filter(|c| !c.is_empty())
        .collect();
    transactions
        .iter()
        .filter(|t| {
            t.amount_cents < 0
                && !t.is_transfer.unwrap_or(false)
                && !taken.contains(t.category_id.as_deref().unwrap_or(""))
        })
        .cloned()
        .collect()
}

/// `createTransaction` for a typed-in purchase.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPurchase {
    pub account_id: String,
    pub category_id: Option<String>,
    pub posted_at: String,
    pub amount_cents: i64,
    pub merchant_name: String,
    pub pending: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(json: serde_json::Value) -> GuiltFreePerson {
        let mut base = serde_json::json!({"userId":"u","displayName":"Pat","avatarColor":"#000","isMe":true,
            "categoryId":"gf-pat","weeklyCents":0,"spentCents":0,"purchases":[]});
        for (k, v) in json.as_object().unwrap() {
            base[k] = v.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn card_figures() {
        let a = person(serde_json::json!({"weeklyCents": 5000, "spentCents": 2500}));
        let b = person(serde_json::json!({"spentCents": 100}));
        let c = person(serde_json::json!({}));
        assert_eq!(active_people(&[a.clone(), b.clone(), c.clone()]).len(), 2);
        assert_eq!(spent_share(&a), 0.5);
        assert_eq!(spent_share(&b), 1.0);
        assert_eq!(spent_share(&c), 0.0);
        assert_eq!(weekly_input(7500), "75.00");
        assert_eq!(weekly_input(0), "");
    }

    #[test]
    fn parses_the_setup_amounts() {
        let ok =
            parse_allowances(&[("a".into(), "12.5".into()), ("b".into(), "  ".into())]).unwrap();
        assert_eq!(ok[0].weekly_cents, 1250);
        assert_eq!(ok[1].weekly_cents, 0);
        assert!(parse_allowances(&[("a".into(), "abc".into())]).is_none());
        assert!(parse_allowances(&[("a".into(), "-5".into())]).is_none());
    }

    #[test]
    fn picks_accounts_and_transactions() {
        let acct = |id: &str, kind: &str, archived: bool| -> Account {
            serde_json::from_value(serde_json::json!({"id":id,"name":id,"type":kind,"institution":null,"mask":null,
                "currency":"USD","isLiability":false,"interestRate":null,"balanceCents":0,
                "archivedAt": if archived { serde_json::json!("2026-01-01") } else { serde_json::Value::Null },
                "createdAt":"2026-01-01","updatedAt":"2026-01-01"}))
            .unwrap()
        };
        let a = spend_accounts(&[
            acct("sav", "savings", false),
            acct("chk", "checking", false),
            acct("inv", "investment", false),
            acct("cc", "credit_card", false),
            acct("old", "credit_card", true),
        ]);
        let ids: Vec<&str> = a.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["cc", "chk", "sav"]);

        let txn = |id: &str,
                   amount: i64,
                   cat: Option<&str>,
                   transfer: Option<bool>|
         -> Transaction {
            serde_json::from_value(serde_json::json!({"id":id,"accountId":"chk","categoryId":cat,"postedAt":"2026-11-24",
                "amountCents":amount,"currency":"USD","merchantName":id,"description":null,"pending":false,
                "notes":null,"isTransfer":transfer,"createdAt":"2026-11-24"}))
            .unwrap()
        };
        let people = [
            person(serde_json::json!({})),
            person(serde_json::json!({"categoryId": null})),
        ];
        let p = pickable(
            &[
                txn("coffee", -450, None, None),
                txn("refund", 450, None, None),
                txn("move", -1000, None, Some(true)),
                txn("mine", -300, Some("gf-pat"), Some(false)),
                txn("food", -2000, Some("groc"), Some(false)),
            ],
            &people,
        );
        let ids: Vec<&str> = p.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["coffee", "food"]);
    }

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
