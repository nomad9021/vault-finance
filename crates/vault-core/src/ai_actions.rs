//! Mirrors packages/shared/src/schemas/ai-actions.ts: the changes the
//! assistant may propose (`AiAction`), the look-ups it may ask for
//! (`AiQuery`), their plain-language descriptions, and pulling
//! `<vault-action>` / `<vault-remember>` / `<vault-query>` blocks out of a reply.
//!
//! serde checks the shape; [`AiAction::checked`] and [`AiQuery::checked`]
//! add zod's value rules (lengths, ranges, formats) and its `.trim()`s.

use serde::{Deserialize, Deserializer, Serialize};

use crate::bills::BillCadence;
use crate::budgets::WeekStart;
use crate::dashboard::{SankeyView, WidgetWidth};
use crate::debt::Strategy;
use crate::money::to_fixed;
use crate::serde_util::{double_option, js_len, js_slice_to, js_trim, OrderedMap};
use crate::user::is_hex_color;

/// "Uncategorized" is accepted wherever a source category is named.
pub const UNCATEGORIZED: &str = "Uncategorized";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CategoryKind {
    Expense,
    Income,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetPeriod {
    Monthly,
    Weekly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilingStatus {
    Single,
    MarriedJoint,
    MarriedSeparate,
    HeadOfHousehold,
}

impl FilingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::MarriedJoint => "married_joint",
            Self::MarriedSeparate => "married_separate",
            Self::HeadOfHousehold => "head_of_household",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PayFrequency {
    Weekly,
    Biweekly,
    Semimonthly,
    Monthly,
}

impl PayFrequency {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Weekly => "weekly",
            Self::Biweekly => "biweekly",
            Self::Semimonthly => "semimonthly",
            Self::Monthly => "monthly",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GivingKind {
    Giving,
    Gift,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreIncomeKind {
    Tax,
    Pretax,
    Deduction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewPeriod {
    Week,
    Month,
}

impl ReviewPeriod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Week => "week",
            Self::Month => "month",
        }
    }
}

/// A change the assistant proposes. Categories etc. are named the way the
/// person sees them; the server resolves names to ids when it's applied.
/// Amounts are whole or decimal dollars.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AiAction {
    CreateCategory {
        name: String,
        /// Parent category; absent/null for top level.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<CategoryKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
    },
    RenameCategory {
        category: String,
        new_name: String,
    },
    MoveCategory {
        category: String,
        /// `None` = make it top level (sent as null).
        new_parent: Option<String>,
    },
    RecolorCategory {
        category: String,
        color: String,
    },
    DeleteCategory {
        category: String,
    },
    CreateRule {
        keyword: String,
        category: String,
    },
    DeleteRule {
        keyword: String,
    },
    /// `amount` per `period` (monthly when absent).
    SetBudget {
        category: String,
        amount: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        period: Option<BudgetPeriod>,
    },
    RemoveBudget {
        category: String,
    },
    SetPlannedIncome {
        amount: f64,
    },
    RenameHousehold {
        name: String,
    },
    /// Move every transaction whose merchant contains `merchant` into `category`.
    Recategorize {
        merchant: String,
        category: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<String>,
    },
    ReorderCategories {
        parent: Option<String>,
        order: Vec<String>,
    },
    Autocategorize,

    // ── Tax & salary agent ──
    SetTaxProfile {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filing_status: Option<FilingStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state: Option<String>,
        /// `Some(None)` = no local tax.
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        locality: Option<Option<String>>,
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        custom_local_rate_pct: Option<Option<f64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dependents: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sync_planned_income: Option<bool>,
    },
    SetSalary {
        earner: String,
        gross_annual: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pay_frequency: Option<PayFrequency>,
    },
    SetPretax {
        earner: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retirement_pct: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hsa_annual: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        health_premiums_annual: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        other_pretax_annual: Option<f64>,
    },
    RemoveEarner {
        earner: String,
    },

    // ── Bills agent ──
    CreateBill {
        name: String,
        amount: f64,
        due_day: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cadence: Option<BillCadence>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        autopay: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        category: Option<String>,
    },
    UpdateBill {
        bill: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        amount: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        due_day: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cadence: Option<BillCadence>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        autopay: Option<bool>,
    },
    DeleteBill {
        bill: String,
    },

    // ── Goals agent ──
    CreateGoal {
        name: String,
        target: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        monthly: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        saved: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_date: Option<String>,
    },
    UpdateGoal {
        goal: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        monthly: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        saved: Option<f64>,
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        target_date: Option<Option<String>>,
    },
    DeleteGoal {
        goal: String,
    },
    CreateBucket {
        account: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        amount: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        goal: Option<String>,
    },
    UpdateBucket {
        bucket: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        amount: Option<f64>,
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        target: Option<Option<f64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        new_name: Option<String>,
    },
    /// `from`/`to` are bucket names, or "Unassigned".
    MoveBucketMoney {
        from: String,
        to: String,
        amount: f64,
    },
    DeleteBucket {
        bucket: String,
    },

    // ── Giving agent ──
    CreateGivingFund {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<GivingKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        monthly: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recipient: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        occasion_date: Option<String>,
    },
    UpdateGivingFund {
        fund: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        monthly: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<f64>,
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        occasion_date: Option<Option<String>>,
    },
    DeleteGivingFund {
        fund: String,
    },

    // ── Before income (Sankey) ──
    SetPreIncomeItem {
        name: String,
        amount: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<PreIncomeKind>,
    },
    RemovePreIncomeItem {
        name: String,
    },
    SetPreIncomeEstimate {
        #[serde(rename = "use")]
        use_estimate: bool,
    },

    // ── Debt agent ──
    SetDebtPlan {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        strategy: Option<Strategy>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        extra_monthly: Option<f64>,
    },
    /// `person` = a member's name, or "me". 0 removes it.
    SetGuiltFree {
        person: String,
        weekly: f64,
    },

    // ── Home screen ──
    SetDashboardLayout {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reset: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        order: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        show: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hide: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        widths: Option<OrderedMap<WidgetWidth>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sankey_view: Option<SankeyView>,
    },

    // Applied by the app itself (per-device preferences).
    SetTheme {
        theme: String,
    },
    SetReviewPrefs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_period: Option<ReviewPeriod>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        week_starts_on: Option<WeekStart>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        compare: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_advance_seconds: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_fullscreen: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        show_slides: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hide_slides: Option<Vec<String>>,
    },
}

// ── zod value rules ──

/// `z.string().trim().min(min).max(max)`: trims in place.
fn trimmed(s: &mut String, min: usize, max: usize) -> bool {
    let t = js_trim(s);
    if t.len() != s.len() {
        *s = t.to_string();
    }
    (min..=max).contains(&js_len(s))
}
/// `Name`.
fn name(s: &mut String) -> bool {
    trimmed(s, 1, 60)
}
fn name_opt(s: &mut Option<String>) -> bool {
    s.as_mut().is_none_or(name)
}
fn len_in(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&js_len(s))
}
/// `Dollars`.
fn dollars(x: f64) -> bool {
    x.is_finite() && (0.0..=10_000_000.0).contains(&x)
}
fn dollars_opt(x: Option<f64>) -> bool {
    x.is_none_or(dollars)
}
/// `/^\d{4}-\d{2}-\d{2}$/`.
pub fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}
fn day_opt(s: &Option<String>) -> bool {
    s.as_deref().is_none_or(is_day)
}
/// `/^[A-Za-z]{2}$/`.
fn us_state(s: &str) -> bool {
    s.len() == 2 && s.bytes().all(|b| b.is_ascii_alphabetic())
}
fn in_range(x: f64, lo: f64, hi: f64) -> bool {
    x.is_finite() && (lo..=hi).contains(&x)
}
fn ids_ok(v: &Option<Vec<String>>) -> bool {
    v.as_ref()
        .is_none_or(|v| v.len() <= 40 && v.iter().all(|id| len_in(id, 1, 40)))
}

impl AiAction {
    /// The action with zod's value rules applied (names trimmed), or `None`
    /// when `safeParse` would fail.
    pub fn checked(mut self) -> Option<AiAction> {
        use AiAction::*;
        let ok = match &mut self {
            CreateCategory {
                name: n,
                parent,
                color,
                ..
            } => name(n) && name_opt(parent) && color.as_deref().is_none_or(is_hex_color),
            RenameCategory { category, new_name } => name(category) && name(new_name),
            MoveCategory {
                category,
                new_parent,
            } => name(category) && name_opt(new_parent),
            RecolorCategory { category, color } => name(category) && is_hex_color(color),
            DeleteCategory { category } | RemoveBudget { category } => name(category),
            CreateRule { keyword, category } => trimmed(keyword, 1, 100) && name(category),
            DeleteRule { keyword } => trimmed(keyword, 1, 100),
            SetBudget {
                category, amount, ..
            } => name(category) && dollars(*amount),
            SetPlannedIncome { amount } => dollars(*amount),
            RenameHousehold { name: n } => trimmed(n, 1, 80),
            Recategorize {
                merchant,
                category,
                from,
                since,
            } => trimmed(merchant, 2, 100) && name(category) && name_opt(from) && day_opt(since),
            ReorderCategories { parent, order } => {
                name_opt(parent) && (2..=60).contains(&order.len()) && order.iter_mut().all(name)
            }
            Autocategorize => true,
            SetTaxProfile {
                state,
                locality,
                custom_local_rate_pct,
                dependents,
                ..
            } => {
                state.as_deref().is_none_or(us_state)
                    && locality
                        .as_ref()
                        .is_none_or(|l| l.as_deref().is_none_or(|l| js_len(l) <= 40))
                    && custom_local_rate_pct
                        .is_none_or(|r| r.is_none_or(|r| in_range(r, 0.0, 10.0)))
                    && dependents.is_none_or(|d| (0..=20).contains(&d))
            }
            SetSalary {
                earner,
                gross_annual,
                ..
            } => name(earner) && dollars(*gross_annual),
            SetPretax {
                earner,
                retirement_pct,
                hsa_annual,
                health_premiums_annual,
                other_pretax_annual,
            } => {
                name(earner)
                    && retirement_pct.is_none_or(|p| in_range(p, 0.0, 100.0))
                    && dollars_opt(*hsa_annual)
                    && dollars_opt(*health_premiums_annual)
                    && dollars_opt(*other_pretax_annual)
            }
            RemoveEarner { earner } => name(earner),
            CreateBill {
                name: n,
                amount,
                due_day,
                category,
                ..
            } => name(n) && dollars(*amount) && (1..=31).contains(due_day) && name_opt(category),
            UpdateBill {
                bill,
                amount,
                due_day,
                ..
            } => {
                name(bill) && dollars_opt(*amount) && due_day.is_none_or(|d| (1..=31).contains(&d))
            }
            DeleteBill { bill } => name(bill),
            CreateGoal {
                name: n,
                target,
                monthly,
                saved,
                target_date,
            } => {
                name(n)
                    && dollars(*target)
                    && dollars_opt(*monthly)
                    && dollars_opt(*saved)
                    && day_opt(target_date)
            }
            UpdateGoal {
                goal,
                target,
                monthly,
                saved,
                target_date,
            } => {
                name(goal)
                    && dollars_opt(*target)
                    && dollars_opt(*monthly)
                    && dollars_opt(*saved)
                    && target_date.as_ref().is_none_or(day_opt)
            }
            DeleteGoal { goal } => name(goal),
            CreateBucket {
                account,
                name: n,
                amount,
                target,
                goal,
            } => {
                name(account)
                    && name(n)
                    && dollars_opt(*amount)
                    && dollars_opt(*target)
                    && name_opt(goal)
            }
            UpdateBucket {
                bucket,
                amount,
                target,
                new_name,
            } => {
                name(bucket)
                    && dollars_opt(*amount)
                    && target.is_none_or(dollars_opt)
                    && name_opt(new_name)
            }
            MoveBucketMoney { from, to, amount } => name(from) && name(to) && dollars(*amount),
            DeleteBucket { bucket } => name(bucket),
            CreateGivingFund {
                name: n,
                monthly,
                target,
                recipient,
                occasion_date,
                ..
            } => {
                name(n)
                    && dollars_opt(*monthly)
                    && dollars_opt(*target)
                    && recipient.as_mut().is_none_or(|r| trimmed(r, 0, 120))
                    && day_opt(occasion_date)
            }
            UpdateGivingFund {
                fund,
                monthly,
                target,
                occasion_date,
            } => {
                name(fund)
                    && dollars_opt(*monthly)
                    && dollars_opt(*target)
                    && occasion_date.as_ref().is_none_or(day_opt)
            }
            DeleteGivingFund { fund } => name(fund),
            SetPreIncomeItem {
                name: n, amount, ..
            } => name(n) && dollars(*amount),
            RemovePreIncomeItem { name: n } => name(n),
            SetPreIncomeEstimate { .. } => true,
            SetDebtPlan { extra_monthly, .. } => dollars_opt(*extra_monthly),
            SetGuiltFree { person, weekly } => name(person) && dollars(*weekly),
            SetDashboardLayout {
                order,
                show,
                hide,
                widths,
                ..
            } => {
                ids_ok(order)
                    && ids_ok(show)
                    && ids_ok(hide)
                    && widths
                        .as_ref()
                        .is_none_or(|w| w.keys().all(|k| len_in(k, 1, 40)))
            }
            SetTheme { theme } => len_in(theme, 1, 20),
            SetReviewPrefs {
                auto_advance_seconds,
                ..
            } => auto_advance_seconds.is_none_or(|s| (0..=120).contains(&s)),
        };
        ok.then_some(self)
    }

    /// The wire `type`.
    pub fn type_name(&self) -> &'static str {
        use AiAction::*;
        match self {
            CreateCategory { .. } => "create_category",
            RenameCategory { .. } => "rename_category",
            MoveCategory { .. } => "move_category",
            RecolorCategory { .. } => "recolor_category",
            DeleteCategory { .. } => "delete_category",
            CreateRule { .. } => "create_rule",
            DeleteRule { .. } => "delete_rule",
            SetBudget { .. } => "set_budget",
            RemoveBudget { .. } => "remove_budget",
            SetPlannedIncome { .. } => "set_planned_income",
            RenameHousehold { .. } => "rename_household",
            Recategorize { .. } => "recategorize",
            ReorderCategories { .. } => "reorder_categories",
            Autocategorize => "autocategorize",
            SetTaxProfile { .. } => "set_tax_profile",
            SetSalary { .. } => "set_salary",
            SetPretax { .. } => "set_pretax",
            RemoveEarner { .. } => "remove_earner",
            CreateBill { .. } => "create_bill",
            UpdateBill { .. } => "update_bill",
            DeleteBill { .. } => "delete_bill",
            CreateGoal { .. } => "create_goal",
            UpdateGoal { .. } => "update_goal",
            DeleteGoal { .. } => "delete_goal",
            CreateBucket { .. } => "create_bucket",
            UpdateBucket { .. } => "update_bucket",
            MoveBucketMoney { .. } => "move_bucket_money",
            DeleteBucket { .. } => "delete_bucket",
            CreateGivingFund { .. } => "create_giving_fund",
            UpdateGivingFund { .. } => "update_giving_fund",
            DeleteGivingFund { .. } => "delete_giving_fund",
            SetPreIncomeItem { .. } => "set_pre_income_item",
            RemovePreIncomeItem { .. } => "remove_pre_income_item",
            SetPreIncomeEstimate { .. } => "set_pre_income_estimate",
            SetDebtPlan { .. } => "set_debt_plan",
            SetGuiltFree { .. } => "set_guilt_free",
            SetDashboardLayout { .. } => "set_dashboard_layout",
            SetTheme { .. } => "set_theme",
            SetReviewPrefs { .. } => "set_review_prefs",
        }
    }

    /// `CLIENT_ACTION_TYPES`: the desktop app applies these itself.
    pub fn is_client(&self) -> bool {
        matches!(
            self,
            AiAction::SetTheme { .. } | AiAction::SetReviewPrefs { .. }
        )
    }
}

/// `x.toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits })`
/// for the non-negative amounts actions carry: grouped thousands, halves
/// rounded away from zero.
pub fn en_us_number(x: f64, min_frac: usize, max_frac: usize) -> String {
    let fixed = to_fixed(x, max_frac);
    let (neg, fixed) = match fixed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, fixed.as_str()),
    };
    let (int, frac) = fixed.split_once('.').unwrap_or((fixed, ""));
    let mut frac = frac.to_string();
    while frac.len() > min_frac && frac.ends_with('0') {
        frac.pop();
    }
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let all_zero =
        grouped.bytes().all(|b| b == b'0' || b == b',') && frac.bytes().all(|b| b == b'0');
    let sign = if neg && !all_zero { "-" } else { "" };
    if frac.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{frac}")
    }
}

/// `toLocaleString("en-US")` with its defaults (up to 3 decimals).
fn usd(x: f64) -> String {
    en_us_number(x, 0, 3)
}

/// JS `${n}` for the small numbers actions carry.
fn js_num(x: f64) -> String {
    if x == 0.0 {
        "0".into()
    } else {
        format!("{x}")
    }
}

fn truthy(x: Option<f64>) -> Option<f64> {
    x.filter(|v| *v != 0.0 && !v.is_nan())
}

/// Plain-language summary of an action, for the approval card and history.
pub fn describe_ai_action(a: &AiAction) -> String {
    use AiAction::*;
    match a {
        CreateCategory {
            name, parent, kind, ..
        } => format!(
            "Add {}category \"{name}\"{}",
            if *kind == Some(CategoryKind::Income) {
                "income "
            } else {
                ""
            },
            parent
                .as_deref()
                .filter(|p| !p.is_empty())
                .map(|p| format!(" under \"{p}\""))
                .unwrap_or_default()
        ),
        RenameCategory { category, new_name } => {
            format!("Rename category \"{category}\" to \"{new_name}\"")
        }
        MoveCategory {
            category,
            new_parent,
        } => match new_parent.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => format!("Move category \"{category}\" under \"{p}\""),
            None => format!("Make \"{category}\" a top-level category"),
        },
        RecolorCategory { category, color } => {
            format!("Change the colour of \"{category}\" to {color}")
        }
        DeleteCategory { category } => format!("Delete category \"{category}\""),
        CreateRule { keyword, category } => {
            format!("Auto-categorize transactions matching \"{keyword}\" as \"{category}\"")
        }
        DeleteRule { keyword } => format!("Remove the auto-categorization rule for \"{keyword}\""),
        SetBudget {
            category,
            amount,
            period,
        } => format!(
            "Set the {} budget for \"{category}\" to ${}",
            if *period == Some(BudgetPeriod::Weekly) {
                "weekly"
            } else {
                "monthly"
            },
            if amount.fract() == 0.0 {
                usd(*amount)
            } else {
                en_us_number(*amount, 2, 2)
            }
        ),
        RemoveBudget { category } => format!("Remove the budget for \"{category}\""),
        SetPlannedIncome { amount } => format!("Set planned monthly income to ${}", usd(*amount)),
        RenameHousehold { name } => format!("Rename the household to \"{name}\""),
        Recategorize {
            merchant,
            category,
            from,
            since,
        } => format!(
            "Move {}transactions from \"{merchant}\"{} to \"{category}\"",
            from.as_deref()
                .filter(|f| !f.is_empty())
                .map(|f| format!("\"{f}\" "))
                .unwrap_or_default(),
            since
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| format!(" since {s}"))
                .unwrap_or_default()
        ),
        ReorderCategories { parent, order } => format!(
            "Order {}: {}",
            match parent.as_deref().filter(|p| !p.is_empty()) {
                Some(p) => format!("the categories under \"{p}\""),
                None => "the top-level categories".into(),
            },
            order.join(", ")
        ),
        Autocategorize => "Auto-categorize uncategorized transactions".into(),
        SetTaxProfile {
            filing_status,
            state,
            locality,
            custom_local_rate_pct,
            dependents,
            sync_planned_income,
        } => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(f) = filing_status {
                parts.push(format!("file as {}", f.as_str().replace('_', " ")));
            }
            if let Some(s) = state.as_deref().filter(|s| !s.is_empty()) {
                parts.push(format!("live in {}", s.to_uppercase()));
            }
            if let Some(l) = locality {
                parts.push(match l.as_deref().filter(|l| !l.is_empty()) {
                    Some(l) => format!("local tax: {l}"),
                    None => "no local tax".into(),
                });
            }
            if let Some(Some(r)) = custom_local_rate_pct {
                parts.push(format!("local tax {}%", js_num(*r)));
            }
            if let Some(d) = dependents {
                parts.push(format!(
                    "{d} child{} under 17",
                    if *d == 1 { "" } else { "ren" }
                ));
            }
            if let Some(s) = sync_planned_income {
                parts.push(
                    if *s {
                        "budget from take-home"
                    } else {
                        "keep budget income separate"
                    }
                    .into(),
                );
            }
            format!(
                "Tax profile: {}",
                if parts.is_empty() {
                    "no change".into()
                } else {
                    parts.join("; ")
                }
            )
        }
        SetSalary {
            earner,
            gross_annual,
            pay_frequency,
        } => format!(
            "Set {earner}'s salary to ${} a year before tax{}",
            usd(*gross_annual),
            pay_frequency
                .map(|p| format!(", paid {}", p.as_str()))
                .unwrap_or_default()
        ),
        SetPretax {
            earner,
            retirement_pct,
            hsa_annual,
            health_premiums_annual,
            other_pretax_annual,
        } => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(p) = retirement_pct {
                parts.push(format!("401(k) {}%", js_num(*p)));
            }
            if let Some(v) = hsa_annual {
                parts.push(format!("HSA ${}/yr", usd(*v)));
            }
            if let Some(v) = health_premiums_annual {
                parts.push(format!("premiums ${}/yr", usd(*v)));
            }
            if let Some(v) = other_pretax_annual {
                parts.push(format!("other pre-tax ${}/yr", usd(*v)));
            }
            format!(
                "{earner}'s pre-tax deductions: {}",
                if parts.is_empty() {
                    "no change".into()
                } else {
                    parts.join(", ")
                }
            )
        }
        RemoveEarner { earner } => format!("Remove {earner} from the tax profile"),
        CreateBill {
            name,
            amount,
            due_day,
            cadence,
            ..
        } => format!(
            "Add bill \"{name}\": ${} {}, due on day {due_day}",
            usd(*amount),
            cadence.map_or("monthly", |c| c.as_str())
        ),
        UpdateBill { bill, .. } => format!("Update bill \"{bill}\""),
        DeleteBill { bill } => format!("Delete bill \"{bill}\""),
        CreateGoal {
            name,
            target,
            monthly,
            ..
        } => format!(
            "Add savings goal \"{name}\": ${}{}",
            usd(*target),
            truthy(*monthly)
                .map(|m| format!(", ${}/month", usd(m)))
                .unwrap_or_default()
        ),
        UpdateGoal { goal, .. } => format!("Update savings goal \"{goal}\""),
        DeleteGoal { goal } => format!("Delete savings goal \"{goal}\""),
        CreateBucket {
            account,
            name,
            amount,
            target,
            ..
        } => format!(
            "Add bucket \"{name}\" in {account}{}{}",
            truthy(*amount)
                .map(|v| format!(" with ${}", usd(v)))
                .unwrap_or_default(),
            truthy(*target)
                .map(|v| format!(", target ${}", usd(v)))
                .unwrap_or_default()
        ),
        UpdateBucket { bucket, .. } => format!("Update bucket \"{bucket}\""),
        MoveBucketMoney { from, to, amount } => {
            format!("Move ${} from {from} to {to}", usd(*amount))
        }
        DeleteBucket { bucket } => format!("Delete bucket \"{bucket}\""),
        CreateGivingFund {
            name,
            kind,
            monthly,
            ..
        } => format!(
            "Add {} fund \"{name}\"{}",
            if *kind == Some(GivingKind::Gift) {
                "gift"
            } else {
                "giving"
            },
            truthy(*monthly)
                .map(|m| format!(", ${}/month", usd(m)))
                .unwrap_or_default()
        ),
        UpdateGivingFund { fund, .. } => format!("Update giving fund \"{fund}\""),
        DeleteGivingFund { fund } => format!("Delete giving fund \"{fund}\""),
        SetPreIncomeItem { name, amount, kind } => format!(
            "Before income: \"{name}\" ${} a month{}",
            usd(*amount),
            kind.map(|k| format!(
                " ({})",
                match k {
                    PreIncomeKind::Pretax => "pre-tax savings",
                    PreIncomeKind::Tax => "tax",
                    PreIncomeKind::Deduction => "deduction",
                }
            ))
            .unwrap_or_default()
        ),
        RemovePreIncomeItem { name } => format!("Remove \"{name}\" from before income"),
        SetPreIncomeEstimate { use_estimate } => if *use_estimate {
            "Show the estimated taxes before income"
        } else {
            "Stop showing the estimated taxes before income (use your own items)"
        }
        .into(),
        SetDebtPlan {
            strategy,
            extra_monthly,
        } => {
            let parts: Vec<String> = [
                strategy.map(|s| format!("{} order", s.as_str())),
                extra_monthly.map(|e| format!("${} extra a month", usd(e))),
            ]
            .into_iter()
            .flatten()
            .collect();
            format!(
                "Debt plan: {}",
                if parts.is_empty() {
                    "no change".into()
                } else {
                    parts.join(", ")
                }
            )
        }
        SetGuiltFree { person, weekly } => {
            let p = js_trim(person).to_lowercase();
            let who = if p == "me" || p == "myself" || p == "i" {
                "your".to_string()
            } else {
                format!("{person}'s")
            };
            if *weekly > 0.0 {
                format!("Set {who} guilt-free spending to ${} a week", usd(*weekly))
            } else {
                format!("Remove {who} weekly guilt-free spending")
            }
        }
        SetDashboardLayout {
            reset,
            order,
            show,
            hide,
            widths,
            sankey_view,
        } => {
            let mut parts: Vec<String> = Vec::new();
            if *reset == Some(true) {
                parts.push("reset to the default layout".into());
            }
            if let Some(o) = order.as_ref().filter(|o| !o.is_empty()) {
                parts.push(format!("order: {}", o.join(", ")));
            }
            if let Some(s) = show.as_ref().filter(|s| !s.is_empty()) {
                parts.push(format!("show {}", s.join(", ")));
            }
            if let Some(h) = hide.as_ref().filter(|h| !h.is_empty()) {
                parts.push(format!("hide {}", h.join(", ")));
            }
            if let Some(w) = widths.as_ref().filter(|w| !w.is_empty()) {
                parts.push(
                    w.0.iter()
                        .map(|(id, w)| format!("{id} {} width", w.as_str()))
                        .collect::<Vec<_>>()
                        .join(", "),
                );
            }
            if let Some(v) = sankey_view {
                parts.push(format!(
                    "cash-flow diagram: {}",
                    if *v == SankeyView::Combined {
                        "budget vs actual"
                    } else {
                        v.as_str()
                    }
                ));
            }
            format!(
                "Home screen: {}",
                if parts.is_empty() {
                    "no change".into()
                } else {
                    parts.join("; ")
                }
            )
        }
        SetTheme { theme } => format!("Switch the theme to {theme}"),
        SetReviewPrefs {
            default_period,
            week_starts_on,
            compare,
            auto_advance_seconds,
            start_fullscreen,
            show_slides,
            hide_slides,
        } => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(p) = default_period {
                parts.push(format!("default to {}ly reviews", p.as_str()));
            }
            if let Some(w) = week_starts_on {
                parts.push(format!(
                    "start weeks on {}",
                    if *w == WeekStart::Monday {
                        "monday"
                    } else {
                        "sunday"
                    }
                ));
            }
            if let Some(c) = compare {
                parts.push(
                    if *c {
                        "show comparisons"
                    } else {
                        "hide comparisons"
                    }
                    .into(),
                );
            }
            if let Some(s) = auto_advance_seconds {
                parts.push(if *s != 0 {
                    format!("auto-advance every {s}s")
                } else {
                    "turn off auto-advance".into()
                });
            }
            if let Some(f) = start_fullscreen {
                parts.push(
                    if *f {
                        "present in full screen"
                    } else {
                        "present in a window"
                    }
                    .into(),
                );
            }
            if let Some(s) = show_slides.as_ref().filter(|s| !s.is_empty()) {
                parts.push(format!("show {}", s.join(", ")));
            }
            if let Some(h) = hide_slides.as_ref().filter(|h| !h.is_empty()) {
                parts.push(format!("hide {}", h.join(", ")));
            }
            format!(
                "Finance reviews: {}",
                if parts.is_empty() {
                    "no change".into()
                } else {
                    parts.join("; ")
                }
            )
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiActionStatus {
    Pending,
    Applied,
    Rejected,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiActionRecord {
    pub id: String,
    pub conversation_id: String,
    pub message_id: Option<String>,
    pub action: AiAction,
    /// "Add category Pets under Household".
    pub summary: String,
    /// The app (not the server) carries it out.
    pub client: bool,
    pub status: AiActionStatus,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientResultStatus {
    Applied,
    Failed,
    Rejected,
}

/// Reporting the outcome of an action the app applied itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiActionClientResult {
    pub status: ClientResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiMemoryNote {
    pub at: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiMemoryResponse {
    pub notes: Vec<AiMemoryNote>,
}

// ── Look-ups (the agent loop) ──

/// `z.coerce.number().int().min(1)` then `Math.min(n, max)`.
fn coerced_window<'de, D: Deserializer<'de>>(d: D, max: i64) -> Result<Option<i64>, D::Error> {
    use serde_json::Value;
    let n = match Value::deserialize(d)? {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = js_trim(&s);
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        Value::Bool(b) => f64::from(u8::from(b)),
        Value::Null => 0.0,
        _ => f64::NAN,
    };
    if n.is_finite() && n.fract() == 0.0 && n >= 1.0 {
        Ok(Some((n as i64).min(max)))
    } else {
        Err(serde::de::Error::custom(
            "expected a whole number of at least 1",
        ))
    }
}
fn days<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    coerced_window(d, 730)
}
fn months<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    coerced_window(d, 24)
}
fn limit<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    coerced_window(d, 100)
}

/// Read-only look-ups the assistant asks the server for mid-answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AiQuery {
    Transactions {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        merchant: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        category: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        /// Last N days (instead of from/to), clamped to 730.
        #[serde(
            default,
            deserialize_with = "days",
            skip_serializing_if = "Option::is_none"
        )]
        days: Option<i64>,
        #[serde(
            default,
            deserialize_with = "limit",
            skip_serializing_if = "Option::is_none"
        )]
        limit: Option<i64>,
    },
    Merchants {
        #[serde(
            default,
            deserialize_with = "months",
            skip_serializing_if = "Option::is_none"
        )]
        months: Option<i64>,
        #[serde(
            default,
            deserialize_with = "days",
            skip_serializing_if = "Option::is_none"
        )]
        days: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uncategorized_only: Option<bool>,
    },
    CategoryTotals {
        #[serde(
            default,
            deserialize_with = "months",
            skip_serializing_if = "Option::is_none"
        )]
        months: Option<i64>,
        #[serde(
            default,
            deserialize_with = "days",
            skip_serializing_if = "Option::is_none"
        )]
        days: Option<i64>,
    },
    Budgets,
    TaxEstimate,
    /// The saved tax profile with some things changed; nothing is saved.
    TaxWhatif {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state: Option<String>,
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        locality: Option<Option<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filing_status: Option<FilingStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dependents: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        earner: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gross_annual: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retirement_pct: Option<f64>,
    },
    TaxCompare {
        states: Vec<String>,
    },
    TaxPlaces {
        state: String,
    },
    Bills,
    Subscriptions,
    Goals,
    Buckets,
    Giving,
    Debts,
    PreIncome,
    Cashflow {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        months: Option<i64>,
    },
    Insights,
    Accounts,
    GuiltFree,
    /// The home screen layout.
    Dashboard,
}

impl AiQuery {
    /// zod's value rules on top of the shape, or `None`.
    pub fn checked(mut self) -> Option<AiQuery> {
        use AiQuery::*;
        let ok = match &mut self {
            Transactions {
                merchant,
                category,
                from,
                to,
                ..
            } => {
                merchant.as_mut().is_none_or(|m| trimmed(m, 1, 100))
                    && name_opt(category)
                    && day_opt(from)
                    && day_opt(to)
            }
            TaxWhatif {
                state,
                locality,
                dependents,
                earner,
                gross_annual,
                retirement_pct,
                ..
            } => {
                state.as_deref().is_none_or(us_state)
                    && locality
                        .as_ref()
                        .is_none_or(|l| l.as_deref().is_none_or(|l| js_len(l) <= 40))
                    && dependents.is_none_or(|d| (0..=20).contains(&d))
                    && name_opt(earner)
                    && dollars_opt(*gross_annual)
                    && retirement_pct.is_none_or(|p| in_range(p, 0.0, 100.0))
            }
            TaxCompare { states } => {
                (1..=10).contains(&states.len()) && states.iter().all(|s| us_state(s))
            }
            TaxPlaces { state } => us_state(state),
            Cashflow { months } => months.is_none_or(|m| (1..=24).contains(&m)),
            _ => true,
        };
        ok.then_some(self)
    }
}

/// Names models invent for the real look-ups; mapped rather than rejected.
const QUERY_ALIASES: &[(&str, &str)] = &[
    ("merchant_totals", "transactions"),
    ("merchant_total", "transactions"),
    ("merchant_spending", "transactions"),
    ("transaction_totals", "transactions"),
    ("spending", "transactions"),
    ("totals", "transactions"),
    ("search", "transactions"),
    ("transaction", "transactions"),
    ("category_spending", "category_totals"),
    ("categories", "category_totals"),
    ("category_total", "category_totals"),
    ("merchant", "merchants"),
    ("budget", "budgets"),
    ("bill", "bills"),
    ("goal", "goals"),
    ("account", "accounts"),
    ("guiltfree", "guilt_free"),
    ("guilt-free", "guilt_free"),
    ("home", "dashboard"),
    ("home_screen", "dashboard"),
    ("layout", "dashboard"),
    ("dashboard_layout", "dashboard"),
];

// ── Blocks in a reply ──

/// One regex match: `[start, end)` of the whole match and of group 1.
struct Found {
    start: usize,
    inner: (usize, usize),
    end: usize,
}

/// All matches of `/<?TAG>?([\s\S]*?)<\/TAG>/g` (tolerant of a missing "<"
/// or ">" and of stray text before the tag).
fn tolerant_blocks(text: &str, tag: &str) -> Vec<Found> {
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(rel) = text[pos..].find(tag) {
        let at = pos + rel;
        let start = if at > pos && text.as_bytes()[at - 1] == b'<' {
            at - 1
        } else {
            at
        };
        let mut inner_start = at + tag.len();
        if text.as_bytes().get(inner_start) == Some(&b'>') {
            inner_start += 1;
        }
        // No close after this tag means none after any later one either.
        let Some(c) = text[inner_start..].find(&close) else {
            break;
        };
        let inner_end = inner_start + c;
        let end = inner_end + close.len();
        out.push(Found {
            start,
            inner: (inner_start, inner_end),
            end,
        });
        pos = end;
    }
    out
}

/// All matches of `/<TAG>([\s\S]*?)<\/TAG>/g`.
fn strict_blocks(text: &str, tag: &str) -> Vec<Found> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(rel) = text[pos..].find(&open) {
        let start = pos + rel;
        let inner_start = start + open.len();
        let Some(c) = text[inner_start..].find(&close) else {
            break;
        };
        let inner_end = inner_start + c;
        let end = inner_end + close.len();
        out.push(Found {
            start,
            inner: (inner_start, inner_end),
            end,
        });
        pos = end;
    }
    out
}

fn remove(text: &str, found: &[Found]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for f in found {
        out.push_str(&text[at..f.start]);
        at = f.end;
    }
    out.push_str(&text[at..]);
    out
}

/// A block's JSON without code fences or curly quotes.
fn block_json(raw: &str) -> String {
    let mut s = js_trim(raw);
    // /^```(?:json)?\s*/i
    if let Some(rest) = s.strip_prefix("```") {
        let rest = match rest.get(..4) {
            Some(j) if j.eq_ignore_ascii_case("json") => &rest[4..],
            _ => rest,
        };
        s = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    }
    // /\s*```$/
    if let Some(rest) = s.strip_suffix("```") {
        s = rest.trim_end_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    }
    s.replace(
        ['\u{201C}', '\u{201D}', '\u{201E}', '\u{201F}', '\u{2033}'],
        "\"",
    )
}

/// What [`extract_assistant_blocks`] found in a reply.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AssistantBlocks {
    /// The reply without its blocks.
    pub visible: String,
    pub actions: Vec<AiAction>,
    /// Raw text of blocks that weren't valid actions (reported, not thrown).
    pub invalid: Vec<String>,
    /// Memory notes, at most 500 characters each.
    pub remember: Vec<String>,
}

/// Pull action and memory blocks out of an assistant reply.
pub fn extract_assistant_blocks(text: &str) -> AssistantBlocks {
    let mut out = AssistantBlocks::default();
    for f in tolerant_blocks(text, "vault-action") {
        let raw = js_trim(&text[f.inner.0..f.inner.1]);
        match serde_json::from_str::<AiAction>(&block_json(raw))
            .ok()
            .and_then(AiAction::checked)
        {
            Some(a) => out.actions.push(a),
            None => out.invalid.push(raw.to_string()),
        }
    }
    for f in strict_blocks(text, "vault-remember") {
        let note = js_slice_to(js_trim(&text[f.inner.0..f.inner.1]), 500);
        if !note.is_empty() {
            out.remember.push(note.to_string());
        }
    }
    out.visible = strip_assistant_blocks(text);
    out
}

/// The look-ups in a reply; malformed ones come back as raw text.
pub fn extract_query_blocks(text: &str) -> (Vec<AiQuery>, Vec<String>) {
    let mut queries = Vec::new();
    let mut invalid = Vec::new();
    for f in tolerant_blocks(text, "vault-query") {
        let raw = js_trim(&text[f.inner.0..f.inner.1]);
        let parsed = serde_json::from_str::<serde_json::Value>(&block_json(raw))
            .ok()
            .and_then(|mut v| {
                if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
                    if let Some((_, real)) = QUERY_ALIASES.iter().find(|(alias, _)| *alias == t) {
                        v["type"] = serde_json::Value::String((*real).to_string());
                    }
                }
                serde_json::from_value::<AiQuery>(v)
                    .ok()
                    .and_then(AiQuery::checked)
            });
        match parsed {
            Some(q) => queries.push(q),
            None => invalid.push(raw.to_string()),
        }
    }
    (queries, invalid)
}

/// Remove action/memory/query blocks for display, including one still being
/// streamed in (an opening tag with no close yet).
pub fn strip_assistant_blocks(text: &str) -> String {
    let s = remove(text, &tolerant_blocks(text, "vault-action"));
    let s = remove(&s, &strict_blocks(&s, "vault-remember"));
    let mut s = remove(&s, &tolerant_blocks(&s, "vault-query"));
    // /<?vault-(action|remember|query)>?[\s\S]*$/
    let open = ["vault-action", "vault-remember", "vault-query"]
        .iter()
        .filter_map(|t| s.find(t))
        .min();
    if let Some(at) = open {
        let cut = if at > 0 && s.as_bytes()[at - 1] == b'<' {
            at - 1
        } else {
            at
        };
        s.truncate(cut);
    }
    // /\n{3,}/g → "\n\n"
    let mut out = String::with_capacity(s.len());
    let mut run = 0;
    for c in s.chars() {
        if c == '\n' {
            run += 1;
            if run <= 2 {
                out.push(c);
            }
        } else {
            run = 0;
            out.push(c);
        }
    }
    js_trim(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(json: &str) -> Option<AiAction> {
        serde_json::from_str::<AiAction>(json)
            .ok()
            .and_then(AiAction::checked)
    }

    // packages/shared/src/ai-actions.test.ts
    #[test]
    fn pulls_out_valid_actions_and_memory_notes_reports_bad_ones() {
        let out = extract_assistant_blocks(
            &[
                "Here's the plan.",
                r#"<vault-action>{"type":"set_budget","category":"Dining","amount":250}</vault-action>"#,
                r#"<vault-action>{"type":"drop_tables"}</vault-action>"#,
                "<vault-action>not json</vault-action>",
                "<vault-remember>Paid biweekly on Fridays</vault-remember>",
            ]
            .join("\n"),
        );
        assert_eq!(out.visible, "Here's the plan.");
        assert_eq!(
            out.actions,
            [AiAction::SetBudget {
                category: "Dining".into(),
                amount: 250.0,
                period: None
            }]
        );
        assert_eq!(out.invalid.len(), 2);
        assert_eq!(out.remember, ["Paid biweekly on Fridays"]);
    }

    #[test]
    fn reads_blocks_small_models_mangle() {
        let out = extract_assistant_blocks(concat!(
            "Done.\n$vault-action{\"type\":\"set_budget\",\"category\":\"Groceries\",\"amount\":500}</vault-action>\n",
            "<vault-action>```json\n{\"type\":\"create_rule\",\"keyword\":\"shell\",\"category\":\"Transport\"}\n```</vault-action>"
        ));
        assert_eq!(
            out.actions
                .iter()
                .map(AiAction::type_name)
                .collect::<Vec<_>>(),
            ["set_budget", "create_rule"]
        );
        assert_eq!(out.visible, "Done.\n$");
        assert_eq!(
            extract_assistant_blocks(
                "<vault-action>{\u{201C}type\u{201D}:\u{201C}rename_category\u{201D},\u{201C}category\u{201D}:\u{201C}Dining Out\u{201D},\u{201C}newName\u{201D}:\u{201C}Restaurants\u{201D}}</vault-action>"
            )
            .actions,
            [AiAction::RenameCategory { category: "Dining Out".into(), new_name: "Restaurants".into() }]
        );
    }

    #[test]
    fn hides_a_block_that_is_still_streaming_in() {
        assert_eq!(
            strip_assistant_blocks("Okay.\n<vault-action>{\"type\":\"create_"),
            "Okay."
        );
        assert_eq!(
            strip_assistant_blocks("a\n\n\n\nb<vault-remember>x</vault-remember>"),
            "a\n\nb"
        );
        assert_eq!(
            strip_assistant_blocks("Look: <vault-query>{\"type\":\"bills\"}</vault-query>"),
            "Look:"
        );
    }

    #[test]
    fn describes_actions_in_plain_words() {
        assert_eq!(
            describe_ai_action(&AiAction::MoveCategory {
                category: "Vet".into(),
                new_parent: None
            }),
            "Make \"Vet\" a top-level category"
        );
    }

    // packages/shared/src/dashboard.test.ts ("parses the new actions")
    #[test]
    fn parses_the_new_actions() {
        assert!(action(
            r#"{"type":"set_dashboard_layout","order":["guilt-free"],"widths":{"sankey":"full"},"sankeyView":"combined"}"#
        )
        .is_some());
        assert!(action(r#"{"type":"set_dashboard_layout","widths":{"sankey":"huge"}}"#).is_none());
        assert!(action(r#"{"type":"set_guilt_free","person":"me","weekly":75}"#).is_some());
        assert!(action(
            r#"{"type":"set_budget","category":"Coffee","amount":20,"period":"weekly"}"#
        )
        .is_some());
    }

    #[test]
    fn applies_zod_value_rules() {
        assert_eq!(
            action(r#"{"type":"create_category","name":"  Pets  ","parent":null}"#),
            Some(AiAction::CreateCategory {
                name: "Pets".into(),
                parent: None,
                kind: None,
                color: None
            })
        );
        assert!(action(r#"{"type":"create_category","name":"   "}"#).is_none());
        assert!(
            action(r##"{"type":"recolor_category","category":"Pets","color":"#12345"}"##).is_none()
        );
        assert!(action(r#"{"type":"set_budget","category":"Dining","amount":-5}"#).is_none());
        assert!(
            action(r#"{"type":"create_bill","name":"Rent","amount":1800,"dueDay":32}"#).is_none()
        );
        assert!(action(r#"{"type":"recategorize","merchant":"x","category":"Dining"}"#).is_none());
        assert!(action(r#"{"type":"reorder_categories","parent":null,"order":["A"]}"#).is_none());
        assert!(action(r#"{"type":"set_tax_profile","state":"Ohio"}"#).is_none());
        assert!(
            action(r#"{"type":"update_goal","goal":"Trip","targetDate":"next year"}"#).is_none()
        );
        assert!(action(r#"{"type":"set_theme","theme":""}"#).is_none());
        let goal = action(r#"{"type":"update_goal","goal":"Trip","targetDate":null}"#).unwrap();
        assert_eq!(
            serde_json::to_string(&goal).unwrap(),
            r#"{"type":"update_goal","goal":"Trip","targetDate":null}"#
        );
        assert!(
            action(r#"{"type":"set_review_prefs","autoAdvanceSeconds":8}"#)
                .unwrap()
                .is_client()
        );
    }

    #[test]
    fn describes_every_kind_of_change() {
        let d = |json: &str| describe_ai_action(&action(json).unwrap());
        assert_eq!(
            d(r#"{"type":"create_category","name":"Side gigs","kind":"income","parent":"Work"}"#),
            "Add income category \"Side gigs\" under \"Work\""
        );
        assert_eq!(
            d(r#"{"type":"set_budget","category":"Dining","amount":1250}"#),
            "Set the monthly budget for \"Dining\" to $1,250"
        );
        assert_eq!(
            d(r#"{"type":"set_budget","category":"Coffee","amount":12.5,"period":"weekly"}"#),
            "Set the weekly budget for \"Coffee\" to $12.50"
        );
        assert_eq!(
            d(r#"{"type":"set_planned_income","amount":8333.333}"#),
            "Set planned monthly income to $8,333.333"
        );
        assert_eq!(
            d(
                r#"{"type":"recategorize","merchant":"Shell","category":"Transport","from":"Uncategorized","since":"2026-01-01"}"#
            ),
            "Move \"Uncategorized\" transactions from \"Shell\" since 2026-01-01 to \"Transport\""
        );
        assert_eq!(
            d(r#"{"type":"reorder_categories","parent":null,"order":["Home","Food"]}"#),
            "Order the top-level categories: Home, Food"
        );
        assert_eq!(d(r#"{"type":"set_tax_profile","filingStatus":"married_joint","state":"oh","locality":null,"customLocalRatePct":2.5,"dependents":1,"syncPlannedIncome":true}"#),
            "Tax profile: file as married joint; live in OH; no local tax; local tax 2.5%; 1 child under 17; budget from take-home");
        assert_eq!(d(r#"{"type":"set_tax_profile"}"#), "Tax profile: no change");
        assert_eq!(
            d(
                r#"{"type":"set_salary","earner":"Pat","grossAnnual":98000,"payFrequency":"biweekly"}"#
            ),
            "Set Pat's salary to $98,000 a year before tax, paid biweekly"
        );
        assert_eq!(
            d(r#"{"type":"set_pretax","earner":"Pat","retirementPct":6,"hsaAnnual":4150}"#),
            "Pat's pre-tax deductions: 401(k) 6%, HSA $4,150/yr"
        );
        assert_eq!(
            d(r#"{"type":"create_bill","name":"Rent","amount":1800,"dueDay":1}"#),
            "Add bill \"Rent\": $1,800 monthly, due on day 1"
        );
        assert_eq!(
            d(r#"{"type":"create_goal","name":"Trip","target":3000,"monthly":0}"#),
            "Add savings goal \"Trip\": $3,000"
        );
        assert_eq!(
            d(
                r#"{"type":"create_bucket","account":"Savings","name":"Car","amount":500,"target":4000}"#
            ),
            "Add bucket \"Car\" in Savings with $500, target $4,000"
        );
        assert_eq!(
            d(r#"{"type":"create_giving_fund","name":"Birthdays","kind":"gift","monthly":40}"#),
            "Add gift fund \"Birthdays\", $40/month"
        );
        assert_eq!(
            d(r#"{"type":"set_pre_income_item","name":"401(k)","amount":500,"kind":"pretax"}"#),
            "Before income: \"401(k)\" $500 a month (pre-tax savings)"
        );
        assert_eq!(
            d(r#"{"type":"set_debt_plan","strategy":"snowball","extraMonthly":0}"#),
            "Debt plan: snowball order, $0 extra a month"
        );
        assert_eq!(d(r#"{"type":"set_debt_plan"}"#), "Debt plan: no change");
        assert_eq!(
            d(r#"{"type":"set_guilt_free","person":" Me ","weekly":75}"#),
            "Set your guilt-free spending to $75 a week"
        );
        assert_eq!(
            d(r#"{"type":"set_guilt_free","person":"Sam","weekly":0}"#),
            "Remove Sam's weekly guilt-free spending"
        );
        assert_eq!(d(r#"{"type":"set_dashboard_layout","reset":true,"order":["bills"],"hide":["goals"],"widths":{"bills":"half","sankey":"two-thirds"},"sankeyView":"combined"}"#),
            "Home screen: reset to the default layout; order: bills; hide goals; bills half width, sankey two-thirds width; cash-flow diagram: budget vs actual");
        assert_eq!(d(r#"{"type":"set_review_prefs","defaultPeriod":"week","weekStartsOn":"sunday","compare":false,"autoAdvanceSeconds":0,"startFullscreen":true}"#),
            "Finance reviews: default to weekly reviews; start weeks on sunday; hide comparisons; turn off auto-advance; present in full screen");
        assert_eq!(
            d(r#"{"type":"set_pre_income_estimate","use":false}"#),
            "Stop showing the estimated taxes before income (use your own items)"
        );
    }

    #[test]
    fn formats_amounts_like_en_us() {
        assert_eq!(en_us_number(1234567.0, 0, 3), "1,234,567");
        assert_eq!(en_us_number(0.0005, 0, 3), "0.001");
        assert_eq!(en_us_number(12.5, 2, 2), "12.50");
        assert_eq!(en_us_number(999.9999, 0, 3), "1,000");
        assert_eq!(en_us_number(100.0, 0, 3), "100");
    }

    #[test]
    fn reads_look_ups_with_aliases_and_coercion() {
        let (q, bad) = extract_query_blocks(concat!(
            "<vault-query>{\"type\":\"merchant_totals\",\"merchant\":\" Shell \",\"days\":\"9999\"}</vault-query>",
            "vault-query{\"type\":\"home\"}</vault-query>",
            "<vault-query>{\"type\":\"cashflow\",\"months\":30}</vault-query>",
            "<vault-query>{\"type\":\"merchants\",\"months\":0}</vault-query>"
        ));
        assert_eq!(
            q,
            [
                AiQuery::Transactions {
                    merchant: Some("Shell".into()),
                    category: None,
                    from: None,
                    to: None,
                    days: Some(730),
                    limit: None
                },
                AiQuery::Dashboard
            ]
        );
        assert_eq!(bad.len(), 2);
    }

    #[test]
    fn parses_action_records() {
        let r: AiActionRecord = serde_json::from_str(
            r#"{"id":"3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f","conversationId":"0f1e2d3c-4b5a-4968-8776-655443322110",
                "messageId":"2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
                "action":{"type":"set_budget","category":"Dining","amount":250},
                "summary":"Set the monthly budget for \"Dining\" to $250","client":false,"status":"applied",
                "error":null,"createdAt":"2026-11-24T17:00:04.000Z"}"#,
        )
        .unwrap();
        assert_eq!(r.status, AiActionStatus::Applied);
        assert_eq!(describe_ai_action(&r.action), r.summary);
        let m: AiMemoryResponse = serde_json::from_str(
            r#"{"notes":[{"at":"2026-11-20T10:00:00.000Z","text":"Paid biweekly on Fridays"}]}"#,
        )
        .unwrap();
        assert_eq!(m.notes.len(), 1);
        assert_eq!(
            serde_json::to_string(&AiActionClientResult {
                status: ClientResultStatus::Applied,
                error: None
            })
            .unwrap(),
            r#"{"status":"applied"}"#
        );
    }
}
