//! apps/desktop/src/lib/budgetPeriod.ts, plus the small sums and checks the
//! Budgets page, its Planner tab and the Before-income dialog make
//! (BudgetsPage.tsx, BudgetPlannerPage.tsx, PreIncomeDialog.tsx).

use serde::Serialize;

use crate::budgets::{BudgetPeriod, BudgetWithSpend, PreIncome, PreIncomeItem, PreIncomeKind};
use crate::categories::Category;
use crate::money::{cents_to_fixed2, js_round, parse_amount_to_cents};

/// `periodFigures`: what a budget is judged on right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeriodFigures {
    pub limit: i64,
    pub spent: i64,
    pub weekly: bool,
}

/// This week's limit and spending for a weekly budget, the month's for a
/// monthly one. Older servers send no period fields; their budgets are all
/// monthly.
pub fn period_figures(b: &BudgetWithSpend) -> PeriodFigures {
    if b.period == Some(BudgetPeriod::Weekly) {
        return PeriodFigures {
            limit: b.period_amount_cents.unwrap_or(b.amount_cents),
            spent: b.period_spent_cents.unwrap_or(b.spent_cents),
            weekly: true,
        };
    }
    PeriodFigures {
        limit: b.amount_cents,
        spent: b.spent_cents,
        weekly: false,
    }
}

/// `month.split("-").map(Number)`: year and month of "YYYY-MM".
pub fn month_parts(month: &str) -> (i32, u32) {
    let mut parts = month.split('-').map(|p| p.parse::<i64>().unwrap_or(0));
    let y = parts.next().unwrap_or(0) as i32;
    let m = parts.next().unwrap_or(1).clamp(0, 13) as u32;
    (y, m)
}

/// `shiftMonth("2026-01", -1)` → "2025-12".
pub fn shift_month(month: &str, delta: i32) -> String {
    let (y, m) = month_parts(month);
    let index = y * 12 + m as i32 - 1 + delta;
    format!(
        "{:04}-{:02}",
        index.div_euclid(12),
        index.rem_euclid(12) + 1
    )
}

/// The summary panel on "This month": what's left and the share used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonthSummary {
    pub left_cents: i64,
    /// `Math.round(spent / budgeted * 100)`, 0 with nothing budgeted.
    pub pct_used: i64,
}

pub fn month_summary(total_budgeted: i64, total_spent: i64) -> MonthSummary {
    let pct_used = if total_budgeted > 0 {
        js_round(total_spent as f64 / total_budgeted as f64 * 100.0)
    } else {
        0
    };
    MonthSummary {
        left_cents: total_budgeted - total_spent,
        pct_used,
    }
}

/// A budget bar's fill: spent / limit (0 with no limit), and whether it's
/// over.
pub fn bar_fill(f: PeriodFigures) -> (f64, bool) {
    let pct = if f.limit > 0 {
        f.spent as f64 / f.limit as f64
    } else {
        0.0
    };
    (pct, pct > 1.0)
}

/// The categories the Add budget dialog offers: those without a budget this
/// month, plus the one being edited.
pub fn available_categories<'a>(
    categories: &'a [Category],
    existing: &[String],
    editing: Option<&str>,
) -> Vec<&'a Category> {
    categories
        .iter()
        .filter(|c| !existing.contains(&c.id) || Some(c.id.as_str()) == editing)
        .collect()
}

/// About a month's worth of a weekly amount: `Math.round(cents * 30.44 / 7)`.
pub fn weekly_to_monthly(cents: i64) -> i64 {
    js_round(cents as f64 * 30.44 / 7.0)
}

/// The budget dialog's amount field: the cents when it's a positive amount,
/// and whether to show "Enter a positive amount like 600.00".
pub fn budget_amount(amount: &str) -> (Option<i64>, bool) {
    let cents = parse_amount_to_cents(amount).filter(|&c| c > 0);
    (cents, !amount.is_empty() && cents.is_none())
}

/// `CreateBudgetRequest`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBudgetBody {
    pub category_id: String,
    pub amount_cents: i64,
    pub rollover: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period: Option<BudgetPeriod>,
    pub month: String,
}

/// `UpdateBudgetRequest` with the fields the Budgets pages change.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBudgetBody {
    pub amount_cents: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period: Option<BudgetPeriod>,
}

/// `UpdateBudgetPlanRequest`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetPlanBody {
    pub planned_income_cents: i64,
}

/// A planner amount field: blank is 0 on purpose; anything unreadable or
/// negative is `None` (kept in the field, marked, nothing saved).
pub fn planner_amount(text: &str) -> Option<i64> {
    if text.trim().is_empty() {
        Some(0)
    } else {
        parse_amount_to_cents(text).filter(|&c| c >= 0)
    }
}

/// The planned income's starting text: blank for none.
pub fn income_input(planned_income_cents: i64) -> String {
    if planned_income_cents != 0 {
        cents_to_fixed2(planned_income_cents)
    } else {
        String::new()
    }
}

/// What a committed allocation field shows: blank for 0.
pub fn allocation_text(cents: i64) -> String {
    if cents > 0 {
        cents_to_fixed2(cents)
    } else {
        String::new()
    }
}

/// The planner's three figures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlannerTotals {
    pub allocated: i64,
    pub unallocated: i64,
    pub over: bool,
}

pub fn planner_totals(income_cents: i64, budgets: &[BudgetWithSpend]) -> PlannerTotals {
    let allocated: i64 = budgets.iter().map(|b| b.amount_cents).sum();
    PlannerTotals {
        allocated,
        unallocated: (income_cents - allocated).max(0),
        over: allocated > income_cents,
    }
}

/// What saving an allocation does to the category's budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllocationChange {
    Update { id: String, amount_cents: i64 },
    Delete { id: String },
    Create { amount_cents: i64 },
    Nothing,
}

pub fn allocation_change(
    existing: Option<&BudgetWithSpend>,
    amount_cents: i64,
) -> AllocationChange {
    match existing {
        Some(b) if amount_cents > 0 => AllocationChange::Update {
            id: b.id.clone(),
            amount_cents,
        },
        Some(b) => AllocationChange::Delete { id: b.id.clone() },
        None if amount_cents > 0 => AllocationChange::Create { amount_cents },
        None => AllocationChange::Nothing,
    }
}

/// One editable row of the Before-income dialog.
#[derive(Debug, Clone, PartialEq)]
pub struct PreIncomeRow {
    pub id: String,
    pub name: String,
    pub kind: PreIncomeKind,
    pub amount: String,
}

impl PreIncomeRow {
    pub fn from_item(i: &PreIncomeItem) -> Self {
        PreIncomeRow {
            id: i.id.clone(),
            name: i.name.clone(),
            kind: i.kind,
            amount: cents_to_fixed2(i.monthly_cents),
        }
    }

    fn cents(&self) -> Option<i64> {
        parse_amount_to_cents(if self.amount.is_empty() {
            "0"
        } else {
            &self.amount
        })
    }
}

pub const PRE_INCOME_KINDS: &[(PreIncomeKind, &str, &str)] = &[
    (PreIncomeKind::Tax, "tax", "Tax"),
    (PreIncomeKind::Pretax, "pretax", "Pre-tax"),
    (PreIncomeKind::Deduction, "deduction", "Deduction"),
];

pub fn pre_income_kind(value: &str) -> PreIncomeKind {
    PRE_INCOME_KINDS
        .iter()
        .find(|(_, v, _)| *v == value)
        .map(|(k, _, _)| *k)
        .unwrap_or(PreIncomeKind::Tax)
}

pub fn pre_income_kind_value(kind: PreIncomeKind) -> &'static str {
    PRE_INCOME_KINDS
        .iter()
        .find(|(k, _, _)| *k == kind)
        .map(|(_, v, _)| *v)
        .unwrap_or("tax")
}

/// The dialog's monthly total (unreadable amounts count as 0).
pub fn pre_income_total(rows: &[PreIncomeRow]) -> i64 {
    rows.iter().map(|r| r.cents().unwrap_or(0)).sum()
}

/// A row without a name or with an unreadable amount blocks Save.
pub fn pre_income_invalid(rows: &[PreIncomeRow]) -> bool {
    rows.iter()
        .any(|r| r.name.trim().is_empty() || r.cents().is_none())
}

/// What Save sends (`savePreIncome`).
pub fn pre_income_body(rows: &[PreIncomeRow], use_estimate: bool) -> PreIncome {
    PreIncome {
        use_estimate,
        items: rows
            .iter()
            .map(|r| PreIncomeItem {
                id: r.id.clone(),
                name: r.name.trim().to_string(),
                kind: r.kind,
                monthly_cents: r.cents().unwrap_or(0),
                color: None,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categories::CategoryKind;

    fn budget(id: &str, cat: &str, amount: i64, spent: i64) -> BudgetWithSpend {
        BudgetWithSpend {
            id: id.into(),
            category_id: cat.into(),
            amount_cents: amount,
            rollover: false,
            starts_on: "2026-01-01".into(),
            period: None,
            period_amount_cents: None,
            spent_cents: spent,
            period_spent_cents: None,
            period_start: None,
            period_end: None,
        }
    }

    fn cat(id: &str) -> Category {
        Category {
            id: id.into(),
            name: id.into(),
            icon: None,
            color: "#fff".into(),
            parent_category_id: None,
            sort_order: 0,
            kind: CategoryKind::Expense,
            is_system: false,
        }
    }

    #[test]
    fn period_figures_follow_the_period() {
        let mut b = budget("b", "c", 65_000, 30_000);
        assert_eq!(
            period_figures(&b),
            PeriodFigures {
                limit: 65_000,
                spent: 30_000,
                weekly: false
            }
        );
        b.period = Some(BudgetPeriod::Weekly);
        // Older server: no period fields, fall back to the monthly ones.
        assert_eq!(period_figures(&b).limit, 65_000);
        b.period_amount_cents = Some(15_000);
        b.period_spent_cents = Some(4_200);
        assert_eq!(
            period_figures(&b),
            PeriodFigures {
                limit: 15_000,
                spent: 4_200,
                weekly: true
            }
        );
        b.period = Some(BudgetPeriod::Monthly);
        assert!(!period_figures(&b).weekly);
        assert_eq!(period_figures(&b).limit, 65_000);
    }

    #[test]
    fn months_shift_across_years() {
        assert_eq!(shift_month("2026-01", -1), "2025-12");
        assert_eq!(shift_month("2026-12", 1), "2027-01");
        assert_eq!(shift_month("2026-11", 0), "2026-11");
        assert_eq!(month_parts("2026-11"), (2026, 11));
    }

    #[test]
    fn summary_rounds_like_math_round() {
        assert_eq!(
            month_summary(60_000, 41_250),
            MonthSummary {
                left_cents: 18_750,
                pct_used: 69
            }
        );
        assert_eq!(month_summary(200, 1).pct_used, 1); // 0.5 rounds up
        assert_eq!(month_summary(0, 500).pct_used, 0);
        assert_eq!(month_summary(100, 150).left_cents, -50);
        let (pct, over) = bar_fill(PeriodFigures {
            limit: 100,
            spent: 150,
            weekly: false,
        });
        assert!(over && pct == 1.5);
        assert_eq!(
            bar_fill(PeriodFigures {
                limit: 0,
                spent: 5,
                weekly: false
            }),
            (0.0, false)
        );
    }

    #[test]
    fn dialog_offers_unbudgeted_categories() {
        let cats = [cat("a"), cat("b"), cat("c")];
        let existing = vec!["a".to_string(), "b".to_string()];
        let ids = |v: Vec<&Category>| v.iter().map(|c| c.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(available_categories(&cats, &existing, None)), ["c"]);
        assert_eq!(
            ids(available_categories(&cats, &existing, Some("b"))),
            ["b", "c"]
        );
    }

    #[test]
    fn budget_amounts() {
        assert_eq!(budget_amount(""), (None, false));
        assert_eq!(budget_amount("600"), (Some(60_000), false));
        assert_eq!(budget_amount("0"), (None, true));
        assert_eq!(budget_amount("12.345"), (None, true));
        assert_eq!(weekly_to_monthly(15_000), 65_229);
        assert_eq!(weekly_to_monthly(0), 0);
    }

    #[test]
    fn request_bodies() {
        let create = CreateBudgetBody {
            category_id: "c".into(),
            amount_cents: 100,
            rollover: false,
            period: None,
            month: "2026-11".into(),
        };
        assert_eq!(
            serde_json::to_string(&create).unwrap(),
            r#"{"categoryId":"c","amountCents":100,"rollover":false,"month":"2026-11"}"#
        );
        let update = UpdateBudgetBody {
            amount_cents: 100,
            period: Some(BudgetPeriod::Weekly),
        };
        assert_eq!(
            serde_json::to_string(&update).unwrap(),
            r#"{"amountCents":100,"period":"weekly"}"#
        );
    }

    #[test]
    fn planner() {
        assert_eq!(planner_amount(""), Some(0));
        assert_eq!(planner_amount("  "), Some(0));
        assert_eq!(planner_amount("5000.25"), Some(500_025));
        assert_eq!(planner_amount("12.345"), None);
        assert_eq!(planner_amount("-5"), None);
        assert_eq!(income_input(0), "");
        assert_eq!(income_input(500_000), "5000.00");
        assert_eq!(allocation_text(0), "");
        assert_eq!(allocation_text(21_237), "212.37");

        let bs = [budget("1", "a", 200_000, 0), budget("2", "b", 100_000, 0)];
        assert_eq!(
            planner_totals(500_000, &bs),
            PlannerTotals {
                allocated: 300_000,
                unallocated: 200_000,
                over: false
            }
        );
        assert_eq!(
            planner_totals(250_000, &bs),
            PlannerTotals {
                allocated: 300_000,
                unallocated: 0,
                over: true
            }
        );

        assert_eq!(
            allocation_change(Some(&bs[0]), 5),
            AllocationChange::Update {
                id: "1".into(),
                amount_cents: 5
            }
        );
        assert_eq!(
            allocation_change(Some(&bs[0]), 0),
            AllocationChange::Delete { id: "1".into() }
        );
        assert_eq!(
            allocation_change(None, 7),
            AllocationChange::Create { amount_cents: 7 }
        );
        assert_eq!(allocation_change(None, 0), AllocationChange::Nothing);
    }

    #[test]
    fn pre_income_rows() {
        let item = PreIncomeItem {
            id: "a".into(),
            name: "401k".into(),
            kind: PreIncomeKind::Pretax,
            monthly_cents: 50_000,
            color: Some("#123456".into()),
        };
        let mut rows = vec![PreIncomeRow::from_item(&item)];
        assert_eq!(rows[0].amount, "500.00");
        rows.push(PreIncomeRow {
            id: "b".into(),
            name: " Dental ".into(),
            kind: PreIncomeKind::Deduction,
            amount: String::new(),
        });
        assert_eq!(pre_income_total(&rows), 50_000);
        assert!(!pre_income_invalid(&rows));
        let body = pre_income_body(&rows, false);
        assert_eq!(body.items[1].name, "Dental");
        assert_eq!(body.items[1].monthly_cents, 0);
        assert_eq!(
            serde_json::to_value(&body).unwrap()["items"][0],
            serde_json::json!({"id":"a","name":"401k","kind":"pretax","monthlyCents":50000,"color":null})
        );
        rows[1].amount = "abc".into();
        assert!(pre_income_invalid(&rows));
        assert_eq!(pre_income_total(&rows), 50_000);
        rows[1].amount = "1".into();
        rows[1].name = "  ".into();
        assert!(pre_income_invalid(&rows));
        assert_eq!(pre_income_kind("deduction"), PreIncomeKind::Deduction);
        assert_eq!(pre_income_kind_value(PreIncomeKind::Pretax), "pretax");
    }
}
