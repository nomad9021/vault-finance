//! The home screen's pure logic: apps/desktop/src/screens/shell/DashboardPage.tsx
//! (default month, safe to spend, the cards' figures, which widgets show)
//! and the reordering in apps/desktop/src/lib/homeArrange.ts.

use std::collections::{HashMap, HashSet};

use crate::bills::Bill;
use crate::budget_period::{period_figures, PeriodFigures};
use crate::budgets::BudgetWithSpend;
use crate::cashflow::TrendPoint;
use crate::categories::Category;
use crate::dashboard::{
    default_spans, resolve_layout, DashboardWidget, ResolvedWidget, SankeyView, Span, SPANS,
};
use crate::dates::days_in_month;
use crate::goals::Goal;
use crate::money::{js_round, to_fixed};

// ── Month ──

/// `defaultMonth`: the current month, unless it has no activity yet (but
/// the trends know it), then the latest month that has some.
pub fn default_month(points: &[TrendPoint], now: &str) -> String {
    let Some(current) = points.iter().find(|p| p.month == now) else {
        return now.to_string();
    };
    if current.income_cents > 0 || current.spending_cents > 0 {
        return now.to_string();
    }
    points
        .iter()
        .filter(|p| p.income_cents > 0 || p.spending_cents > 0)
        .map(|p| p.month.as_str())
        .max()
        .unwrap_or(now)
        .to_string()
}

/// `daysLeftInMonth()`: today counts.
pub fn days_left_in_month(year: i32, month: u32, day: u32) -> u32 {
    days_in_month(year, month).saturating_sub(day) + 1
}

/// `Math.round(((income - spending) / income) * 100)`, `None` without income.
pub fn savings_rate(income_cents: i64, spending_cents: i64) -> Option<i64> {
    (income_cents > 0)
        .then(|| js_round((income_cents - spending_cents) as f64 / income_cents as f64 * 100.0))
}

// ── Safe to spend ──

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `SAVINGS_NAME`: /saving|invest|retire|401\s?k|\bira\b|emergency fund|sinking fund|brokerage/i.
pub fn is_savings_name(name: &str) -> bool {
    let s: Vec<char> = name.to_lowercase().chars().collect();
    let text: String = s.iter().collect();
    if [
        "saving",
        "invest",
        "retire",
        "emergency fund",
        "sinking fund",
        "brokerage",
    ]
    .iter()
    .any(|w| text.contains(w))
    {
        return true;
    }
    let at = |i: usize| s.get(i).copied();
    for i in 0..s.len() {
        if s[i..].starts_with(&['4', '0', '1']) {
            if at(i + 3) == Some('k') {
                return true;
            }
            if at(i + 3).is_some_and(char::is_whitespace) && at(i + 4) == Some('k') {
                return true;
            }
        }
        if s[i..].starts_with(&['i', 'r', 'a'])
            && (i == 0 || !is_word(s[i - 1]))
            && !at(i + 3).is_some_and(is_word)
        {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SafeToSpend {
    pub left_cents: i64,
    pub budgeted_cents: i64,
    pub spent_cents: i64,
    pub excluded: usize,
}

/// `safeToSpend`: what's left in the month's budgets, leaving out the
/// budgets for bills and savings (and everything under them).
pub fn safe_to_spend(
    budgets: &[BudgetWithSpend],
    categories: &[Category],
    bills: &[Bill],
) -> SafeToSpend {
    let by_id: HashMap<&str, &Category> = categories.iter().map(|c| (c.id.as_str(), c)).collect();
    let roots: HashSet<&str> = bills
        .iter()
        .filter_map(|b| b.category_id.as_deref())
        .filter(|id| !id.is_empty())
        .chain(
            categories
                .iter()
                .filter(|c| is_savings_name(&c.name))
                .map(|c| c.id.as_str()),
        )
        .collect();
    let excluded_cat = |id: &str| {
        let mut cur = by_id.get(id).copied();
        let mut n = 0;
        while let Some(c) = cur {
            if n >= 50 {
                break;
            }
            if roots.contains(c.id.as_str()) {
                return true;
            }
            cur = c
                .parent_category_id
                .as_deref()
                .and_then(|p| by_id.get(p).copied());
            n += 1;
        }
        roots.contains(id)
    };
    let mut out = SafeToSpend::default();
    for b in budgets {
        if excluded_cat(&b.category_id) {
            out.excluded += 1;
            continue;
        }
        out.budgeted_cents += b.amount_cents;
        out.spent_cents += b.spent_cents;
    }
    out.left_cents = out.budgeted_cents - out.spent_cents;
    out
}

/// "$40 over plan" / "$40 under plan" / "On plan" parts: (off, good).
pub fn plan_off(actual: i64, planned: i64, good_when_over: bool) -> (i64, bool) {
    let off = actual - planned;
    (off, if good_when_over { off >= 0 } else { off <= 0 })
}

// ── Cards ──

/// The budgets card's three categories closest to (or over) their limit.
pub fn ranked_budgets(budgets: &[BudgetWithSpend]) -> Vec<(BudgetWithSpend, PeriodFigures)> {
    let mut ranked: Vec<(BudgetWithSpend, PeriodFigures)> = budgets
        .iter()
        .map(|b| (b.clone(), period_figures(b)))
        .filter(|(_, f)| f.limit > 0)
        .collect();
    let ratio = |f: &PeriodFigures| f.spent as f64 / f.limit as f64;
    ranked.sort_by(|(_, x), (_, y)| {
        ratio(y)
            .partial_cmp(&ratio(x))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    ranked.truncate(3);
    ranked
}

fn goal_share(g: &Goal) -> f64 {
    g.saved_cents as f64
        / if g.target_cents != 0 {
            g.target_cents as f64
        } else {
            1.0
        }
}

/// `TopGoals`: unfinished goals first, closest to done first; finished last. Three.
pub fn top_goals(goals: &[Goal]) -> Vec<Goal> {
    let mut top = goals.to_vec();
    top.sort_by(|a, b| {
        let (pa, pb) = (goal_share(a), goal_share(b));
        let done = (pa >= 1.0).cmp(&(pb >= 1.0));
        done.then(pb.partial_cmp(&pa).unwrap_or(std::cmp::Ordering::Equal))
    });
    top.truncate(3);
    top
}

/// Progress bar value, 0–1.
pub fn goal_progress(g: &Goal) -> f64 {
    if g.target_cents > 0 {
        (g.saved_cents as f64 / g.target_cents as f64).min(1.0)
    } else {
        0.0
    }
}

/// `goalPlanLine`. `whole` is formatCentsWhole, `month_year` "YYYY-MM" →
/// "Sep 2027".
pub fn goal_plan_line(
    g: &Goal,
    pct: f64,
    whole: impl Fn(i64) -> String,
    month_year: impl Fn(&str) -> String,
) -> String {
    if pct >= 1.0 {
        return "Funded".into();
    }
    let mut parts = vec![format!("{}%", js_round(pct * 100.0))];
    if g.monthly_cents > 0 {
        parts.push(format!("{} a month", whole(g.monthly_cents)));
    }
    if let Some(d) = g.target_date.as_deref().filter(|d| !d.is_empty()) {
        parts.push(format!(
            "target {}",
            month_year(&d.chars().take(7).collect::<String>())
        ));
    } else if let Some(p) = g.projected_completion.as_deref().filter(|p| !p.is_empty()) {
        parts.push(format!("on track for {}", month_year(p)));
    }
    parts.join(" · ")
}

/// A trend card's headline: the change since the first month.
#[derive(Debug, Clone, PartialEq)]
pub struct TrendSummary {
    pub current: i64,
    pub first: i64,
    pub delta: i64,
    /// " (+12%)", only from a real base and when it isn't absurd.
    pub pct: Option<String>,
}

pub fn trend_summary(history: &[i64]) -> TrendSummary {
    let current = history.last().copied().unwrap_or(0);
    let first = history.first().copied().unwrap_or(0);
    let delta = current - first;
    let base = if first != 0 { first.abs() as f64 } else { 1.0 };
    let pct = delta as f64 / base * 100.0;
    let pct = (first.abs() >= 100 && pct.abs() < 1000.0).then(|| {
        format!(
            " ({}{}%)",
            if pct >= 0.0 { "+" } else { "" },
            to_fixed(pct, 0)
        )
    });
    TrendSummary {
        current,
        first,
        delta,
        pct,
    }
}

/// `(gain / cost) * 100` with its sign and one decimal: "(+12.3%)".
pub fn gain_pct_label(value_cents: i64, cost_cents: i64) -> String {
    let gain = value_cents - cost_cents;
    let pct = if cost_cents > 0 {
        gain as f64 / cost_cents as f64 * 100.0
    } else {
        0.0
    };
    format!(
        "({}{}%)",
        if pct >= 0.0 { "+" } else { "" },
        to_fixed(pct, 1)
    )
}

// ── Sankey view ──

pub const SANKEY_VIEWS: &[(SankeyView, &str)] = &[
    (SankeyView::Actual, "Actual"),
    (SankeyView::Planned, "Planned"),
    (SankeyView::Both, "Both"),
    (SankeyView::Combined, "Budget vs actual"),
];

/// `loadSankeyView`: this device's old choice.
pub fn parse_sankey_view(stored: Option<&str>) -> SankeyView {
    match stored {
        Some("planned") => SankeyView::Planned,
        Some("both") => SankeyView::Both,
        Some("combined") => SankeyView::Combined,
        _ => SankeyView::Actual,
    }
}

/// The views there's data for, in menu order.
pub fn available_views(has_data: bool, has_plan: bool, has_combined: bool) -> Vec<SankeyView> {
    SANKEY_VIEWS
        .iter()
        .map(|(v, _)| *v)
        .filter(|v| match v {
            SankeyView::Actual => has_data,
            SankeyView::Planned => has_plan,
            SankeyView::Both => has_data && has_plan,
            SankeyView::Combined => has_combined,
        })
        .collect()
}

/// The remembered view if it's available, else the first that is.
pub fn effective_view(wanted: SankeyView, available: &[SankeyView]) -> SankeyView {
    if available.contains(&wanted) {
        wanted
    } else {
        available.first().copied().unwrap_or(SankeyView::Actual)
    }
}

// ── Layout ──

/// Until the person arranges it, a phone leads with these.
pub const PHONE_FIRST: &[&str] = &["guilt-free", "budgets", "goals"];

/// The layout the page works from: the saved one over the defaults (a
/// phone's defaults put [`PHONE_FIRST`] first while nothing is saved).
pub fn home_layout(phone: bool, saved: Option<&[DashboardWidget]>) -> Vec<ResolvedWidget> {
    let defaults = default_spans();
    let customized = saved.is_some_and(|s| !s.is_empty());
    let base: Vec<(&str, Span)> = if phone && !customized {
        PHONE_FIRST
            .iter()
            .filter_map(|id| defaults.iter().find(|(d, _)| d == id).copied())
            .chain(
                defaults
                    .iter()
                    .filter(|(d, _)| !PHONE_FIRST.contains(d))
                    .copied(),
            )
            .collect()
    } else {
        defaults
    };
    resolve_layout(&base, saved)
}

/// What view mode draws, and the first metric (which a phone swaps for
/// its summary card). On a phone only that one metric stays, and the net
/// worth trend goes when any metric shows (the summary carries its chart).
pub fn view_items(
    layout: &[ResolvedWidget],
    hide_sankey: bool,
    phone: bool,
) -> (Vec<ResolvedWidget>, Option<String>) {
    let shown: Vec<&ResolvedWidget> = layout
        .iter()
        .filter(|w| !w.hidden && !(hide_sankey && w.id == "sankey"))
        .collect();
    let is_metric = |w: &ResolvedWidget| w.id.starts_with("metric-");
    let first_metric = shown.iter().find(|w| is_metric(w)).map(|w| w.id.clone());
    let any_metric = first_metric.is_some();
    let items = shown
        .into_iter()
        .filter(|w| {
            !phone
                || (!(is_metric(w) && Some(&w.id) != first_metric.as_ref())
                    && !(any_metric && w.id == "trend-networth"))
        })
        .cloned()
        .collect();
    (items, first_metric)
}

/// Edit mode shows every card that isn't hidden.
pub fn edit_items(layout: &[ResolvedWidget]) -> Vec<ResolvedWidget> {
    layout.iter().filter(|w| !w.hidden).cloned().collect()
}

/// The size pill steps through the widths, wrapping.
pub fn next_span(span: Span) -> Span {
    let i = SPANS.iter().position(|(s, _)| *s == span);
    SPANS[i.map_or(0, |i| (i + 1) % SPANS.len())].0
}

pub fn span_label(span: Span) -> &'static str {
    SPANS
        .iter()
        .find(|(s, _)| *s == span)
        .map_or("", |(_, l)| l)
}

/// `setWidget(id, patch)`.
pub fn patch_widget(
    layout: &[ResolvedWidget],
    id: &str,
    hidden: Option<bool>,
    span: Option<Span>,
) -> Vec<ResolvedWidget> {
    layout
        .iter()
        .map(|w| {
            let mut w = w.clone();
            if w.id == id {
                if let Some(h) = hidden {
                    w.hidden = h;
                }
                if let Some(s) = span {
                    w.span = s;
                }
            }
            w
        })
        .collect()
}

/// After a drag: the visible cards in their new order, hidden ones after.
pub fn commit_order(layout: &[ResolvedWidget], ids: &[String]) -> Vec<ResolvedWidget> {
    ids.iter()
        .filter_map(|id| layout.iter().find(|w| &w.id == id).cloned())
        .chain(layout.iter().filter(|w| w.hidden).cloned())
        .collect()
}

/// What's saved: `[]` resets to the standard layout.
pub fn to_saved(layout: Option<&[ResolvedWidget]>) -> Vec<DashboardWidget> {
    layout
        .map(|l| l.iter().map(DashboardWidget::from).collect())
        .unwrap_or_default()
}

// ── lib/homeArrange.ts ──

/// `moveTo`: `id` to `target`'s index. `None` when nothing moves.
pub fn move_to(order: &[String], id: &str, target_index: usize) -> Option<Vec<String>> {
    let from = order.iter().position(|x| x == id)?;
    if from == target_index {
        return None;
    }
    let mut next: Vec<String> = order.iter().filter(|x| *x != id).cloned().collect();
    next.insert(target_index.min(next.len()), id.to_string());
    Some(next)
}

/// Arrow keys: -1 (up/left), 1 (down/right), 0 otherwise.
pub fn arrow_step(key: &str) -> i32 {
    match key {
        "ArrowUp" | "ArrowLeft" => -1,
        "ArrowDown" | "ArrowRight" => 1,
        _ => 0,
    }
}

/// One place earlier or later; `None` at either end.
pub fn step_order(order: &[String], id: &str, step: i32) -> Option<Vec<String>> {
    let at = order.iter().position(|x| x == id)? as i64;
    let to = at + step as i64;
    if step == 0 || to < 0 || to >= order.len() as i64 {
        return None;
    }
    move_to(order, id, to as usize)
}

/// The jiggle is staggered across four cards.
pub fn jiggle_delay(index: usize) -> String {
    let d = (index % 4) as f64 * -0.09;
    // `${n}s` as JS prints it (0 for -0).
    format!("{}s", crate::taxes::js_number_string(d))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(month: &str, income: i64, spending: i64) -> TrendPoint {
        TrendPoint {
            month: month.into(),
            net_worth_cents: 0,
            income_cents: income,
            spending_cents: spending,
        }
    }

    #[test]
    fn falls_back_to_the_last_month_with_activity() {
        let pts = [
            pt("2026-09", 100, 0),
            pt("2026-10", 0, 50),
            pt("2026-11", 0, 0),
        ];
        assert_eq!(default_month(&pts, "2026-11"), "2026-10");
        assert_eq!(default_month(&pts[..2], "2026-11"), "2026-11");
        let busy = [pt("2026-11", 1, 0)];
        assert_eq!(default_month(&busy, "2026-11"), "2026-11");
        assert_eq!(default_month(&[pt("2026-11", 0, 0)], "2026-11"), "2026-11");
    }

    #[test]
    fn counts_days_left_and_savings_rate() {
        assert_eq!(days_left_in_month(2026, 11, 24), 7);
        assert_eq!(days_left_in_month(2026, 2, 28), 1);
        assert_eq!(savings_rate(0, 10), None);
        assert_eq!(savings_rate(1000, 750), Some(25));
        assert_eq!(savings_rate(1000, 1500), Some(-50));
        assert_eq!(savings_rate(3, 2), Some(33));
    }

    #[test]
    fn matches_savings_names_like_the_regex() {
        for yes in [
            "Savings",
            "Investments",
            "Retirement",
            "401k",
            "401 k match",
            "Roth IRA",
            "ira",
            "Emergency fund",
            "Sinking Fund",
            "Brokerage",
        ] {
            assert!(is_savings_name(yes), "{yes}");
        }
        for no in ["Groceries", "Irate", "Mirage", "401", "Emergency", "Kira"] {
            assert!(!is_savings_name(no), "{no}");
        }
    }

    fn cats() -> Vec<Category> {
        serde_json::from_str(
            r##"[
            {"id":"food","name":"Food","icon":null,"color":"#f00","parentCategoryId":null,"sortOrder":0,"kind":"expense","isSystem":false},
            {"id":"groc","name":"Groceries","icon":null,"color":"#f00","parentCategoryId":"food","sortOrder":0,"kind":"expense","isSystem":false},
            {"id":"home","name":"Housing","icon":null,"color":"#0f0","parentCategoryId":null,"sortOrder":1,"kind":"expense","isSystem":false},
            {"id":"rent","name":"Rent","icon":null,"color":"#0f0","parentCategoryId":"home","sortOrder":0,"kind":"expense","isSystem":false},
            {"id":"sav","name":"Savings","icon":null,"color":"#00f","parentCategoryId":null,"sortOrder":2,"kind":"expense","isSystem":false},
            {"id":"efund","name":"Rainy day","icon":null,"color":"#00f","parentCategoryId":"sav","sortOrder":0,"kind":"expense","isSystem":false}
        ]"##,
        )
        .unwrap()
    }

    fn budget(cat: &str, amount: i64, spent: i64) -> BudgetWithSpend {
        serde_json::from_value(serde_json::json!({
            "id": format!("b-{cat}"), "categoryId": cat, "amountCents": amount, "rollover": false,
            "startsOn": "2026-11-01", "spentCents": spent
        }))
        .unwrap()
    }

    fn bill(cat: Option<&str>) -> Bill {
        serde_json::from_value(serde_json::json!({
            "id": "bill", "name": "Rent", "amountCents": 150000, "savedCents": 0, "dueDay": 1,
            "cadence": "monthly", "autopay": false, "accountId": null, "categoryId": cat,
            "color": "#000", "nextDueDate": "2026-12-01", "daysUntilDue": 7
        }))
        .unwrap()
    }

    #[test]
    fn leaves_bills_and_savings_out_of_safe_to_spend() {
        let budgets = [
            budget("groc", 60000, 45000),
            budget("rent", 150000, 150000),
            budget("efund", 20000, 20000),
            budget("food", 10000, 2000),
        ];
        let s = safe_to_spend(&budgets, &cats(), &[bill(Some("home")), bill(None)]);
        assert_eq!(
            s,
            SafeToSpend {
                left_cents: 23000,
                budgeted_cents: 70000,
                spent_cents: 47000,
                excluded: 2
            }
        );
        // A bill's category that isn't in the list still counts by id.
        let s = safe_to_spend(&[budget("gone", 100, 0)], &cats(), &[bill(Some("gone"))]);
        assert_eq!(s.excluded, 1);
    }

    #[test]
    fn ranks_budgets_by_share_spent() {
        let mut weekly = budget("w", 40000, 1000);
        weekly.period = Some(crate::budgets::BudgetPeriod::Weekly);
        weekly.period_amount_cents = Some(10000);
        weekly.period_spent_cents = Some(9000);
        let r = ranked_budgets(&[
            budget("a", 100, 50),
            budget("z", 0, 50),
            budget("b", 100, 120),
            weekly,
            budget("c", 100, 10),
        ]);
        let ids: Vec<&str> = r.iter().map(|(b, _)| b.category_id.as_str()).collect();
        assert_eq!(ids, ["b", "w", "a"]);
        assert!(r[1].1.weekly);
    }

    fn goal(name: &str, saved: i64, target: i64) -> Goal {
        serde_json::from_value(serde_json::json!({
            "id": name, "name": name, "targetCents": target, "savedCents": saved, "monthlyCents": 0,
            "linkedAccountId": null, "targetDate": null, "color": "#000", "note": null,
            "projectedCompletion": null
        }))
        .unwrap()
    }

    #[test]
    fn puts_unfinished_goals_first_closest_first() {
        let g = top_goals(&[
            goal("done", 500, 500),
            goal("half", 50, 100),
            goal("little", 10, 100),
            goal("most", 90, 100),
        ]);
        let names: Vec<&str> = g.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, ["most", "half", "little"]);
    }

    #[test]
    fn writes_the_goal_plan_line() {
        let whole = |c: i64| format!("${}", c / 100);
        let my = |m: &str| format!("<{m}>");
        let mut g = goal("Trip", 2500, 10000);
        assert_eq!(goal_plan_line(&g, goal_progress(&g), whole, my), "25%");
        g.monthly_cents = 50000;
        g.projected_completion = Some("2027-04".into());
        assert_eq!(
            goal_plan_line(&g, 0.25, whole, my),
            "25% · $500 a month · on track for <2027-04>"
        );
        g.target_date = Some("2027-09-01".into());
        assert_eq!(
            goal_plan_line(&g, 0.25, whole, my),
            "25% · $500 a month · target <2027-09>"
        );
        assert_eq!(goal_plan_line(&g, 1.0, whole, my), "Funded");
        assert_eq!(goal_progress(&goal("x", 5, 0)), 0.0);
    }

    #[test]
    fn summarises_a_trend() {
        let t = trend_summary(&[10000, 12000, 15000]);
        assert_eq!((t.current, t.delta), (15000, 5000));
        assert_eq!(t.pct.as_deref(), Some(" (+50%)"));
        assert_eq!(
            trend_summary(&[10000, 5000]).pct.as_deref(),
            Some(" (-50%)")
        );
        // From (almost) nothing, or absurd: no percentage.
        assert_eq!(trend_summary(&[50, 5000]).pct, None);
        assert_eq!(trend_summary(&[100, 100000]).pct, None);
        assert_eq!(trend_summary(&[]).current, 0);
        assert_eq!(gain_pct_label(11230, 10000), "(+12.3%)");
        assert_eq!(gain_pct_label(9000, 10000), "(-10.0%)");
        assert_eq!(gain_pct_label(9000, 0), "(+0.0%)");
    }

    #[test]
    fn offers_only_views_with_data() {
        let v = available_views(true, false, true);
        assert_eq!(v, [SankeyView::Actual, SankeyView::Combined]);
        assert_eq!(effective_view(SankeyView::Both, &v), SankeyView::Actual);
        assert_eq!(
            effective_view(SankeyView::Combined, &v),
            SankeyView::Combined
        );
        assert_eq!(effective_view(SankeyView::Planned, &[]), SankeyView::Actual);
        assert_eq!(parse_sankey_view(Some("both")), SankeyView::Both);
        assert_eq!(parse_sankey_view(Some("junk")), SankeyView::Actual);
        assert_eq!(plan_off(120, 100, true), (20, true));
        assert_eq!(plan_off(120, 100, false), (20, false));
    }

    fn ids(l: &[ResolvedWidget]) -> Vec<&str> {
        l.iter().map(|w| w.id.as_str()).collect()
    }

    #[test]
    fn phones_lead_with_guilt_free_until_arranged() {
        let phone = home_layout(true, None);
        assert_eq!(
            ids(&phone[..4]),
            ["guilt-free", "budgets", "goals", "metric-networth"]
        );
        assert_eq!(home_layout(false, None)[0].id, "metric-networth");
        let saved: Vec<DashboardWidget> =
            serde_json::from_str(r#"[{"id":"goals"},{"id":"metric-income","hidden":true}]"#)
                .unwrap();
        let l = home_layout(true, Some(&saved));
        assert_eq!(ids(&l[..3]), ["goals", "metric-income", "metric-networth"]);
        assert_eq!(home_layout(true, Some(&[]))[0].id, "guilt-free");
    }

    #[test]
    fn a_phone_keeps_one_metric_and_drops_the_net_worth_trend() {
        let l = home_layout(false, None);
        let (desk, first) = view_items(&l, false, false);
        assert_eq!(desk.len(), l.len());
        assert_eq!(first.as_deref(), Some("metric-networth"));
        let (phone, _) = view_items(&l, true, true);
        let p = ids(&phone);
        assert!(p.contains(&"metric-networth"));
        assert!(!p.contains(&"metric-income"));
        assert!(!p.contains(&"trend-networth"));
        assert!(!p.contains(&"sankey"));
        // No metric shown: the net worth trend stays.
        let hidden = l
            .iter()
            .map(|w| {
                let mut w = w.clone();
                w.hidden = w.id.starts_with("metric-");
                w
            })
            .collect::<Vec<_>>();
        let (phone, first) = view_items(&hidden, false, true);
        assert_eq!(first, None);
        assert!(ids(&phone).contains(&"trend-networth"));
        assert_eq!(edit_items(&hidden).len(), l.len() - 4);
    }

    #[test]
    fn resizes_hides_and_commits() {
        assert_eq!(next_span(Span::Quarter), Span::Third);
        assert_eq!(next_span(Span::Full), Span::Quarter);
        assert_eq!(span_label(Span::Half), "½ width");
        let l = home_layout(false, None);
        let p = patch_widget(&l, "bills", Some(true), None);
        assert!(p.iter().find(|w| w.id == "bills").unwrap().hidden);
        let p = patch_widget(&p, "goals", None, Some(Span::Full));
        assert_eq!(p.iter().find(|w| w.id == "goals").unwrap().span, Span::Full);
        let visible: Vec<String> = edit_items(&p).iter().rev().map(|w| w.id.clone()).collect();
        let c = commit_order(&p, &visible);
        assert_eq!(c.len(), l.len());
        assert_eq!(c[0].id, "goals");
        assert_eq!(c.last().unwrap().id, "bills");
        assert_eq!(to_saved(None), vec![]);
        assert_eq!(to_saved(Some(&c)).len(), c.len());
    }

    #[test]
    fn moves_cards_like_home_arrange() {
        let o: Vec<String> = ["a", "b", "c", "d"].map(String::from).to_vec();
        assert_eq!(move_to(&o, "a", 2).unwrap(), ["b", "c", "a", "d"]);
        assert_eq!(move_to(&o, "d", 0).unwrap(), ["d", "a", "b", "c"]);
        assert_eq!(move_to(&o, "b", 1), None);
        assert_eq!(move_to(&o, "x", 1), None);
        assert_eq!(step_order(&o, "b", -1).unwrap(), ["b", "a", "c", "d"]);
        assert_eq!(step_order(&o, "a", -1), None);
        assert_eq!(step_order(&o, "d", 1), None);
        assert_eq!(arrow_step("ArrowRight"), 1);
        assert_eq!(arrow_step("Enter"), 0);
        assert_eq!(jiggle_delay(0), "0s");
        assert_eq!(jiggle_delay(1), "-0.09s");
        assert_eq!(jiggle_delay(6), "-0.18s");
    }
}
