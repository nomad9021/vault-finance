//! Mirrors the parts of packages/shared/src/schemas/budgets.ts the Sankey
//! diagrams read: budgets with the month's spending, the planned income, and
//! the before-income items.

use serde::{Deserialize, Serialize};

/// `WeekStart` (budgets.ts): the day a weekly budget's week begins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WeekStart {
    #[default]
    Monday,
    Sunday,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetPeriod {
    Monthly,
    Weekly,
}

/// `BudgetWithSpend`: a budget joined with the month's actual spending.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetWithSpend {
    pub id: String,
    pub category_id: String,
    /// Per month, always (a weekly budget reports its monthly equivalent).
    pub amount_cents: i64,
    pub rollover: bool,
    pub starts_on: String,
    #[serde(default)]
    pub period: Option<BudgetPeriod>,
    #[serde(default)]
    pub period_amount_cents: Option<i64>,
    /// Spent in the requested month.
    pub spent_cents: i64,
    #[serde(default)]
    pub period_spent_cents: Option<i64>,
    #[serde(default)]
    pub period_start: Option<String>,
    #[serde(default)]
    pub period_end: Option<String>,
}

/// The month's spending in a category with no budget (`None` = uncategorized).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnbudgetedSpending {
    pub category_id: Option<String>,
    pub spent_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetListResponse {
    pub month: String,
    pub budgets: Vec<BudgetWithSpend>,
    pub total_budgeted_cents: i64,
    pub total_spent_cents: i64,
    /// Absent on older servers.
    #[serde(default)]
    pub unbudgeted_spending: Option<Vec<UnbudgetedSpending>>,
}

/// `client.budgetPlan()`: the single monthly income the planner allocates.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetPlan {
    pub planned_income_cents: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreIncomeKind {
    Tax,
    Pretax,
    Deduction,
}

/// One amount taken out of pay before it reaches income, entered by the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreIncomeItem {
    pub id: String,
    pub name: String,
    pub kind: PreIncomeKind,
    pub monthly_cents: i64,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreIncome {
    pub items: Vec<PreIncomeItem>,
    /// Also draw the tax profile's estimated taxes.
    pub use_estimate: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_month_of_budgets() {
        let res: BudgetListResponse = serde_json::from_str(
            r#"{"month":"2026-11","totalBudgetedCents":60000,"totalSpentCents":41250,
              "budgets":[{"id":"6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d","categoryId":"3b0c5c8e-5d0e-4c3a-9a8e-0d6f1b2c3d4e",
                "amountCents":60000,"rollover":false,"startsOn":"2026-01-01","period":"monthly",
                "periodAmountCents":60000,"spentCents":41250,"periodSpentCents":41250}],
              "unbudgetedSpending":[{"categoryId":null,"spentCents":1999}]}"#,
        )
        .unwrap();
        assert_eq!(res.budgets[0].spent_cents, 41_250);
        assert_eq!(res.budgets[0].period, Some(BudgetPeriod::Monthly));
        assert_eq!(res.unbudgeted_spending.unwrap()[0].category_id, None);

        let old: BudgetListResponse = serde_json::from_str(
            r#"{"month":"2026-11","budgets":[],"totalBudgetedCents":0,"totalSpentCents":0}"#,
        )
        .unwrap();
        assert_eq!(old.unbudgeted_spending, None);
    }

    #[test]
    fn parses_pre_income() {
        let p: PreIncome = serde_json::from_str(
            r##"{"items":[{"id":"a","name":"401k","kind":"pretax","monthlyCents":50000},
                         {"id":"b","name":"Dental","kind":"deduction","monthlyCents":1200,"color":"#123456"}],
                "useEstimate":false}"##,
        )
        .unwrap();
        assert_eq!(p.items[0].color, None);
        assert_eq!(p.items[1].kind, PreIncomeKind::Deduction);
        assert!(!p.use_estimate);
    }
}
