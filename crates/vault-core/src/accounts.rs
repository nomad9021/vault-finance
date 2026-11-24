//! Mirrors packages/shared/src/schemas/accounts.ts.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
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

impl AccountType {
    /// `ACCOUNT_TYPE_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Checking => "Checking",
            Self::Savings => "Savings",
            Self::CreditCard => "Credit card",
            Self::Investment => "Investment",
            Self::Loan => "Loan",
            Self::Mortgage => "Mortgage",
            Self::Other => "Other",
        }
    }

    /// `LIABILITY_TYPES`: types whose balance counts against net worth.
    pub fn is_liability_type(self) -> bool {
        matches!(self, Self::CreditCard | Self::Loan | Self::Mortgage)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SetAsideKind {
    Bill,
    Fund,
    Bucket,
}

/// One thing an account's money is set aside for.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSetAside {
    pub kind: SetAsideKind,
    pub id: String,
    pub name: String,
    pub cents: i64,
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
    #[serde(default)]
    pub set_aside: Option<Vec<AccountSetAside>>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountListResponse {
    pub accounts: Vec<Account>,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const SAMPLE: &str = r#"{
      "accounts": [
        {"id":"0b9f5a52-3c1e-4f0a-9d7e-2a6b1c4d5e6f","name":"Everyday Checking","type":"checking",
         "institution":"First Bank","mask":"4821","currency":"USD","isLiability":false,
         "interestRate":null,"balanceCents":482150,"setAsideCents":60000,
         "setAside":[{"kind":"bill","id":"1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f","name":"Rent","cents":60000}],
         "archivedAt":null,"createdAt":"2026-01-04T10:00:00.000Z","updatedAt":"2026-11-20T08:12:00.000Z"},
        {"id":"2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f","name":"Rainy Day","type":"savings",
         "institution":null,"mask":null,"currency":"USD","isLiability":false,
         "interestRate":"4.25","balanceCents":1250000,
         "archivedAt":null,"createdAt":"2026-01-04T10:00:00.000Z","updatedAt":"2026-11-20T08:12:00.000Z"},
        {"id":"3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a","name":"Travel Card","type":"credit_card",
         "institution":"Card Co","mask":"0042","currency":"USD","isLiability":true,
         "interestRate":"22.99","balanceCents":-184033,"setAsideCents":0,"setAside":[],
         "archivedAt":null,"createdAt":"2026-01-04T10:00:00.000Z","updatedAt":"2026-11-20T08:12:00.000Z"}
      ]
    }"#;

    #[test]
    fn parses_server_shape() {
        let r: AccountListResponse = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(r.accounts.len(), 3);
        let card = &r.accounts[2];
        assert_eq!(card.kind, AccountType::CreditCard);
        assert!(card.is_liability && card.kind.is_liability_type());
        assert_eq!(card.balance_cents, -184033);
        assert_eq!(card.kind.label(), "Credit card");
        // Optional on older servers.
        assert_eq!(r.accounts[1].set_aside_cents, None);
        assert_eq!(r.accounts[0].set_aside.as_ref().unwrap()[0].name, "Rent");
        assert_eq!(r.accounts[0].mask.as_deref(), Some("4821"));
    }
}
