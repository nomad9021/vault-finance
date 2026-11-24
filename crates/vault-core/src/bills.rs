//! Mirrors packages/shared/src/schemas/bills.ts (what the Sankey drill-in reads).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BillCadence {
    Weekly,
    Monthly,
    Quarterly,
    Yearly,
}

impl BillCadence {
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
pub struct Bill {
    pub id: String,
    pub name: String,
    pub amount_cents: i64,
    pub saved_cents: i64,
    pub due_day: u32,
    pub cadence: BillCadence,
    pub autopay: bool,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub color: String,
    pub next_due_date: String,
    pub days_until_due: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillListResponse {
    pub bills: Vec<Bill>,
    pub total_due_cents: i64,
    pub total_saved_cents: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bills() {
        let r: BillListResponse = serde_json::from_str(
            r##"{"bills":[{"id":"5f0c1e2d-3b4a-4c5d-8e6f-7a8b9c0d1e2f","name":"Rent","amountCents":180000,"savedCents":0,
              "dueDay":1,"cadence":"monthly","autopay":true,"accountId":null,"categoryId":null,"color":"#ec6a9c",
              "nextDueDate":"2026-12-01","daysUntilDue":7}],"totalDueCents":180000,"totalSavedCents":0}"##,
        )
        .unwrap();
        assert_eq!(r.bills[0].cadence, BillCadence::Monthly);
        assert!(r.bills[0].autopay);
    }
}
