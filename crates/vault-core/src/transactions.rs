//! Mirrors packages/shared/src/schemas/transactions.ts.
//!
//! Sign convention: `amount_cents < 0` is money out, `> 0` is money in.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: String,
    pub account_id: String,
    pub category_id: Option<String>,
    /// YYYY-MM-DD.
    pub posted_at: String,
    pub amount_cents: i64,
    pub currency: String,
    pub merchant_name: String,
    pub description: Option<String>,
    pub pending: bool,
    pub notes: Option<String>,
    /// Absent on older servers.
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

/// `TransactionListQuery` (the fields a page sets; the rest are left out).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// `UpdateTransactionRequest` that only moves it to a category (`None` =
/// uncategorized, sent as `null`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCategoryBody {
    pub category_id: Option<String>,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const SAMPLE: &str = r#"{
      "transactions": [
        {"id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","accountId":"0b9f5a52-3c1e-4f0a-9d7e-2a6b1c4d5e6f",
         "categoryId":"9c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f","postedAt":"2026-11-14","amountCents":412500,
         "currency":"USD","merchantName":"Acme Corp Payroll","description":null,"pending":false,
         "notes":null,"isTransfer":false,"createdAt":"2026-11-14T09:00:00.000Z"},
        {"id":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","accountId":"0b9f5a52-3c1e-4f0a-9d7e-2a6b1c4d5e6f",
         "categoryId":"7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","postedAt":"2026-11-12","amountCents":-8423,
         "currency":"USD","merchantName":"Corner Market","description":"Groceries","pending":true,
         "notes":"split with Sam","createdAt":"2026-11-12T18:30:00.000Z"},
        {"id":"c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f","accountId":"2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
         "categoryId":null,"postedAt":"2026-11-03","amountCents":15000,
         "currency":"USD","merchantName":"Venmo from Alex","description":null,"pending":false,
         "notes":null,"isTransfer":false,"createdAt":"2026-11-03T12:00:00.000Z"}
      ],
      "nextCursor":null,"totalCount":3,"sumInCents":427500,"sumOutCents":8423
    }"#;

    #[test]
    fn parses_server_shape() {
        let r: TransactionListResponse = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(r.transactions.len(), 3);
        assert_eq!(r.total_count, 3);
        let t = &r.transactions[1];
        assert_eq!(t.amount_cents, -8423);
        assert!(t.pending);
        // Older servers leave it out.
        assert_eq!(t.is_transfer, None);
        assert_eq!(r.transactions[2].category_id, None);
        assert_eq!(r.next_cursor, None);
    }

    #[test]
    fn bodies_match_the_api() {
        let q = TransactionQuery {
            from: Some("2026-11-01".into()),
            to: Some("2026-11-30".into()),
            limit: Some(200),
        };
        assert_eq!(
            serde_json::to_string(&q).unwrap(),
            r#"{"from":"2026-11-01","to":"2026-11-30","limit":200}"#
        );
        let clear = SetCategoryBody { category_id: None };
        assert_eq!(
            serde_json::to_string(&clear).unwrap(),
            r#"{"categoryId":null}"#
        );
    }
}
