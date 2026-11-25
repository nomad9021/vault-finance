//! Mirrors packages/shared/src/schemas/dashboard.ts (the home screen's
//! widgets, the Sankey view, layout changes from the assistant) and
//! apps/desktop/src/lib/dashboardLayout.ts (moving widgets in edit mode).

use std::collections::HashSet;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::serde_util::OrderedMap;

/// A widget's width, of 12 columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Span {
    Quarter = 3,
    Third = 4,
    Half = 6,
    TwoThirds = 8,
    Full = 12,
}

impl Span {
    pub fn cols(self) -> u8 {
        self as u8
    }
    pub fn from_cols(n: u64) -> Option<Span> {
        Some(match n {
            3 => Span::Quarter,
            4 => Span::Third,
            6 => Span::Half,
            8 => Span::TwoThirds,
            12 => Span::Full,
            _ => return None,
        })
    }
}

impl Serialize for Span {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u8(self.cols())
    }
}

impl<'de> Deserialize<'de> for Span {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let n = f64::deserialize(d)?;
        (n.fract() == 0.0 && n >= 0.0)
            .then(|| Span::from_cols(n as u64))
            .flatten()
            .ok_or_else(|| serde::de::Error::custom(format!("{n} is not a dashboard span")))
    }
}

pub struct DashboardWidgetDef {
    pub id: &'static str,
    pub label: &'static str,
    pub span: Span,
    /// One line for the assistant: what the widget shows.
    pub about: &'static str,
}

const fn w(
    id: &'static str,
    label: &'static str,
    span: Span,
    about: &'static str,
) -> DashboardWidgetDef {
    DashboardWidgetDef {
        id,
        label,
        span,
        about,
    }
}

/// Every card and section the dashboard can show, in default order.
pub const DASHBOARD_WIDGETS: &[DashboardWidgetDef] = &[
    w(
        "metric-networth",
        "Net worth (number)",
        Span::Quarter,
        "net worth figure",
    ),
    w(
        "metric-income",
        "Income this month (number)",
        Span::Quarter,
        "this month's income figure",
    ),
    w(
        "metric-spending",
        "Spending this month (number)",
        Span::Quarter,
        "this month's spending figure",
    ),
    w(
        "metric-savings",
        "Savings rate (number)",
        Span::Quarter,
        "savings rate figure",
    ),
    w(
        "guilt-free",
        "Guilt-free spending",
        Span::Full,
        "each person's weekly guilt-free money, resets every week",
    ),
    w(
        "sankey",
        "Cash-flow Sankey",
        Span::Full,
        "the cash-flow diagram (actual, planned, both, or budget vs actual)",
    ),
    w(
        "this-month",
        "This month: plan vs actual",
        Span::TwoThirds,
        "safe to spend and the month's plan vs actual",
    ),
    w("accounts", "Accounts", Span::Third, "account balances"),
    w(
        "trend-networth",
        "Net worth trend",
        Span::Third,
        "net worth chart",
    ),
    w("trend-income", "Income trend", Span::Third, "income chart"),
    w(
        "trend-spending",
        "Spending trend",
        Span::Third,
        "spending chart",
    ),
    w(
        "budgets",
        "Budgets",
        Span::Third,
        "budget left and the categories closest to their limit",
    ),
    w("bills", "Upcoming bills", Span::Third, "next bills due"),
    w("investments", "Investments", Span::Third, "portfolio value"),
    w(
        "recent",
        "Recent activity",
        Span::TwoThirds,
        "latest transactions",
    ),
    w(
        "goals",
        "Savings goals",
        Span::Third,
        "progress on savings goals",
    ),
];

pub fn is_widget_id(id: &str) -> bool {
    DASHBOARD_WIDGETS.iter().any(|w| w.id == id)
}

/// `(id, span)` of each default widget, for [`resolve_widgets`].
pub fn default_spans() -> Vec<(&'static str, Span)> {
    DASHBOARD_WIDGETS.iter().map(|w| (w.id, w.span)).collect()
}

/// Which cash-flow diagram the dashboard leads with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SankeyView {
    #[default]
    Actual,
    Planned,
    Both,
    Combined,
}

impl SankeyView {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Actual => "actual",
            Self::Planned => "planned",
            Self::Both => "both",
            Self::Combined => "combined",
        }
    }
}

/// Widths as the assistant names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WidgetWidth {
    Quarter,
    Third,
    Half,
    TwoThirds,
    Full,
}

impl WidgetWidth {
    pub fn span(self) -> Span {
        match self {
            Self::Quarter => Span::Quarter,
            Self::Third => Span::Third,
            Self::Half => Span::Half,
            Self::TwoThirds => Span::TwoThirds,
            Self::Full => Span::Full,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quarter => "quarter",
            Self::Third => "third",
            Self::Half => "half",
            Self::TwoThirds => "two-thirds",
            Self::Full => "full",
        }
    }
}

/// `DashboardWidget` (user.ts): one saved card. `hidden` defaults to false.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardWidget {
    pub id: String,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedWidget {
    pub id: String,
    pub hidden: bool,
    pub span: Span,
}

impl From<&ResolvedWidget> for DashboardWidget {
    fn from(w: &ResolvedWidget) -> Self {
        DashboardWidget {
            id: w.id.clone(),
            hidden: w.hidden,
            span: Some(w.span),
        }
    }
}

/// A saved layout over the defaults: saved widgets in their order (unknown
/// ids dropped, repeats ignored), then any widget never arranged, in default
/// order. Spans fall back to the widget's default.
pub fn resolve_widgets(
    defaults: &[(&str, Span)],
    saved: Option<&[DashboardWidget]>,
) -> Vec<ResolvedWidget> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for w in saved.unwrap_or_default() {
        let Some(&(_, span)) = defaults.iter().find(|(id, _)| *id == w.id) else {
            continue;
        };
        if !seen.insert(w.id.as_str()) {
            continue;
        }
        out.push(ResolvedWidget {
            id: w.id.clone(),
            hidden: w.hidden,
            span: w.span.unwrap_or(span),
        });
    }
    for &(id, span) in defaults {
        if !seen.contains(id) {
            out.push(ResolvedWidget {
                id: id.to_string(),
                hidden: false,
                span,
            });
        }
    }
    out
}

/// A layout change, as the assistant's `set_dashboard_layout` carries it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DashboardChange {
    pub reset: bool,
    pub order: Vec<String>,
    pub show: Vec<String>,
    pub hide: Vec<String>,
    pub widths: OrderedMap<WidgetWidth>,
}

/// Ids in a change that aren't dashboard widgets (first-seen order, no repeats).
pub fn unknown_widget_ids(change: &DashboardChange) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let ids = change
        .order
        .iter()
        .chain(&change.show)
        .chain(&change.hide)
        .map(String::as_str)
        .chain(change.widths.keys());
    for id in ids {
        if !is_widget_id(id) && !out.iter().any(|o| o == id) {
            out.push(id.to_string());
        }
    }
    out
}

/// Apply a change to a saved layout. `order` puts the named widgets first,
/// in that order; the rest keep their order after them.
pub fn apply_dashboard_change(
    saved: Option<&[DashboardWidget]>,
    change: &DashboardChange,
) -> Vec<ResolvedWidget> {
    let base = if change.reset { Some(&[][..]) } else { saved };
    let mut layout = resolve_widgets(&default_spans(), base);
    if !change.order.is_empty() {
        let mut first: Vec<ResolvedWidget> = Vec::new();
        for id in &change.order {
            if first.iter().any(|w| &w.id == id) {
                continue;
            }
            if let Some(w) = layout.iter().find(|w| &w.id == id) {
                first.push(w.clone());
            }
        }
        let rest: Vec<ResolvedWidget> = layout
            .into_iter()
            .filter(|w| !first.iter().any(|f| f.id == w.id))
            .collect();
        first.extend(rest);
        layout = first;
    }
    layout
        .into_iter()
        .map(|mut w| {
            if change.show.contains(&w.id) {
                w.hidden = false;
            } else if change.hide.contains(&w.id) {
                w.hidden = true;
            }
            if let Some(width) = change.widths.get(&w.id) {
                w.span = width.span();
            }
            w
        })
        .collect()
}

// ── apps/desktop/src/lib/dashboardLayout.ts ──

/// The width menu in edit mode.
pub const SPANS: &[(Span, &str)] = &[
    (Span::Quarter, "¼ width"),
    (Span::Third, "⅓ width"),
    (Span::Half, "½ width"),
    (Span::TwoThirds, "⅔ width"),
    (Span::Full, "Full width"),
];

/// `resolveLayout`: the desktop's name for [`resolve_widgets`].
pub fn resolve_layout(
    defaults: &[(&str, Span)],
    saved: Option<&[DashboardWidget]>,
) -> Vec<ResolvedWidget> {
    resolve_widgets(defaults, saved)
}

/// Move one widget up (`by = -1`) or down (`1`) by one place. `None` when
/// it can't move (the JS returns the same array).
pub fn move_widget(layout: &[ResolvedWidget], id: &str, by: i32) -> Option<Vec<ResolvedWidget>> {
    let i = layout.iter().position(|w| w.id == id)?;
    let j = i as i64 + by as i64;
    if j < 0 || j >= layout.len() as i64 {
        return None;
    }
    let mut next = layout.to_vec();
    next.swap(i, j as usize);
    Some(next)
}

/// Drag and drop: put `id` where `before_id` is. `None` when nothing moves.
pub fn place_widget(
    layout: &[ResolvedWidget],
    id: &str,
    before_id: &str,
) -> Option<Vec<ResolvedWidget>> {
    if id == before_id {
        return None;
    }
    let item = layout.iter().find(|w| w.id == id)?.clone();
    let mut rest: Vec<ResolvedWidget> = layout.iter().filter(|w| w.id != id).cloned().collect();
    let at = rest.iter().position(|w| w.id == before_id)?;
    rest.insert(at, item);
    Some(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(json: &str) -> Vec<DashboardWidget> {
        serde_json::from_str(json).unwrap()
    }
    fn ids(l: &[ResolvedWidget]) -> Vec<&str> {
        l.iter().map(|w| w.id.as_str()).collect()
    }
    fn rw(id: &str, hidden: bool, span: Span) -> ResolvedWidget {
        ResolvedWidget {
            id: id.into(),
            hidden,
            span,
        }
    }

    // apps/desktop/src/lib/dashboardLayout.test.ts
    const DEFAULTS: &[(&str, Span)] =
        &[("a", Span::Quarter), ("b", Span::Full), ("c", Span::Third)];

    #[test]
    fn uses_the_defaults_when_nothing_is_saved() {
        assert_eq!(
            resolve_layout(DEFAULTS, None),
            vec![
                rw("a", false, Span::Quarter),
                rw("b", false, Span::Full),
                rw("c", false, Span::Third)
            ]
        );
    }

    #[test]
    fn keeps_the_saved_order_drops_unknown_widgets_and_appends_new_ones() {
        let s = saved(
            r#"[{"id":"c","hidden":true,"span":6},{"id":"gone","hidden":false},{"id":"a","hidden":false}]"#,
        );
        assert_eq!(
            resolve_layout(DEFAULTS, Some(&s)),
            vec![
                rw("c", true, Span::Half),
                rw("a", false, Span::Quarter),
                rw("b", false, Span::Full)
            ]
        );
    }

    #[test]
    fn moves_and_drops_widgets() {
        let l = resolve_layout(DEFAULTS, None);
        assert_eq!(ids(&move_widget(&l, "b", -1).unwrap()), ["b", "a", "c"]);
        assert_eq!(move_widget(&l, "a", -1), None);
        assert_eq!(move_widget(&l, "c", 1), None);
        assert_eq!(move_widget(&l, "nope", 1), None);
        assert_eq!(ids(&place_widget(&l, "c", "a").unwrap()), ["c", "a", "b"]);
        assert_eq!(place_widget(&l, "a", "a"), None);
        assert_eq!(place_widget(&l, "a", "gone"), None);
    }

    // packages/shared/src/dashboard.test.ts
    #[test]
    fn puts_the_named_widgets_first_and_keeps_the_rest_in_order() {
        let mut widths = OrderedMap::default();
        widths.insert("bills".into(), WidgetWidth::Half);
        let change = DashboardChange {
            order: vec!["guilt-free".into(), "bills".into()],
            hide: vec!["investments".into()],
            widths,
            ..Default::default()
        };
        let out = apply_dashboard_change(None, &change);
        assert_eq!(ids(&out[..2]), ["guilt-free", "bills"]);
        let rest: Vec<&str> = DASHBOARD_WIDGETS
            .iter()
            .map(|w| w.id)
            .filter(|id| *id != "guilt-free" && *id != "bills")
            .collect();
        assert_eq!(ids(&out[2..]), rest);
        assert!(out.iter().find(|w| w.id == "investments").unwrap().hidden);
        assert_eq!(out.iter().find(|w| w.id == "bills").unwrap().span.cols(), 6);
    }

    #[test]
    fn builds_on_the_saved_layout_or_resets_it() {
        let s = saved(r#"[{"id":"goals","hidden":true},{"id":"sankey"}]"#);
        let show = DashboardChange {
            show: vec!["goals".into()],
            ..Default::default()
        };
        assert_eq!(
            apply_dashboard_change(Some(&s), &show)[0],
            rw("goals", false, Span::Third)
        );
        let reset = DashboardChange {
            reset: true,
            ..Default::default()
        };
        assert_eq!(
            apply_dashboard_change(Some(&s), &reset)[0].id,
            DASHBOARD_WIDGETS[0].id
        );
    }

    #[test]
    fn flags_ids_that_arent_widgets() {
        let change = DashboardChange {
            order: vec!["sankey".into(), "weather".into()],
            hide: vec!["clock".into()],
            ..Default::default()
        };
        assert_eq!(unknown_widget_ids(&change), ["weather", "clock"]);
    }

    #[test]
    fn spans_and_views_on_the_wire() {
        assert!(serde_json::from_str::<DashboardWidget>(r#"{"id":"x","span":5}"#).is_err());
        let w: DashboardWidget = serde_json::from_str(r#"{"id":"x","span":8}"#).unwrap();
        assert_eq!(w.span, Some(Span::TwoThirds));
        assert!(!w.hidden);
        assert_eq!(
            serde_json::to_string(&DashboardWidget::from(&rw("bills", true, Span::Half))).unwrap(),
            r#"{"id":"bills","hidden":true,"span":6}"#
        );
        assert_eq!(
            serde_json::from_str::<WidgetWidth>(r#""two-thirds""#).unwrap(),
            WidgetWidth::TwoThirds
        );
        assert_eq!(
            serde_json::from_str::<SankeyView>(r#""combined""#).unwrap(),
            SankeyView::Combined
        );
        assert_eq!(SPANS.len(), 5);
    }
}
