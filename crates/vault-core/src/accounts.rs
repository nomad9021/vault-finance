//! Mirrors packages/shared/src/schemas/accounts.ts: the fields Rust pages
//! read so far (serde skips the rest).

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub balance_cents: i64,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AccountListResponse {
    pub accounts: Vec<Account>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_shape() {
        let r: AccountListResponse = serde_json::from_str(r#"{"accounts":[
          {"id":"0e5d2a51-5b8e-4b8e-8e0e-2f6a1c9d7b31","name":"High-yield savings","type":"savings",
           "institution":"Ally","mask":"4821","currency":"USD","isLiability":false,"interestRate":"4.20",
           "balanceCents":1200000,"setAsideCents":900000,
           "setAside":[{"kind":"bucket","id":"b1000000-0000-4000-8000-000000000001","name":"Emergency","cents":600000}],
           "archivedAt":null,"createdAt":"2026-01-02T10:00:00.000Z","updatedAt":"2026-11-20T08:30:00.000Z"},
          {"id":"1f6e3b62-6c9f-4c9f-9f1f-3a7b2d0e8c42","name":"Old checking","type":"checking",
           "institution":null,"mask":null,"currency":"USD","isLiability":false,"interestRate":null,
           "balanceCents":0,"archivedAt":"2026-06-01T00:00:00.000Z",
           "createdAt":"2025-01-02T10:00:00.000Z","updatedAt":"2026-06-01T00:00:00.000Z"}
        ]}"#).unwrap();
        assert_eq!(r.accounts.len(), 2);
        assert_eq!(r.accounts[0].kind, "savings");
        assert!(r.accounts[1].archived_at.is_some());
    }
}
