//! Mirrors the transaction list in packages/shared/src/schemas/transactions.ts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: String,
    pub account_id: String,
    pub category_id: Option<String>,
    /// "YYYY-MM-DD".
    pub posted_at: String,
    pub amount_cents: i64,
    pub currency: String,
    pub merchant_name: String,
    pub description: Option<String>,
    pub pending: bool,
    pub notes: Option<String>,
    #[serde(default)]
    pub is_transfer: Option<bool>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionListResponse {
    pub transactions: Vec<Transaction>,
    pub next_cursor: Option<String>,
    pub total_count: i64,
    pub sum_in_cents: i64,
    pub sum_out_cents: i64,
}

/// `client.transactions(query)`. Unset fields are left out.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// A category id, or "none" for uncategorized.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_page_of_transactions() {
        let r: TransactionListResponse = serde_json::from_str(
            r#"{"transactions":[{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","accountId":"0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9",
              "categoryId":null,"postedAt":"2026-11-03","amountCents":-4523,"currency":"USD","merchantName":"Corner Market",
              "description":null,"pending":false,"notes":null,"createdAt":"2026-11-03T12:00:00.000Z"}],
              "nextCursor":null,"totalCount":1,"sumInCents":0,"sumOutCents":4523}"#,
        )
        .unwrap();
        assert_eq!(r.transactions[0].amount_cents, -4523);
        assert_eq!(r.transactions[0].is_transfer, None);
        let q = TransactionQuery {
            category_id: Some("none".into()),
            limit: Some(8),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&q).unwrap(),
            r#"{"categoryId":"none","limit":8}"#
        );
    }
}
