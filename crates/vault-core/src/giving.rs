//! Mirrors packages/shared/src/schemas/giving.ts (what the Sankey drill-in reads).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GivingKind {
    Giving,
    Gift,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GivingFund {
    pub id: String,
    pub name: String,
    pub kind: GivingKind,
    pub recipient: Option<String>,
    pub monthly_cents: i64,
    pub saved_cents: i64,
    pub target_cents: Option<i64>,
    pub occasion_date: Option<String>,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub color: String,
    pub note: Option<String>,
    pub days_until_occasion: Option<i64>,
    pub needed_monthly_cents: Option<i64>,
    pub given_this_year_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GivingListResponse {
    pub funds: Vec<GivingFund>,
    pub monthly_giving_cents: i64,
    pub monthly_gift_cents: i64,
    pub total_saved_cents: i64,
    pub given_this_year_cents: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_funds() {
        let r: GivingListResponse = serde_json::from_str(
            r##"{"funds":[{"id":"1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f","name":"Birthdays","kind":"gift","recipient":null,
              "monthlyCents":5000,"savedCents":12000,"targetCents":30000,"occasionDate":"2027-03-14","accountId":null,
              "categoryId":null,"color":"#d8b23c","note":null,"daysUntilOccasion":110,"neededMonthlyCents":4500,
              "givenThisYearCents":0}],"monthlyGivingCents":0,"monthlyGiftCents":5000,"totalSavedCents":12000,
              "givenThisYearCents":0}"##,
        )
        .unwrap();
        assert_eq!(r.funds[0].kind, GivingKind::Gift);
        assert_eq!(r.funds[0].target_cents, Some(30_000));
    }
}
