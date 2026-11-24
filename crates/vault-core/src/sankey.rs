//! The cash-flow Sankey: the wire types from packages/shared/src/schemas/cashflow.ts
//! (`SankeyNode`, `SankeyLink`, `SankeyResponse`, with SankeyCard's extra
//! display fields) and the pure layout maths of packages/ui/src/charts/Sankey.tsx.
//!
//! Columns come from each node's `depth`; bar heights are value-proportional
//! with one global scale; deeper columns are ordered by the barycenter of
//! their parents; the person's own drag order overrides that per column.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::money::to_fixed;

// ── Wire types ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SankeyNodeKind {
    Income,
    Hub,
    Category,
    Saved,
}

/// Which part of the app owns a node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SankeySection {
    Income,
    Spending,
    Bills,
    Debt,
    Savings,
    Giving,
    Saved,
    /// Estimated taxes and pre-tax savings before income.
    Taxes,
}

impl SankeySection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Income => "income",
            Self::Spending => "spending",
            Self::Bills => "bills",
            Self::Debt => "debt",
            Self::Savings => "savings",
            Self::Giving => "giving",
            Self::Saved => "saved",
            Self::Taxes => "taxes",
        }
    }
}

/// A node's budget and actual, for the budget-vs-actual diagram.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SankeyComparison {
    pub budgeted_cents: i64,
    pub actual_cents: i64,
}

/// `SankeyNode` from the server, plus the display-only fields of
/// `SankeyCardNode` (`caption`, `comparison`, `note`), which the diagrams
/// built on the client (budget_sankey) fill in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SankeyNode {
    /// "income:<uuid>", "income:other", "hub", "cat:<uuid>", or "saved".
    pub id: String,
    pub label: String,
    pub value_cents: i64,
    pub color: String,
    /// Column index: income=0, hub=1, top categories=2, subcategories 3+.
    pub depth: u32,
    pub kind: SankeyNodeKind,
    pub category_id: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub section: Option<SankeySection>,
    #[serde(default)]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub editable_monthly_cents: Option<i64>,
    /// Replaces the usual "amount (share)" line under the label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    /// Shows the amounts side by side in the drill-in panel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comparison: Option<SankeyComparison>,
    /// Explains a total that has no transactions of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl SankeyNode {
    /// A node with only the required fields set.
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        value_cents: i64,
        color: impl Into<String>,
        depth: u32,
        kind: SankeyNodeKind,
    ) -> Self {
        SankeyNode {
            id: id.into(),
            label: label.into(),
            value_cents,
            color: color.into(),
            depth,
            kind,
            category_id: None,
            account_id: None,
            section: None,
            entity_id: None,
            editable_monthly_cents: None,
            caption: None,
            comparison: None,
            note: None,
        }
    }
}

/// `SankeyLink`, plus `SankeyCardLink`'s optional flat ribbon colour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SankeyLink {
    pub from: String,
    pub to: String,
    pub value_cents: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl SankeyLink {
    pub fn new(from: impl Into<String>, to: impl Into<String>, value_cents: i64) -> Self {
        SankeyLink {
            from: from.into(),
            to: to.into(),
            value_cents,
            color: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SankeyResponse {
    pub month: String,
    pub nodes: Vec<SankeyNode>,
    pub links: Vec<SankeyLink>,
    pub total_income_cents: i64,
    pub total_spending_cents: i64,
}

/// Nodes and links of one diagram.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SankeyGraph {
    pub nodes: Vec<SankeyNode>,
    pub links: Vec<SankeyLink>,
}

impl From<SankeyResponse> for SankeyGraph {
    fn from(r: SankeyResponse) -> Self {
        SankeyGraph {
            nodes: r.nodes,
            links: r.links,
        }
    }
}

// ── Layout (Sankey.tsx) ──

pub const BASE_H: f64 = 600.0;
pub const W: f64 = 1240.0;
/// Bar width.
pub const NW: f64 = 6.0;
const PAD: f64 = 40.0;
/// x of the leftmost (depth 0) column bar.
const X0: f64 = 64.0;
/// x of the rightmost column bar (labels sit to its left).
const X1: f64 = 1176.0;
/// Vertical gap between node slots.
const GAP: f64 = 14.0;
/// Min bar height (thin sliver for tiny/$0 nodes).
const MIN_NODE: f64 = 4.0;
/// Min slot height so a two-line label always fits without overlap.
const ROW_MIN: f64 = 34.0;
/// Hairline connector for $0 links so empty categories stay attached.
const MIN_LINK: f64 = 2.0;

/// `SankeyNodeDatum`: what the chart draws for a node.
#[derive(Debug, Clone, PartialEq)]
pub struct Datum {
    pub id: String,
    pub label: String,
    pub value: f64,
    pub color: String,
    pub depth: u32,
    pub kind: SankeyNodeKind,
    pub caption: Option<String>,
}

impl From<&SankeyNode> for Datum {
    fn from(n: &SankeyNode) -> Self {
        Datum {
            id: n.id.clone(),
            label: n.label.clone(),
            value: n.value_cents as f64,
            color: n.color.clone(),
            depth: n.depth,
            kind: n.kind,
            caption: n.caption.clone().filter(|c| !c.is_empty()),
        }
    }
}

/// `SankeyLinkDatum`.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkDatum {
    pub from: String,
    pub to: String,
    pub value: f64,
    pub color: Option<String>,
}

impl From<&SankeyLink> for LinkDatum {
    fn from(l: &SankeyLink) -> Self {
        LinkDatum {
            from: l.from.clone(),
            to: l.to.clone(),
            value: l.value_cents as f64,
            color: l.color.clone().filter(|c| !c.is_empty()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlacedNode {
    pub datum: Datum,
    pub x: f64,
    pub y: f64,
    pub h: f64,
}

impl PlacedNode {
    pub fn center(&self) -> f64 {
        self.y + self.h / 2.0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlacedLink {
    pub from: String,
    pub to: String,
    pub sx: f64,
    pub sy: f64,
    pub tx: f64,
    pub ty: f64,
    /// Thickness.
    pub t: f64,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    /// In draw order: columns left to right, each top to bottom.
    pub nodes: Vec<PlacedNode>,
    pub links: Vec<PlacedLink>,
    pub max_depth: u32,
    /// The viewBox height: grows to fit the tallest column.
    pub height: f64,
}

impl Layout {
    pub fn node(&self, id: &str) -> Option<&PlacedNode> {
        self.nodes.iter().find(|n| n.datum.id == id)
    }
}

/// `rgba(hex, alpha)`: "#rrggbb" to `rgba(r, g, b, a)`; anything else as is.
pub fn rgba(hex: &str, alpha: f64) -> String {
    let h = hex.trim();
    let h = h.strip_prefix('#').unwrap_or(h);
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return hex.to_string();
    }
    let n = u32::from_str_radix(h, 16).unwrap_or(0);
    format!(
        "rgba({}, {}, {}, {alpha})",
        (n >> 16) & 255,
        (n >> 8) & 255,
        n & 255
    )
}

/// The ribbon between two bars, as an SVG path.
pub fn link_path(l: &PlacedLink) -> String {
    let mx = (l.sx + l.tx) / 2.0;
    format!(
        "M{},{} C{mx},{} {mx},{} {},{} L{},{} C{mx},{} {mx},{} {},{} Z",
        l.sx,
        l.sy,
        l.sy,
        l.ty,
        l.tx,
        l.ty,
        l.tx,
        l.ty + l.t,
        l.ty + l.t,
        l.sy + l.t,
        l.sx,
        l.sy + l.t,
    )
}

/// Put the nodes listed in `order` into the slots they already take in the
/// column, in `order`'s sequence; unlisted nodes stay put.
fn apply_order<'a>(ns: Vec<&'a Datum>, order: &[String]) -> Vec<&'a Datum> {
    if order.is_empty() {
        return ns;
    }
    // `new Map(order.map((id, i) => [id, i]))`: a repeated id keeps its last index.
    let rank: HashMap<&str, usize> = order
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let mut listed: Vec<&Datum> = ns
        .iter()
        .copied()
        .filter(|n| rank.contains_key(n.id.as_str()))
        .collect();
    if listed.len() < 2 {
        return ns;
    }
    listed.sort_by_key(|n| rank[n.id.as_str()]);
    let mut k = 0;
    ns.into_iter()
        .map(|n| {
            if rank.contains_key(n.id.as_str()) {
                k += 1;
                listed[k - 1]
            } else {
                n
            }
        })
        .collect()
}

/// `order` with one column's ids moved to the end in their new sequence
/// (capped at the 300 the preferences schema allows).
pub fn merge_column_order(order: &[String], column: &[String]) -> Vec<String> {
    let in_column: HashSet<&str> = column.iter().map(String::as_str).collect();
    let mut out: Vec<String> = order
        .iter()
        .filter(|id| !in_column.contains(id.as_str()))
        .cloned()
        .chain(column.iter().cloned())
        .collect();
    if out.len() > 300 {
        out.drain(..out.len() - 300);
    }
    out
}

fn by_f64(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

pub fn layout(nodes: &[Datum], links: &[LinkDatum], order: &[String]) -> Layout {
    let mut depths: Vec<u32> = nodes.iter().map(|n| n.depth).collect();
    depths.sort_unstable();
    depths.dedup();
    let max_depth = depths.last().copied().unwrap_or(0);
    let x_for = |d: u32| {
        if max_depth == 0 {
            X0
        } else {
            X0 + (d as f64 * (X1 - X0)) / max_depth as f64
        }
    };

    // A node's drawn magnitude is the largest of its value and its total in/out
    // flow, so a bar never renders shorter than the flows attached to it.
    let mut sum_in: HashMap<&str, f64> = HashMap::new();
    let mut sum_out: HashMap<&str, f64> = HashMap::new();
    for l in links {
        *sum_out.entry(l.from.as_str()).or_default() += l.value;
        *sum_in.entry(l.to.as_str()).or_default() += l.value;
    }
    let magnitude = |n: &Datum| {
        let i = sum_in.get(n.id.as_str()).copied().unwrap_or(0.0);
        let o = sum_out.get(n.id.as_str()).copied().unwrap_or(0.0);
        n.value.max(i).max(o)
    };

    let by_depth = |d: u32| nodes.iter().filter(move |n| n.depth == d);

    let mut max_col_sum: f64 = 1.0;
    for &d in &depths {
        max_col_sum = max_col_sum.max(by_depth(d).map(magnitude).sum());
    }
    let scale = (BASE_H - 2.0 * PAD) / max_col_sum;

    // Each node occupies a slot at least ROW_MIN tall so its two-line label
    // always has room; the bar is centered inside that slot.
    let bar_height = |n: &Datum| MIN_NODE.max(magnitude(n) * scale);
    let slot_height = |n: &Datum| ROW_MIN.max(bar_height(n));
    let column_height = |ns: &[&Datum]| {
        ns.iter().map(|n| slot_height(n)).sum::<f64>() + ns.len().saturating_sub(1) as f64 * GAP
    };
    let mut content_h: f64 = 0.0;
    for &d in &depths {
        content_h = content_h.max(column_height(&by_depth(d).collect::<Vec<_>>()));
    }
    let height = BASE_H.max((content_h + 2.0 * PAD).ceil());

    let mut parents_of: HashMap<&str, Vec<&str>> = HashMap::new();
    for l in links {
        parents_of
            .entry(l.to.as_str())
            .or_default()
            .push(l.from.as_str());
    }

    // A Map keyed by id: a repeated id replaces the value but keeps its place.
    let mut placed: Vec<PlacedNode> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for &d in &depths {
        let mut ns: Vec<&Datum> = by_depth(d).collect();
        // Leftmost column by value; deeper columns by the average centre of
        // their already-placed parents (barycenter) to reduce crossings.
        if d == depths[0] {
            ns.sort_by(|a, b| by_f64(magnitude(b), magnitude(a)));
        } else {
            let bary = |n: &Datum| {
                let ps: Vec<&PlacedNode> = parents_of
                    .get(n.id.as_str())
                    .map(|v| {
                        v.iter()
                            .filter_map(|id| index.get(*id).map(|&i| &placed[i]))
                            .collect()
                    })
                    .unwrap_or_default();
                if ps.is_empty() {
                    return 9_007_199_254_740_991.0;
                }
                ps.iter().map(|p| p.center()).sum::<f64>() / ps.len() as f64
            };
            let keyed: Vec<(f64, &Datum)> = ns.iter().map(|n| (bary(n), *n)).collect();
            let mut keyed = keyed;
            keyed.sort_by(|a, b| by_f64(a.0, b.0));
            ns = keyed.into_iter().map(|(_, n)| n).collect();
        }
        let ns = apply_order(ns, order);

        let total_h = column_height(&ns);
        let mut y = (height - total_h) / 2.0;
        for n in ns {
            let slot = slot_height(n);
            let h = bar_height(n);
            let p = PlacedNode {
                datum: n.clone(),
                x: x_for(d),
                y: y + (slot - h) / 2.0,
                h,
            };
            match index.get(&n.id) {
                Some(&i) => placed[i] = p,
                None => {
                    index.insert(n.id.clone(), placed.len());
                    placed.push(p);
                }
            }
            y += slot + GAP;
        }
    }

    // Route links: each source stacks its outgoing flows by target position,
    // each target its incoming flows by source position.
    let y_of = |id: &str| index.get(id).map(|&i| placed[i].y).unwrap_or(0.0);
    let mut ordered: Vec<&LinkDatum> = links.iter().collect();
    ordered.sort_by(|a, b| {
        by_f64(y_of(&a.from), y_of(&b.from)).then(by_f64(y_of(&a.to), y_of(&b.to)))
    });
    let mut out_cursor: HashMap<&str, f64> = HashMap::new();
    let mut in_cursor: HashMap<&str, f64> = HashMap::new();
    let mut placed_links = Vec::new();
    for l in ordered {
        let (Some(&si), Some(&ti)) = (index.get(&l.from), index.get(&l.to)) else {
            continue;
        };
        let (s, t) = (&placed[si], &placed[ti]);
        let h = if l.value > 0.0 {
            l.value * scale
        } else {
            MIN_LINK
        };
        let sy = out_cursor.get(l.from.as_str()).copied().unwrap_or(s.y);
        let ty = in_cursor.get(l.to.as_str()).copied().unwrap_or(t.y);
        placed_links.push(PlacedLink {
            from: l.from.clone(),
            to: l.to.clone(),
            sx: s.x + NW,
            sy,
            tx: t.x,
            ty,
            t: h,
            color: l.color.clone(),
        });
        out_cursor.insert(l.from.as_str(), sy + h);
        in_cursor.insert(l.to.as_str(), ty + h);
    }

    Layout {
        nodes: placed,
        links: placed_links,
        max_depth,
        height,
    }
}

/// What percentages are shares of: total income (the hub = 100%), or the
/// summed income sources when there's no hub.
pub fn root_total(nodes: &[Datum]) -> f64 {
    let income_sum: f64 = nodes.iter().filter(|n| n.depth == 0).map(|n| n.value).sum();
    if let Some(hub) = nodes.iter().find(|n| n.kind == SankeyNodeKind::Hub) {
        // A gross-pay column in front of the hub is the real 100%.
        if hub.value > 0.0 {
            return hub.value.max(income_sum);
        }
    }
    if income_sum > 0.0 {
        income_sum
    } else {
        nodes.iter().fold(0.0, |m, n| m.max(n.value))
    }
}

/// The caption under a node's label: its own, or "amount (share%)".
pub fn caption(n: &Datum, root_total: f64, format: impl Fn(f64) -> String) -> String {
    if let Some(c) = &n.caption {
        return c.clone();
    }
    if root_total > 0.0 {
        let pct = n.value / root_total * 100.0;
        format!("{} ({}%)", format(n.value), to_fixed(pct, 1))
    } else {
        format(n.value)
    }
}

/// A flow is tinted by (and focuses) the deeper of its two endpoints.
pub fn flow_key<'a>(from: &'a str, to: &'a str, depth_of: &HashMap<String, u32>) -> &'a str {
    let d = |id: &str| depth_of.get(id).copied().unwrap_or(0);
    if d(to) >= d(from) {
        to
    } else {
        from
    }
}

/// Every node's directly linked nodes.
pub fn neighbors(links: &[LinkDatum]) -> HashMap<String, HashSet<String>> {
    let mut map: HashMap<String, HashSet<String>> = HashMap::new();
    for l in links {
        map.entry(l.from.clone()).or_default().insert(l.to.clone());
        map.entry(l.to.clone()).or_default().insert(l.from.clone());
    }
    map
}

/// The column order while `id` is dragged so its centre sits at `want`:
/// the node goes after every other node in its column whose centre is above.
/// `None` when that's the order the layout already has.
pub fn drag_column(geo: &Layout, id: &str, want: f64) -> Option<Vec<String>> {
    let me = geo.node(id)?;
    let column: Vec<&PlacedNode> = geo
        .nodes
        .iter()
        .filter(|n| n.datum.depth == me.datum.depth)
        .collect();
    let others: Vec<&PlacedNode> = column
        .iter()
        .copied()
        .filter(|n| n.datum.id != id)
        .collect();
    let at = others.iter().filter(|n| n.center() < want).count();
    let mut ids: Vec<String> = others.iter().map(|n| n.datum.id.clone()).collect();
    ids.insert(at, id.to_string());
    let current: Vec<&str> = column.iter().map(|n| n.datum.id.as_str()).collect();
    (ids.iter().map(String::as_str).ne(current.iter().copied())).then_some(ids)
}

/// The ids in `id`'s column, top to bottom.
pub fn column_ids(geo: &Layout, id: &str) -> Vec<String> {
    let Some(me) = geo.node(id) else {
        return Vec::new();
    };
    geo.nodes
        .iter()
        .filter(|n| n.datum.depth == me.datum.depth)
        .map(|n| n.datum.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(id: &str, value: f64, depth: u32, kind: SankeyNodeKind) -> Datum {
        Datum {
            id: id.into(),
            label: id.into(),
            value,
            color: "#888888".into(),
            depth,
            kind,
            caption: None,
        }
    }
    fn l(from: &str, to: &str, value: f64) -> LinkDatum {
        LinkDatum {
            from: from.into(),
            to: to.into(),
            value,
            color: None,
        }
    }
    use SankeyNodeKind::*;

    fn sample() -> (Vec<Datum>, Vec<LinkDatum>) {
        (
            vec![
                d("inc:a", 300.0, 0, Income),
                d("inc:b", 700.0, 0, Income),
                d("hub", 1000.0, 1, Hub),
                d("cat:x", 200.0, 2, Category),
                d("cat:y", 500.0, 2, Category),
                d("saved", 300.0, 2, Saved),
            ],
            vec![
                l("inc:a", "hub", 300.0),
                l("inc:b", "hub", 700.0),
                l("hub", "cat:x", 200.0),
                l("hub", "cat:y", 500.0),
                l("hub", "saved", 300.0),
            ],
        )
    }

    #[test]
    fn lays_out_columns_by_depth_and_value() {
        let (n, ls) = sample();
        let g = layout(&n, &ls, &[]);
        assert_eq!(g.max_depth, 2);
        // The category column: 104 + 260 + 156 tall bars, two gaps, padding.
        assert_eq!(g.height, 628.0);
        let ids: Vec<&str> = g.nodes.iter().map(|n| n.datum.id.as_str()).collect();
        // Leftmost column by value, largest first.
        assert_eq!(&ids[..2], ["inc:b", "inc:a"]);
        let hub = g.node("hub").unwrap();
        assert_eq!(hub.x, 620.0);
        assert_eq!(g.node("inc:a").unwrap().x, 64.0);
        assert_eq!(g.node("saved").unwrap().x, 1176.0);
        // One global scale: the hub carries 1000 over 520 units.
        assert!((hub.h - 520.0).abs() < 1e-9);
        assert!((hub.y - 54.0).abs() < 1e-9);
    }

    #[test]
    fn stacks_flows_without_gaps_and_keeps_money() {
        let (n, ls) = sample();
        let g = layout(&n, &ls, &[]);
        let hub = g.node("hub").unwrap();
        let mut outs: Vec<&PlacedLink> = g.links.iter().filter(|l| l.from == "hub").collect();
        outs.sort_by(|a, b| a.sy.partial_cmp(&b.sy).unwrap());
        let mut y = hub.y;
        for o in &outs {
            assert!((o.sy - y).abs() < 1e-9);
            y += o.t;
        }
        assert!((y - (hub.y + hub.h)).abs() < 1e-9);
        // Out of the hub in target order.
        let targets: Vec<f64> = outs.iter().map(|o| g.node(&o.to).unwrap().y).collect();
        assert!(targets.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn grows_to_fit_a_tall_column_and_keeps_tiny_nodes_visible() {
        let mut n = vec![d("hub", 100.0, 0, Hub)];
        let mut ls = vec![];
        for i in 0..30 {
            n.push(d(&format!("c{i}"), 0.0, 1, Category));
            ls.push(l("hub", &format!("c{i}"), 0.0));
        }
        let g = layout(&n, &ls, &[]);
        // 30 slots of 34 + 29 gaps of 14 + padding.
        assert_eq!(g.height, (30.0 * 34.0 + 29.0 * 14.0 + 80.0_f64).ceil());
        assert!(g.nodes.iter().skip(1).all(|n| n.h == 4.0));
        assert!(g.links.iter().all(|l| l.t == 2.0));
    }

    #[test]
    fn a_bar_is_never_shorter_than_its_flows() {
        let n = vec![d("a", 10.0, 0, Income), d("b", 0.0, 1, Category)];
        let g = layout(&n, &[l("a", "b", 10.0)], &[]);
        assert_eq!(g.node("a").unwrap().h, g.node("b").unwrap().h);
    }

    #[test]
    fn orders_deeper_columns_by_their_parents() {
        let n = vec![
            d("big", 900.0, 0, Income),
            d("small", 100.0, 0, Income),
            d("from-small", 100.0, 1, Category),
            d("from-big", 900.0, 1, Category),
            d("orphan", 50.0, 1, Category),
        ];
        let ls = vec![l("small", "from-small", 100.0), l("big", "from-big", 900.0)];
        let g = layout(&n, &ls, &[]);
        let col: Vec<&str> = g
            .nodes
            .iter()
            .filter(|n| n.datum.depth == 1)
            .map(|n| n.datum.id.as_str())
            .collect();
        assert_eq!(col, ["from-big", "from-small", "orphan"]);
    }

    #[test]
    fn the_saved_order_rearranges_only_the_listed_nodes() {
        let (n, ls) = sample();
        let auto = layout(&n, &ls, &[]);
        let col = |g: &Layout| -> Vec<String> {
            g.nodes
                .iter()
                .filter(|n| n.datum.depth == 2)
                .map(|n| n.datum.id.clone())
                .collect()
        };
        assert_eq!(col(&auto), ["cat:x", "cat:y", "saved"]);
        let order = vec!["saved".to_string(), "cat:x".to_string()];
        let g = layout(&n, &ls, &order);
        // saved and cat:x swap their slots; cat:y stays in the middle.
        assert_eq!(col(&g), ["saved", "cat:y", "cat:x"]);
        // One listed node alone changes nothing.
        let g = layout(&n, &ls, &["saved".to_string()]);
        assert_eq!(col(&g), col(&auto));
    }

    #[test]
    fn merges_a_column_into_the_saved_order() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            merge_column_order(&s(&["a", "b", "c"]), &s(&["c", "a"])),
            s(&["b", "c", "a"])
        );
        let long: Vec<String> = (0..300).map(|i| i.to_string()).collect();
        let merged = merge_column_order(&long, &s(&["new"]));
        assert_eq!(merged.len(), 300);
        assert_eq!(merged[0], "1");
        assert_eq!(merged[299], "new");
    }

    #[test]
    fn dragging_reorders_the_column() {
        let (n, ls) = sample();
        let g = layout(&n, &ls, &[]);
        let y = g.node("cat:y").unwrap().center();
        let saved = g.node("saved").unwrap().center();
        // Drag cat:x to just below cat:y.
        assert_eq!(
            drag_column(&g, "cat:x", y + 1.0),
            Some(vec!["cat:y".into(), "cat:x".into(), "saved".into()])
        );
        // Past the bottom.
        assert_eq!(
            drag_column(&g, "cat:x", saved + 1.0),
            Some(vec!["cat:y".into(), "saved".into(), "cat:x".into()])
        );
        // Where it already is.
        assert_eq!(drag_column(&g, "cat:x", 0.0), None);
        assert_eq!(column_ids(&g, "hub"), ["hub"]);
    }

    #[test]
    fn colours_paths_and_captions() {
        assert_eq!(rgba("#3ecf8e", 0.55), "rgba(62, 207, 142, 0.55)");
        assert_eq!(rgba(" 3ECF8E ", 0.55), "rgba(62, 207, 142, 0.55)");
        assert_eq!(rgba("var(--x)", 0.55), "var(--x)");
        let p = PlacedLink {
            from: "a".into(),
            to: "b".into(),
            sx: 70.0,
            sy: 40.0,
            tx: 620.0,
            ty: 50.5,
            t: 10.0,
            color: None,
        };
        assert_eq!(
            link_path(&p),
            "M70,40 C345,40 345,50.5 620,50.5 L620,60.5 C345,60.5 345,50 70,50 Z"
        );

        let (n, _) = sample();
        assert_eq!(root_total(&n), 1000.0);
        let fmt = |v: f64| format!("${}", v / 100.0);
        assert_eq!(caption(&n[3], 1000.0, fmt), "$2 (20.0%)");
        assert_eq!(caption(&n[3], 0.0, fmt), "$2");
        let mut c = n[3].clone();
        c.caption = Some("custom".into());
        assert_eq!(caption(&c, 1000.0, fmt), "custom");

        // No hub: the income column; no income either: the largest node.
        assert_eq!(root_total(&[d("x", 5.0, 1, Category)]), 5.0);
        // Gross pay in front of the hub is the real 100%.
        assert_eq!(
            root_total(&[d("gross", 1200.0, 0, Income), d("hub", 1000.0, 1, Hub)]),
            1200.0
        );
    }

    #[test]
    fn flows_focus_their_deeper_end() {
        let depth: HashMap<String, u32> = [("hub".to_string(), 1), ("cat".to_string(), 2)].into();
        assert_eq!(flow_key("hub", "cat", &depth), "cat");
        assert_eq!(flow_key("cat", "hub", &depth), "cat");
        let nb = neighbors(&[l("a", "b", 1.0), l("b", "c", 1.0)]);
        assert!(nb["b"].contains("a") && nb["b"].contains("c"));
        assert!(!nb["a"].contains("c"));
    }

    #[test]
    fn parses_the_server_response() {
        let r: SankeyResponse = serde_json::from_str(
            r##"{"month":"2026-11","totalIncomeCents":520000,"totalSpendingCents":310000,
              "nodes":[
                {"id":"income:0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9","label":"Checking","valueCents":520000,"color":"#3ecf8e",
                 "depth":0,"kind":"income","categoryId":null,"accountId":"0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9","section":"income"},
                {"id":"hub","label":"Total income","valueCents":520000,"color":"#9397ab","depth":1,"kind":"hub","categoryId":null},
                {"id":"bill:1","label":"Rent","valueCents":180000,"color":"#ec6a9c","depth":3,"kind":"category","categoryId":null,
                 "section":"bills","entityId":"1","editableMonthlyCents":180000}],
              "links":[{"from":"income:0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9","to":"hub","valueCents":520000}]}"##,
        )
        .unwrap();
        assert_eq!(r.nodes[0].section, Some(SankeySection::Income));
        assert_eq!(r.nodes[1].section, None);
        assert_eq!(r.nodes[2].entity_id.as_deref(), Some("1"));
        assert_eq!(r.links[0].color, None);
    }
}
