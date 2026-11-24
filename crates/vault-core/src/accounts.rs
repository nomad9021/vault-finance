//! Mirrors the `Account` parts of packages/shared/src/schemas/accounts.ts
//! that Rust pages read. Unknown fields (setAside, …) are ignored.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountType {
    Checking,
    Savings,
    CreditCard,
    Investment,
    Loan,
    Mortgage,
    Other,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: AccountType,
    pub institution: Option<String>,
    pub mask: Option<String>,
    pub currency: String,
    pub is_liability: bool,
    pub interest_rate: Option<String>,
    pub balance_cents: i64,
    #[serde(default)]
    pub set_aside_cents: Option<i64>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AccountListResponse {
    pub accounts: Vec<Account>,
}

#[cfg(test)]
impl Account {
    pub(crate) fn sample() -> Self {
        Account {
            id: "acc".into(),
            name: "Checking".into(),
            kind: AccountType::Checking,
            institution: None,
            mask: None,
            currency: "USD".into(),
            is_liability: false,
            interest_rate: None,
            balance_cents: 0,
            set_aside_cents: None,
            archived_at: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_shape() {
        let json = r#"{"accounts":[
          {"id":"0f8fad5b-d9cb-469f-a165-70867728950e","name":"Chase Sapphire","type":"credit_card",
           "institution":"Chase","mask":"4821","currency":"USD","isLiability":true,"interestRate":"22.49",
           "balanceCents":-184233,"setAsideCents":0,"setAside":[],"archivedAt":null,
           "createdAt":"2026-03-02T14:11:09.000Z","updatedAt":"2026-11-20T08:00:00.000Z"},
          {"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","name":"Everyday Checking","type":"checking",
           "institution":null,"mask":null,"currency":"USD","isLiability":false,"interestRate":null,
           "balanceCents":523100,"setAside":[{"kind":"bill","id":"7c9e6679-7425-40de-944b-e07fc1f90ae8","name":"Rent","cents":150000}],
           "archivedAt":null,"createdAt":"2026-03-02T14:11:09.000Z","updatedAt":"2026-11-20T08:00:00.000Z"}
        ]}"#;
        let r: AccountListResponse = serde_json::from_str(json).unwrap();
        assert_eq!(r.accounts.len(), 2);
        assert_eq!(r.accounts[0].kind, AccountType::CreditCard);
        assert!(r.accounts[0].is_liability);
        assert_eq!(r.accounts[0].balance_cents, -184_233);
        assert_eq!(r.accounts[1].set_aside_cents, None);
    }
}
