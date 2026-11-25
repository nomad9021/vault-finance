//! Mirrors packages/shared/src/schemas/reports.ts and
//! apps/desktop/src/lib/reviewPrefs.ts, plus the pure logic of
//! ReportsPage.tsx and ReviewPresenter.tsx (filters, sorts, deltas, period
//! maths). Money formatting goes through the browser, so the text builders
//! take a `formatCentsWhole` closure.

use serde::Deserialize;

use crate::bills::Bill;
use crate::budgets::{BudgetListResponse, BudgetWithSpend};
use crate::cashflow::MonthSummary;
use crate::dates::{parse_iso, to_iso, weekday};
use crate::goals::Goal;
use crate::money::js_round;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySpend {
    pub category_id: Option<String>,
    pub name: String,
    pub color: String,
    pub spent_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyReport {
    pub month: String,
    pub income_cents: i64,
    pub spending_cents: i64,
    pub saved_cents: i64,
    pub savings_rate: Option<f64>,
    pub top_categories: Vec<CategorySpend>,
    /// Cached AI commentary; null when AI is off and nothing was cached.
    pub ai_summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YearlyReport {
    pub year: i32,
    pub months: Vec<MonthSummary>,
    pub total_income_cents: i64,
    pub total_spending_cents: i64,
    pub total_saved_cents: i64,
    pub savings_rate: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewPeriod {
    Week,
    Month,
}

impl ReviewPeriod {
    pub fn as_str(self) -> &'static str {
        match self {
            ReviewPeriod::Week => "week",
            ReviewPeriod::Month => "month",
        }
    }

    pub fn parse(s: &str) -> ReviewPeriod {
        if s == "week" {
            ReviewPeriod::Week
        } else {
            ReviewPeriod::Month
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTotals {
    pub income_cents: i64,
    pub spending_cents: i64,
    pub saved_cents: i64,
    pub transaction_count: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMerchant {
    pub name: String,
    pub spent_cents: i64,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTransaction {
    pub id: String,
    pub posted_at: String,
    pub merchant_name: String,
    pub amount_cents: i64,
    pub category_name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCategory {
    pub category_id: Option<String>,
    pub name: String,
    pub color: String,
    pub spent_cents: i64,
    pub previous_spent_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailySpend {
    pub date: String,
    pub spent_cents: i64,
}

/// `PeriodReview`: one week or month for the presenter; covers [start, end).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodReview {
    pub income_cents: i64,
    pub spending_cents: i64,
    pub saved_cents: i64,
    pub transaction_count: i64,
    pub period: ReviewPeriod,
    pub start: String,
    pub end: String,
    pub savings_rate: Option<f64>,
    pub previous: ReviewTotals,
    pub categories: Vec<ReviewCategory>,
    pub top_merchants: Vec<ReviewMerchant>,
    pub largest_purchases: Vec<ReviewTransaction>,
    pub daily_spending: Vec<DailySpend>,
}

// ── Review preferences (already parsed by parseReviewPrefs on the host) ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlideId {
    Overview,
    Categories,
    Daily,
    Merchants,
    Largest,
    Budgets,
    Bills,
    Goals,
    Ai,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SlidePref {
    pub id: SlideId,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPrefs {
    pub default_period: ReviewPeriod,
    /// "monday" | "sunday".
    pub week_starts_on: String,
    pub slides: Vec<SlidePref>,
    pub compare: bool,
    /// 0 = advance manually.
    pub auto_advance_seconds: f64,
    pub start_fullscreen: bool,
}

impl Default for ReviewPrefs {
    /// `DEFAULT_REVIEW_PREFS`.
    fn default() -> Self {
        use SlideId::*;
        ReviewPrefs {
            default_period: ReviewPeriod::Month,
            week_starts_on: "monday".into(),
            slides: [
                Overview, Categories, Daily, Merchants, Largest, Budgets, Bills, Goals, Ai,
            ]
            .into_iter()
            .map(|id| SlidePref { id, enabled: true })
            .collect(),
            compare: true,
            auto_advance_seconds: 0.0,
            start_fullscreen: false,
        }
    }
}

impl ReviewPrefs {
    pub fn week_starts_monday(&self) -> bool {
        self.week_starts_on != "sunday"
    }

    /// `wantsAi` minus the `aiVisible`/period checks: the AI slide is on.
    pub fn ai_slide_enabled(&self) -> bool {
        self.slides.iter().any(|s| s.id == SlideId::Ai && s.enabled)
    }
}

// ── Reports page ──

/// `Math.round(rate * 100) + "%"`, or "—" without a rate.
pub fn rate_text(rate: Option<f64>) -> String {
    match rate {
        Some(r) => format!("{}%", js_round(r * 100.0)),
        None => "—".into(),
    }
}

/// The table's rows: months with any activity, up to `current_month`.
pub fn months_with_data<'a>(
    months: &'a [MonthSummary],
    current_month: &str,
) -> Vec<&'a MonthSummary> {
    months
        .iter()
        .filter(|m| {
            (m.income_cents > 0 || m.spending_cents > 0) && m.month.as_str() <= current_month
        })
        .collect()
}

/// `GoalRow` on the month detail: percent (capped at 100) and status.
#[derive(Debug, Clone, PartialEq)]
pub struct GoalTrack {
    pub pct: i64,
    pub label: &'static str,
    pub color: &'static str,
    pub target_month: Option<String>,
}

pub fn goal_track(goal: &Goal) -> GoalTrack {
    let pct = if goal.target_cents > 0 {
        js_round(goal.saved_cents as f64 / goal.target_cents as f64 * 100.0).min(100)
    } else {
        0
    };
    let target_month = goal
        .target_date
        .as_ref()
        .map(|d| d.chars().take(7).collect::<String>());
    let (label, color) = if pct >= 100 {
        ("Reached 🎉", "var(--color-positive)")
    } else if target_month.as_deref().unwrap_or("").is_empty() {
        ("No deadline", "var(--content-tertiary)")
    } else {
        match goal.projected_completion.as_deref() {
            None | Some("") => ("Add funds to project", "var(--content-tertiary)"),
            Some(p) if Some(p) <= target_month.as_deref() => ("On track", "var(--color-positive)"),
            Some(_) => ("Behind", "var(--color-negative)"),
        }
    };
    GoalTrack {
        pct,
        label,
        color,
        target_month: target_month.filter(|t| !t.is_empty()),
    }
}

// ── Review presenter ──

/// Enabled slides in order, minus any with nothing to show.
pub fn visible_slides(
    prefs: &ReviewPrefs,
    has_ai_summary: bool,
    budget_count: usize,
    goal_count: usize,
) -> Vec<SlideId> {
    prefs
        .slides
        .iter()
        .filter(|s| s.enabled)
        .map(|s| s.id)
        .filter(|id| match id {
            SlideId::Ai => has_ai_summary,
            SlideId::Budgets => budget_count > 0,
            SlideId::Goals => goal_count > 0,
            _ => true,
        })
        .collect()
}

/// `go(by)`: `max(0, min(count - 1, min(i, count - 1) + by))`.
pub fn step_index(i: usize, by: i64, count: usize) -> usize {
    let last = count as i64 - 1;
    (i as i64).min(last).saturating_add(by).min(last).max(0) as usize
}

/// `Math.min(index, Math.max(0, count - 1))`.
pub fn safe_index(i: usize, count: usize) -> usize {
    i.min(count.saturating_sub(1))
}

fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y as i64 - 1 } else { y as i64 };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = (yoe + era * 400 + if m <= 2 { 1 } else { 0 }) as i32;
    (y, m, d)
}

/// `Date.UTC(y, m - 1, d)` with JS overflow (day 0, day 40, month 13…) as an ISO day.
fn utc_iso(y: i32, m0: i64, d: i64) -> String {
    let year = y as i64 + m0.div_euclid(12);
    let month = m0.rem_euclid(12) as u32 + 1;
    let (y, m, d) = civil_from_days(days_from_civil(year as i32, month, 1) + d - 1);
    to_iso(y, m, d)
}

/// `periodStart(period, day, weekStartsOn)`; `day` is "YYYY-MM-DD" (UTC).
pub fn period_start(period: ReviewPeriod, day: &str, monday: bool) -> String {
    let Some((y, m, d)) = parse_iso(day) else {
        return day.to_string();
    };
    match period {
        ReviewPeriod::Month => to_iso(y, m, 1),
        ReviewPeriod::Week => {
            let wd = weekday(y, m, d);
            let offset = if monday { (wd + 6) % 7 } else { wd };
            utc_iso(y, m as i64 - 1, d as i64 - offset as i64)
        }
    }
}

/// `shiftPeriod(period, start, by)`.
pub fn shift_period(period: ReviewPeriod, start: &str, by: i64) -> String {
    let Some((y, m, d)) = parse_iso(start) else {
        return start.to_string();
    };
    match period {
        ReviewPeriod::Month => utc_iso(y, m as i64 - 1 + by, 1),
        ReviewPeriod::Week => utc_iso(y, m as i64 - 1, d as i64 + 7 * by),
    }
}

/// The last day of a week starting on `start` (for the week label).
pub fn week_end(start: &str) -> String {
    shift_period_days(start, 6)
}

fn shift_period_days(start: &str, days: i64) -> String {
    match parse_iso(start) {
        Some((y, m, d)) => utc_iso(y, m as i64 - 1, d as i64 + days),
        None => start.to_string(),
    }
}

/// The overview slide's sentence under the three stats.
pub fn headline(
    review: &PeriodReview,
    prev: Option<&ReviewTotals>,
    prev_word: &str,
    whole: &dyn Fn(i64) -> String,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(rate) = review.savings_rate {
        parts.push(format!(
            "You kept {}% of what came in.",
            js_round(rate * 100.0)
        ));
    } else if review.income_cents == 0 && review.spending_cents > 0 {
        parts.push("No income recorded in this period yet.".into());
    }
    if let Some(prev) = prev.filter(|p| p.spending_cents > 0) {
        let diff = review.spending_cents - prev.spending_cents;
        if diff.abs() >= 100 {
            parts.push(format!(
                "Spending was {} {} than {prev_word}.",
                whole(diff.abs()),
                if diff > 0 { "more" } else { "less" }
            ));
        }
    }
    parts.push(format!(
        "{} {}.",
        review.transaction_count,
        if review.transaction_count == 1 {
            "transaction"
        } else {
            "transactions"
        }
    ));
    parts.join(" ")
}

/// `<Delta>`: its text and whether the change is good (`None` = no change).
pub fn delta(
    now: i64,
    prev: i64,
    prev_word: &str,
    good_when_up: bool,
    compact: bool,
    whole: &dyn Fn(i64) -> String,
) -> (String, Option<bool>) {
    let diff = now - prev;
    let text = if prev == 0 && now == 0 {
        "–".to_string()
    } else if prev == 0 || prev.abs() < 100 {
        if compact {
            "new".to_string()
        } else {
            format!("{} vs {prev_word}", whole(diff))
        }
    } else {
        let pct = js_round(diff as f64 / prev.abs() as f64 * 100.0);
        if pct == 0 {
            format!("same as {prev_word}")
        } else {
            format!(
                "{} {}%{}",
                if pct > 0 { "▲" } else { "▼" },
                pct.abs(),
                if compact {
                    String::new()
                } else {
                    format!(" vs {prev_word}")
                }
            )
        }
    };
    let good = (diff != 0).then_some((diff > 0) == good_when_up);
    (text, good)
}

/// `busiest(days)`: the first day with the most spending, if any spent.
pub fn busiest(days: &[DailySpend]) -> Option<&DailySpend> {
    days.iter().fold(None, |best: Option<&DailySpend>, d| {
        if d.spent_cents > best.map_or(0, |b| b.spent_cents) {
            Some(d)
        } else {
            best
        }
    })
}

/// Day-by-day bars: tallest bar and the daily average.
pub fn daily_stats(review: &PeriodReview) -> (i64, i64) {
    let days = &review.daily_spending;
    let max = days.iter().map(|d| d.spent_cents).fold(1, i64::max);
    let avg = js_round(review.spending_cents as f64 / days.len().max(1) as f64);
    (max, avg)
}

/// A bar's height in percent: `max(spent > 0 ? 1.5 : 0, spent / max * 100)`.
pub fn bar_height(spent: i64, max: i64) -> f64 {
    let floor = if spent > 0 { 1.5 } else { 0.0 };
    f64::max(floor, spent as f64 / max as f64 * 100.0)
}

/// Month view axis: label the 1st and every 5th day.
pub fn month_tick(i: usize) -> bool {
    i == 0 || (i + 1).is_multiple_of(5)
}

/// Budgets slide: most-used first (spent / amount, descending).
pub fn sorted_budgets(budgets: &BudgetListResponse) -> Vec<BudgetWithSpend> {
    let ratio = |b: &BudgetWithSpend| b.spent_cents as f64 / b.amount_cents as f64;
    let mut rows = budgets.budgets.clone();
    rows.sort_by(|a, b| {
        ratio(b)
            .partial_cmp(&ratio(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

/// Budgets slide: spent / amount (0 without an amount).
pub fn budget_pct(b: &BudgetWithSpend) -> f64 {
    if b.amount_cents > 0 {
        b.spent_cents as f64 / b.amount_cents as f64
    } else {
        0.0
    }
}

/// Bills slide: due within the horizon (7 or 31 days), soonest first.
pub fn upcoming_bills(bills: &[Bill], period: ReviewPeriod) -> Vec<Bill> {
    let horizon = if period == ReviewPeriod::Week { 7 } else { 31 };
    let mut up: Vec<Bill> = bills
        .iter()
        .filter(|b| b.days_until_due >= 0 && b.days_until_due <= horizon)
        .cloned()
        .collect();
    up.sort_by_key(|b| b.days_until_due);
    up
}

/// "due today" / "in 1 day" / "in 4 days".
pub fn due_in(days: i64) -> String {
    match days {
        0 => "due today".into(),
        1 => "in 1 day".into(),
        n => format!("in {n} days"),
    }
}

/// Goals slide: fraction saved and the on-track tag (`None` = no tag).
pub fn goal_slide_status(goal: &Goal) -> (f64, Option<&'static str>) {
    let pct = if goal.target_cents > 0 {
        goal.saved_cents as f64 / goal.target_cents as f64
    } else {
        0.0
    };
    let target: Option<String> = goal
        .target_date
        .as_ref()
        .map(|d| d.chars().take(7).collect());
    let status = if pct >= 1.0 {
        Some("Reached 🎉")
    } else {
        match (target.as_deref(), goal.projected_completion.as_deref()) {
            (Some(t), Some(p)) if !t.is_empty() && !p.is_empty() => {
                Some(if p <= t { "On track" } else { "Behind" })
            }
            _ => None,
        }
    };
    (pct, status)
}

/// `RankList`'s bar scale: `max(1, ...cents)`.
pub fn rank_max(cents: &[i64]) -> i64 {
    cents.iter().copied().fold(1, i64::max)
}

/// "`n`% of spending" (`total` must be non-zero).
pub fn share_of(cents: i64, total: i64) -> i64 {
    js_round(cents as f64 / total as f64 * 100.0)
}

/// `<Bar>` width: `min(100, max(0, pct * 100))`.
pub fn bar_width(pct: f64) -> f64 {
    (pct * 100.0).clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REVIEW: &str = r##"{
        "period": "week", "start": "2026-11-16", "end": "2026-11-23",
        "incomeCents": 420000, "spendingCents": 131250, "savedCents": 288750,
        "transactionCount": 23, "savingsRate": 0.6875,
        "previous": {"incomeCents": 0, "spendingCents": 98000, "savedCents": -98000, "transactionCount": 17},
        "categories": [{"categoryId": "7c0f1d38-3a2c-4b8e-9b1e-6a9f0d1c2e3f", "name": "Groceries", "color": "#3ecf8e", "spentCents": 41200, "previousSpentCents": 38800},
                       {"categoryId": null, "name": "Uncategorized", "color": "#888888", "spentCents": 5000, "previousSpentCents": 0}],
        "topMerchants": [{"name": "Trader Joe's", "spentCents": 21200, "count": 2}],
        "largestPurchases": [{"id": "0b8f3e1a-5d2c-4f7a-8e9b-1c2d3e4f5a6b", "postedAt": "2026-11-18T00:00:00.000Z", "merchantName": "Costco", "amountCents": -18900, "categoryName": "Groceries", "color": "#3ecf8e"}],
        "dailySpending": [{"date": "2026-11-16", "spentCents": 0}, {"date": "2026-11-17", "spentCents": 18900}, {"date": "2026-11-18", "spentCents": 18900}]
    }"##;

    fn whole(c: i64) -> String {
        let s = format!("${}", (c.abs() as f64 / 100.0).round());
        if c < 0 {
            format!("−{s}")
        } else {
            s
        }
    }

    fn goal(saved: i64, target: i64, date: Option<&str>, projected: Option<&str>) -> Goal {
        serde_json::from_value(serde_json::json!({
            "id": "g1", "name": "Trip", "targetCents": target, "savedCents": saved,
            "monthlyCents": 10000, "linkedAccountId": null, "targetDate": date,
            "color": "#6f8ef2", "note": null, "projectedCompletion": projected
        }))
        .unwrap()
    }

    #[test]
    fn parses_reports() {
        let r: PeriodReview = serde_json::from_str(REVIEW).unwrap();
        assert_eq!(r.period, ReviewPeriod::Week);
        assert_eq!(r.categories[1].category_id, None);
        assert_eq!(r.largest_purchases[0].amount_cents, -18900);
        let y: YearlyReport = serde_json::from_str(
            r#"{"year": 2026, "months": [{"month": "2026-01", "incomeCents": 500000, "spendingCents": 320000, "netCents": 180000, "savingsRate": 0.36},
               {"month": "2026-12", "incomeCents": 0, "spendingCents": 0, "netCents": 0, "savingsRate": null}],
               "totalIncomeCents": 500000, "totalSpendingCents": 320000, "totalSavedCents": 180000, "savingsRate": 0.36}"#,
        )
        .unwrap();
        assert_eq!(months_with_data(&y.months, "2026-11").len(), 1);
        let m: MonthlyReport = serde_json::from_str(
            r##"{"month": "2026-10", "incomeCents": 1, "spendingCents": 2, "savedCents": -1, "savingsRate": null,
                "topCategories": [{"categoryId": null, "name": "Other", "color": "#999", "spentCents": 2}], "aiSummary": null}"##,
        )
        .unwrap();
        assert_eq!(m.ai_summary, None);
        let p: ReviewPrefs = serde_json::from_str(
            r#"{"defaultPeriod": "week", "weekStartsOn": "sunday", "slides": [{"id": "ai", "enabled": false}, {"id": "overview", "enabled": true}],
                "compare": false, "autoAdvanceSeconds": 8, "startFullscreen": true}"#,
        )
        .unwrap();
        assert!(!p.week_starts_monday());
        assert!(!p.ai_slide_enabled());
        assert_eq!(ReviewPrefs::default().slides.len(), 9);
    }

    #[test]
    fn rates_and_months() {
        assert_eq!(rate_text(Some(0.345)), "35%");
        assert_eq!(rate_text(Some(-0.125)), "-12%");
        assert_eq!(rate_text(None), "—");
    }

    #[test]
    fn periods() {
        // 2026-11-24 is a Tuesday.
        assert_eq!(
            period_start(ReviewPeriod::Week, "2026-11-24", true),
            "2026-11-23"
        );
        assert_eq!(
            period_start(ReviewPeriod::Week, "2026-11-24", false),
            "2026-11-22"
        );
        assert_eq!(
            period_start(ReviewPeriod::Week, "2026-11-23", true),
            "2026-11-23"
        );
        assert_eq!(
            period_start(ReviewPeriod::Week, "2026-03-01", true),
            "2026-02-23"
        );
        assert_eq!(
            period_start(ReviewPeriod::Month, "2026-11-24", true),
            "2026-11-01"
        );
        assert_eq!(
            shift_period(ReviewPeriod::Month, "2026-01-01", -1),
            "2025-12-01"
        );
        assert_eq!(
            shift_period(ReviewPeriod::Month, "2026-12-01", 1),
            "2027-01-01"
        );
        assert_eq!(
            shift_period(ReviewPeriod::Week, "2026-12-28", 1),
            "2027-01-04"
        );
        assert_eq!(
            shift_period(ReviewPeriod::Week, "2026-03-02", -1),
            "2026-02-23"
        );
        assert_eq!(week_end("2026-12-28"), "2027-01-03");
    }

    #[test]
    fn slides_and_index() {
        let prefs = ReviewPrefs::default();
        let s = visible_slides(&prefs, false, 0, 2);
        assert!(!s.contains(&SlideId::Ai) && !s.contains(&SlideId::Budgets));
        assert!(s.contains(&SlideId::Goals));
        assert_eq!(s.len(), 7);
        assert_eq!(step_index(0, 1, 7), 1);
        assert_eq!(step_index(6, 1, 7), 6);
        assert_eq!(step_index(0, -1, 7), 0);
        assert_eq!(step_index(9, -1, 3), 1);
        assert_eq!(step_index(0, 1, 0), 0);
        assert_eq!(safe_index(5, 3), 2);
        assert_eq!(safe_index(5, 0), 0);
    }

    #[test]
    fn headline_and_delta() {
        let r: PeriodReview = serde_json::from_str(REVIEW).unwrap();
        assert_eq!(
            headline(&r, Some(&r.previous), "last week", &whole),
            "You kept 69% of what came in. Spending was $333 more than last week. 23 transactions."
        );
        assert_eq!(
            headline(&r, None, "last week", &whole),
            "You kept 69% of what came in. 23 transactions."
        );
        assert_eq!(
            delta(0, 0, "last week", false, false, &whole),
            ("–".into(), None)
        );
        assert_eq!(
            delta(500, 0, "last week", true, false, &whole),
            ("$5 vs last week".into(), Some(true))
        );
        assert_eq!(
            delta(500, 50, "last week", false, true, &whole),
            ("new".into(), Some(false))
        );
        assert_eq!(
            delta(11000, 10000, "last month", false, false, &whole),
            ("▲ 10% vs last month".into(), Some(false))
        );
        assert_eq!(
            delta(9000, 10000, "last month", false, true, &whole),
            ("▼ 10%".into(), Some(true))
        );
        assert_eq!(
            delta(10010, 10000, "last month", false, false, &whole),
            ("same as last month".into(), Some(false))
        );
    }

    #[test]
    fn daily() {
        let r: PeriodReview = serde_json::from_str(REVIEW).unwrap();
        assert_eq!(busiest(&r.daily_spending).unwrap().date, "2026-11-17");
        assert_eq!(daily_stats(&r), (18900, 43750));
        assert_eq!(bar_height(0, 100), 0.0);
        assert_eq!(bar_height(1, 1000), 1.5);
        assert_eq!(bar_height(50, 100), 50.0);
        assert!(month_tick(0) && month_tick(4) && !month_tick(1));
        assert_eq!(busiest(&[]), None);
    }

    #[test]
    fn goals() {
        let g = goal_track(&goal(5000, 10000, Some("2027-06-01"), Some("2027-03")));
        assert_eq!(
            (g.pct, g.label, g.target_month.as_deref()),
            (50, "On track", Some("2027-06"))
        );
        assert_eq!(
            goal_track(&goal(5000, 10000, Some("2027-01-01"), Some("2027-03"))).label,
            "Behind"
        );
        assert_eq!(
            goal_track(&goal(5000, 10000, None, Some("2027-03"))).label,
            "No deadline"
        );
        assert_eq!(
            goal_track(&goal(0, 10000, Some("2027-01-01"), None)).label,
            "Add funds to project"
        );
        assert_eq!(goal_track(&goal(12000, 10000, None, None)).pct, 100);
        assert_eq!(
            goal_track(&goal(12000, 10000, None, None)).label,
            "Reached 🎉"
        );
        assert_eq!(
            goal_slide_status(&goal(5000, 10000, None, Some("2027-03"))).1,
            None
        );
        assert_eq!(
            goal_slide_status(&goal(5000, 10000, Some("2027-06-01"), Some("2027-03"))).1,
            Some("On track")
        );
        assert_eq!(goal_slide_status(&goal(0, 0, None, None)), (0.0, None));
    }

    #[test]
    fn bills_and_budgets() {
        let bill = |id: &str, days: i64| -> Bill {
            serde_json::from_value(serde_json::json!({
                "id": id, "name": id, "amountCents": 1000, "savedCents": 0, "dueDay": 1, "cadence": "monthly",
                "autopay": false, "accountId": null, "categoryId": null, "color": "#fff",
                "nextDueDate": "2026-12-01", "daysUntilDue": days
            }))
            .unwrap()
        };
        let bills = vec![
            bill("a", 20),
            bill("b", 3),
            bill("c", -1),
            bill("d", 7),
            bill("e", 40),
        ];
        let ids = |v: Vec<Bill>| v.into_iter().map(|b| b.id).collect::<Vec<_>>();
        assert_eq!(ids(upcoming_bills(&bills, ReviewPeriod::Week)), ["b", "d"]);
        assert_eq!(
            ids(upcoming_bills(&bills, ReviewPeriod::Month)),
            ["b", "d", "a"]
        );
        assert_eq!(due_in(0), "due today");
        assert_eq!(due_in(1), "in 1 day");
        assert_eq!(due_in(5), "in 5 days");
        let budgets: BudgetListResponse = serde_json::from_value(serde_json::json!({
            "month": "2026-11", "totalBudgetedCents": 30000, "totalSpentCents": 25000,
            "budgets": [
                {"id": "x", "categoryId": "c1", "amountCents": 10000, "rollover": false, "startsOn": "2026-01-01", "spentCents": 5000},
                {"id": "y", "categoryId": "c2", "amountCents": 20000, "rollover": false, "startsOn": "2026-01-01", "spentCents": 20000}
            ]
        }))
        .unwrap();
        let sorted = sorted_budgets(&budgets);
        assert_eq!(sorted[0].id, "y");
        assert_eq!(budget_pct(&sorted[1]), 0.5);
        assert_eq!(rank_max(&[]), 1);
        assert_eq!(share_of(250, 1000), 25);
        assert_eq!(bar_width(1.4), 100.0);
        assert_eq!(bar_width(-0.2), 0.0);
    }
}
