//! apps/desktop/src/screens/shell/budgetSankey.ts: the budget-planner Sankey
//! (income → hub → the category tree → "Unallocated / savings"), the
//! before-income branches (taxes and deductions off gross pay), and the
//! budget-vs-actual diagram. Shared by the planner, Budget vs actual and the
//! dashboard, which draws the plan beside the actual diagram.

use std::collections::{HashMap, HashSet};

use crate::budgets::{BudgetWithSpend, PreIncome, PreIncomeKind, UnbudgetedSpending};
use crate::categories::{locale_compare, sibling_order, Category, CategoryKind};
use crate::money::js_round;
use crate::sankey::{
    SankeyComparison, SankeyGraph, SankeyLink, SankeyNode, SankeyNodeKind, SankeySection,
};
use crate::taxes::{TaxEstimate, TaxGroup};

/// `buildBudgetSankey`'s result.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetSankey {
    pub graph: SankeyGraph,
    /// Budgeted across the top-level categories.
    pub allocated: i64,
}

/// The budget-planner Sankey, with the same hierarchy as the cash-flow one:
/// each category node is weighted by its subtree's budget, a parent's own
/// budget beside its children becomes a "(direct)" child, and whatever income
/// is left goes to "Unallocated / savings".
pub fn build_budget_sankey(
    income_cents: i64,
    expense_cats: &[Category],
    budget_by_cat: &HashMap<String, i64>,
) -> BudgetSankey {
    let mut subtree: HashMap<String, i64> = HashMap::new();
    for c in expense_cats {
        compute(
            &c.id,
            &mut HashSet::new(),
            &mut subtree,
            expense_cats,
            budget_by_cat,
        );
    }
    let tree = Tree {
        cats: expense_cats,
        budget: budget_by_cat,
        subtree: &subtree,
    };

    let mut nodes: Vec<SankeyNode> = Vec::new();
    let mut links: Vec<SankeyLink> = Vec::new();
    let tops: Vec<&Category> = children_of(expense_cats, None)
        .into_iter()
        .filter(|c| tree.sub(&c.id) > 0)
        .collect();
    let allocated: i64 = tops.iter().map(|c| tree.sub(&c.id)).sum();
    nodes.push(SankeyNode::new(
        "income",
        "Planned income",
        income_cents,
        "#3ecf8e",
        0,
        SankeyNodeKind::Income,
    ));
    nodes.push(SankeyNode::new(
        "hub",
        "To allocate",
        income_cents,
        "#9397ab",
        1,
        SankeyNodeKind::Hub,
    ));
    links.push(SankeyLink::new("income", "hub", income_cents));
    for c in &tops {
        links.push(SankeyLink::new(
            "hub",
            format!("cat:{}", c.id),
            tree.sub(&c.id),
        ));
        tree.emit(c, 2, &mut nodes, &mut links);
    }
    let unallocated = (income_cents - allocated).max(0);
    if unallocated > 0 {
        nodes.push(SankeyNode::new(
            "saved",
            "Unallocated / savings",
            unallocated,
            "#43cfc0",
            2,
            SankeyNodeKind::Saved,
        ));
        links.push(SankeyLink::new("hub", "saved", unallocated));
    }
    BudgetSankey {
        graph: SankeyGraph { nodes, links },
        allocated,
    }
}

/// A category's children, in sibling order.
fn children_of<'a>(cats: &'a [Category], id: Option<&str>) -> Vec<&'a Category> {
    let mut v: Vec<&Category> = cats
        .iter()
        .filter(|c| c.parent_category_id.as_deref() == id)
        .collect();
    v.sort_by(|a, b| sibling_order(a, b));
    v
}

/// A category's budget plus everything under it. A cycle counts as 0.
fn compute(
    id: &str,
    seen: &mut HashSet<String>,
    subtree: &mut HashMap<String, i64>,
    cats: &[Category],
    budget: &HashMap<String, i64>,
) -> i64 {
    if let Some(&t) = subtree.get(id) {
        return t;
    }
    if !seen.insert(id.to_string()) {
        return 0;
    }
    let mut total = budget.get(id).copied().unwrap_or(0);
    for ch in children_of(cats, Some(id)) {
        total += compute(&ch.id, seen, subtree, cats, budget);
    }
    subtree.insert(id.to_string(), total);
    total
}

struct Tree<'a> {
    cats: &'a [Category],
    budget: &'a HashMap<String, i64>,
    subtree: &'a HashMap<String, i64>,
}

impl Tree<'_> {
    fn sub(&self, id: &str) -> i64 {
        self.subtree.get(id).copied().unwrap_or(0)
    }

    fn emit(
        &self,
        cat: &Category,
        depth: u32,
        nodes: &mut Vec<SankeyNode>,
        links: &mut Vec<SankeyLink>,
    ) {
        let id = format!("cat:{}", cat.id);
        let mut node = SankeyNode::new(
            &id,
            &cat.name,
            self.sub(&cat.id),
            &cat.color,
            depth,
            SankeyNodeKind::Category,
        );
        node.category_id = Some(cat.id.clone());
        nodes.push(node);
        let kids: Vec<&Category> = children_of(self.cats, Some(&cat.id))
            .into_iter()
            .filter(|k| self.sub(&k.id) > 0)
            .collect();
        for k in &kids {
            links.push(SankeyLink::new(
                &id,
                format!("cat:{}", k.id),
                self.sub(&k.id),
            ));
            self.emit(k, depth + 1, nodes, links);
        }
        let direct = self.budget.get(&cat.id).copied().unwrap_or(0);
        if !kids.is_empty() && direct > 0 {
            let mut node = SankeyNode::new(
                format!("cat:{}:direct", cat.id),
                format!("{} (direct)", cat.name),
                direct,
                &cat.color,
                depth + 1,
                SankeyNodeKind::Category,
            );
            node.category_id = Some(cat.id.clone());
            nodes.push(node);
            links.push(SankeyLink::new(
                &id,
                format!("cat:{}:direct", cat.id),
                direct,
            ));
        }
    }
}

/// `PRE_INCOME_COLOR`: an item's colour when it has none of its own.
pub fn pre_income_color(kind: PreIncomeKind) -> &'static str {
    match kind {
        PreIncomeKind::Tax => "#6f8ef2",
        PreIncomeKind::Pretax => "#43cfc0",
        PreIncomeKind::Deduction => "#d8b23c",
    }
}

/// One monthly amount taken out of pay before it reaches income.
#[derive(Debug, Clone, PartialEq)]
pub struct PreIncomeBranch {
    pub id: String,
    pub label: String,
    pub value_cents: i64,
    pub color: String,
}

/// What comes out before income, per month: the estimate's taxes and pre-tax
/// savings grouped (unless the user turned the estimate off), then the
/// user's own items. Zero amounts are left out.
pub fn pre_income_branches(
    estimate: Option<&TaxEstimate>,
    pre: Option<&PreIncome>,
) -> Vec<PreIncomeBranch> {
    let mut out = Vec::new();
    if let Some(estimate) = estimate.filter(|_| pre.map(|p| p.use_estimate).unwrap_or(true)) {
        // A Map in first-seen order.
        let mut groups: Vec<(TaxGroup, i64)> = Vec::new();
        for l in &estimate.lines {
            let amount = l.amount_cents.max(0);
            match groups.iter_mut().find(|(g, _)| *g == l.group) {
                Some((_, c)) => *c += amount,
                None => groups.push((l.group, amount)),
            }
        }
        for (g, c) in groups {
            let monthly = js_round(c as f64 / 12.0);
            if monthly > 0 {
                let (label, color) = (g.label(), g.color());
                out.push(PreIncomeBranch {
                    id: format!("tax:{}", g.id()),
                    label: label.into(),
                    value_cents: monthly,
                    color: color.into(),
                });
            }
        }
    }
    for item in pre.map(|p| p.items.as_slice()).unwrap_or_default() {
        if item.monthly_cents > 0 {
            out.push(PreIncomeBranch {
                id: format!("pre:{}", item.id),
                label: item.name.clone(),
                value_cents: item.monthly_cents,
                color: item
                    .color
                    .clone()
                    .unwrap_or_else(|| pre_income_color(item.kind).into()),
            });
        }
    }
    out
}

fn branch_node(b: &PreIncomeBranch) -> SankeyNode {
    let mut n = SankeyNode::new(
        &b.id,
        &b.label,
        b.value_cents,
        &b.color,
        1,
        SankeyNodeKind::Category,
    );
    n.section = Some(SankeySection::Taxes);
    n
}

/// Start the budget Sankey from gross pay: "Planned income" becomes "Gross
/// pay", which splits into the monthly taxes and deductions (beside the hub)
/// and the take-home that flows on into the budget. Unchanged without an
/// income node or any branches.
pub fn with_tax_branch(sankey: SankeyGraph, branches: &[PreIncomeBranch]) -> SankeyGraph {
    let Some(income) = sankey.nodes.iter().find(|n| n.id == "income") else {
        return sankey;
    };
    if branches.is_empty() {
        return sankey;
    }
    let gross = income.value_cents + branches.iter().map(|b| b.value_cents).sum::<i64>();
    let mut nodes: Vec<SankeyNode> = sankey
        .nodes
        .into_iter()
        .map(|mut n| {
            if n.id == "income" {
                n.label = "Gross pay".into();
                n.value_cents = gross;
                n.color = "#6f8ef2".into();
            } else if n.id == "hub" {
                n.label = "Take-home to allocate".into();
            }
            n
        })
        .collect();
    let mut links = sankey.links;
    for b in branches {
        nodes.push(branch_node(b));
        links.push(SankeyLink::new("income", &b.id, b.value_cents));
    }
    SankeyGraph { nodes, links }
}

/// The before-income add-on for the actual cash-flow Sankey: every column
/// moves one right and a "Gross pay" column goes first, feeding the month's
/// taxes and deductions and the income that arrived. "(est.)" whenever any
/// branch comes from the estimate. Unchanged without income or branches.
pub fn with_gross_branch(sankey: SankeyGraph, branches: &[PreIncomeBranch]) -> SankeyGraph {
    let incomes: Vec<(String, i64)> = sankey
        .nodes
        .iter()
        .filter(|n| n.depth == 0 && n.value_cents > 0)
        .map(|n| (n.id.clone(), n.value_cents))
        .collect();
    if incomes.is_empty() || branches.is_empty() {
        return sankey;
    }
    let gross = incomes.iter().map(|(_, v)| v).sum::<i64>()
        + branches.iter().map(|b| b.value_cents).sum::<i64>();
    let estimated = branches.iter().any(|b| b.id.starts_with("tax:"));
    let mut head = SankeyNode::new(
        "gross",
        if estimated {
            "Gross pay (est.)"
        } else {
            "Gross pay"
        },
        gross,
        "#6f8ef2",
        0,
        SankeyNodeKind::Income,
    );
    head.section = Some(SankeySection::Taxes);
    let nodes = std::iter::once(head)
        .chain(branches.iter().map(branch_node))
        .chain(sankey.nodes.into_iter().map(|mut n| {
            n.depth += 1;
            n
        }))
        .collect();
    let links = branches
        .iter()
        .map(|b| SankeyLink::new("gross", &b.id, b.value_cents))
        .chain(
            incomes
                .iter()
                .map(|(id, v)| SankeyLink::new("gross", id, *v)),
        )
        .chain(sankey.links)
        .collect();
    SankeyGraph { nodes, links }
}

/// One category's month, as compared on the budget-vs-actual Sankey.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetVsActualRow {
    /// `None` for uncategorized spending.
    pub category_id: Option<String>,
    pub label: String,
    pub color: String,
    pub budgeted_cents: i64,
    pub actual_cents: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BudgetVsActual {
    pub rows: Vec<BudgetVsActualRow>,
    pub graph: SankeyGraph,
    pub budgeted_cents: i64,
    pub actual_cents: i64,
    /// Spending beyond budgets, unbudgeted categories included.
    pub over_cents: i64,
    /// Budget left unspent, added up per category.
    pub unspent_cents: i64,
}

const OVER_COLOR: &str = "#ec6a6a";
const UNSPENT_COLOR: &str = "#43cfc0";
const BUDGETED_COLOR: &str = "#6f8ef2";
const ACTUAL_COLOR: &str = "#9397ab";

/// An insertion-ordered map (JS `Map`) for the handful of rows here.
struct Ordered<K, V>(Vec<(K, V)>);

impl<K: PartialEq, V> Ordered<K, V> {
    fn get(&self, k: &K) -> Option<&V> {
        self.0.iter().find(|(x, _)| x == k).map(|(_, v)| v)
    }
    fn set(&mut self, k: K, v: V) {
        match self.0.iter_mut().find(|(x, _)| *x == k) {
            Some(slot) => slot.1 = v,
            None => self.0.push((k, v)),
        }
    }
}

/// Budget and actual on one Sankey that balances: the left column is where
/// each category's money was meant to come from (its budget, plus "Over
/// budget" for anything beyond it), the right is what happened to it (spent,
/// or left unspent). So Budgeted + Over budget = Actual spent + Left unspent
/// to the cent. Spending in a sub-category without a budget counts against
/// the nearest budgeted parent; income categories are left out unless
/// budgeted. `format` is `formatCents`, for the captions.
pub fn build_budget_vs_actual(
    budgets: &[BudgetWithSpend],
    unbudgeted: &[UnbudgetedSpending],
    categories: &[Category],
    format: impl Fn(i64) -> String,
) -> BudgetVsActual {
    let cat_by_id: HashMap<&str, &Category> =
        categories.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut budgeted: Ordered<String, i64> = Ordered(Vec::new());
    for b in budgets {
        budgeted.set(b.category_id.clone(), b.amount_cents);
    }
    let owner_of = |category_id: &str| -> String {
        let mut seen: HashSet<&str> = HashSet::new();
        let mut id: Option<&str> = Some(category_id);
        while let Some(cur) = id.filter(|i| !i.is_empty() && !seen.contains(i)) {
            if budgeted.get(&cur.to_string()).is_some() {
                return cur.to_string();
            }
            seen.insert(cur);
            id = cat_by_id
                .get(cur)
                .and_then(|c| c.parent_category_id.as_deref());
        }
        category_id.to_string()
    };
    let mut actual: Ordered<Option<String>, i64> = Ordered(Vec::new());
    let mut add_spend = |category_id: Option<&str>, cents: i64| {
        let owner = category_id.filter(|c| !c.is_empty()).map(owner_of);
        let prev = actual.get(&owner).copied().unwrap_or(0);
        actual.set(owner, prev + cents);
    };
    for b in budgets {
        add_spend(Some(&b.category_id), b.spent_cents);
    }
    for u in unbudgeted {
        if let Some(id) = &u.category_id {
            if cat_by_id.get(id.as_str()).map(|c| c.kind) == Some(CategoryKind::Income) {
                continue;
            }
        }
        add_spend(u.category_id.as_deref(), u.spent_cents);
    }

    // `new Set([...budgeted.keys(), ...actual.keys()])`.
    let mut ids: Vec<Option<String>> = Vec::new();
    for id in budgeted
        .0
        .iter()
        .map(|(k, _)| Some(k.clone()))
        .chain(actual.0.iter().map(|(k, _)| k.clone()))
    {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut rows: Vec<BudgetVsActualRow> = ids
        .into_iter()
        .map(|id| {
            let cat = id.as_deref().and_then(|i| cat_by_id.get(i));
            BudgetVsActualRow {
                label: match (&id, cat) {
                    (None, _) => "Uncategorized".into(),
                    (Some(_), Some(c)) => c.name.clone(),
                    (Some(_), None) => "Unknown category".into(),
                },
                color: cat
                    .map(|c| c.color.clone())
                    .unwrap_or_else(|| ACTUAL_COLOR.into()),
                budgeted_cents: id
                    .as_ref()
                    .and_then(|i| budgeted.get(i).copied())
                    .unwrap_or(0),
                actual_cents: actual.get(&id).copied().unwrap_or(0),
                category_id: id,
            }
        })
        .filter(|r| r.budgeted_cents > 0 || r.actual_cents > 0)
        .collect();
    rows.sort_by(|a, b| {
        b.budgeted_cents
            .max(b.actual_cents)
            .cmp(&a.budgeted_cents.max(a.actual_cents))
            .then_with(|| locale_compare(&a.label, &b.label))
    });

    let mut nodes = Vec::new();
    let mut links = Vec::new();
    let (mut budgeted_cents, mut actual_cents, mut over_cents, mut unspent_cents) = (0, 0, 0, 0);
    let colored = |from: &str, to: &str, v: i64, color: &str| SankeyLink {
        color: Some(color.into()),
        ..SankeyLink::new(from, to, v)
    };
    for r in &rows {
        let id = format!("cat:{}", r.category_id.as_deref().unwrap_or("none"));
        let over = (r.actual_cents - r.budgeted_cents).max(0);
        let unspent = (r.budgeted_cents - r.actual_cents).max(0);
        budgeted_cents += r.budgeted_cents;
        actual_cents += r.actual_cents;
        over_cents += over;
        unspent_cents += unspent;
        let mut n = SankeyNode::new(
            &id,
            &r.label,
            r.budgeted_cents.max(r.actual_cents),
            &r.color,
            1,
            SankeyNodeKind::Category,
        );
        n.category_id = r.category_id.clone();
        n.section = Some(SankeySection::Spending);
        n.caption = Some(format!(
            "{} · {} actual",
            if r.budgeted_cents > 0 {
                format!("{} budgeted", format(r.budgeted_cents))
            } else {
                "No budget".into()
            },
            format(r.actual_cents)
        ));
        n.comparison = Some(SankeyComparison {
            budgeted_cents: r.budgeted_cents,
            actual_cents: r.actual_cents,
        });
        nodes.push(n);
        if r.budgeted_cents > 0 {
            links.push(colored("budgeted", &id, r.budgeted_cents, &r.color));
        }
        if over > 0 {
            links.push(colored("over", &id, over, OVER_COLOR));
        }
        if r.actual_cents > 0 {
            links.push(colored(&id, "actual", r.actual_cents, &r.color));
        }
        if unspent > 0 {
            links.push(colored(&id, "unspent", unspent, UNSPENT_COLOR));
        }
    }
    let mut total = |id: &str, label: &str, value: i64, color: &str, depth: u32, note: &str| {
        if value <= 0 {
            return;
        }
        let mut n = SankeyNode::new(id, label, value, color, depth, SankeyNodeKind::Category);
        n.caption = Some(format(value));
        n.note = Some(note.into());
        nodes.push(n);
    };
    total(
        "budgeted",
        "Budgeted",
        budgeted_cents,
        BUDGETED_COLOR,
        0,
        "Everything you budgeted this month, across all categories.",
    );
    total(
        "over",
        "Over budget",
        over_cents,
        OVER_COLOR,
        0,
        "Spending beyond each category's budget, including categories with no budget at all.",
    );
    total(
        "actual",
        "Actual spent",
        actual_cents,
        ACTUAL_COLOR,
        2,
        "Everything spent this month, across all categories.",
    );
    total(
        "unspent",
        "Left unspent",
        unspent_cents,
        UNSPENT_COLOR,
        2,
        "Budget not spent yet, added up across the categories still under budget.",
    );
    BudgetVsActual {
        rows,
        graph: SankeyGraph { nodes, links },
        budgeted_cents,
        actual_cents,
        over_cents,
        unspent_cents,
    }
}

#[cfg(test)]
mod tests {
    //! Every case in budgetSankey.test.ts. The tax estimates there come from
    //! `estimateTaxes`, which isn't ported: `estimate_*` below are its output
    //! for the same inputs (recorded from the TypeScript engine).
    use super::*;
    use crate::budgets::PreIncomeItem;
    use crate::taxes::TaxLine;

    fn cat(id: &str, name: &str, parent: Option<&str>) -> Category {
        Category {
            id: id.into(),
            name: name.into(),
            icon: None,
            color: "#888888".into(),
            parent_category_id: parent.map(Into::into),
            sort_order: 0,
            kind: CategoryKind::Expense,
            is_system: false,
        }
    }
    fn budgets(pairs: &[(&str, i64)]) -> HashMap<String, i64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }
    fn sum_links_from(links: &[SankeyLink], from: &str) -> i64 {
        links
            .iter()
            .filter(|l| l.from == from)
            .map(|l| l.value_cents)
            .sum()
    }
    fn node<'a>(g: &'a SankeyGraph, id: &str) -> Option<&'a SankeyNode> {
        g.nodes.iter().find(|n| n.id == id)
    }
    /// The TS engine's `formatCents` in en-US, for captions.
    fn usd(cents: i64) -> String {
        let abs = cents.unsigned_abs();
        let whole = (abs / 100).to_string();
        let mut grouped = String::new();
        for (i, ch) in whole.chars().enumerate() {
            if i > 0 && (whole.len() - i) % 3 == 0 {
                grouped.push(',');
            }
            grouped.push(ch);
        }
        format!(
            "{}${grouped}.{:02}",
            if cents < 0 { "\u{2212}" } else { "" },
            abs % 100
        )
    }

    fn estimate(take_home: i64, lines: &[(TaxGroup, i64)]) -> TaxEstimate {
        TaxEstimate {
            year: 2026,
            state: String::new(),
            state_name: String::new(),
            locality: None,
            gross_cents: 0,
            pretax_cents: 0,
            tax_cents: 0,
            take_home_cents: take_home,
            effective_rate_pct: 0.0,
            marginal_federal_pct: 0.0,
            marginal_state_pct: 0.0,
            lines: lines
                .iter()
                .enumerate()
                .map(|(i, (group, amount_cents))| TaxLine {
                    id: format!("l{i}"),
                    label: String::new(),
                    group: *group,
                    amount_cents: *amount_cents,
                })
                .collect(),
            per_earner: Vec::new(),
            notes: Vec::new(),
        }
    }
    use TaxGroup::*;
    /// `estimateTaxes({ filingStatus: "single", state: "CO", earners: [{ name: "A",
    /// grossAnnualCents: 10_000_000, retirementPct: 5 }] })`.
    fn estimate_co_100k() -> TaxEstimate {
        estimate(
            7_180_840,
            &[
                (Pretax, 500_000),
                (Federal, 1_207_000),
                (Fica, 620_000),
                (Fica, 145_000),
                (State, 347_160),
            ],
        )
    }
    /// `estimateTaxes({ filingStatus: "single", state: "MI", locality: "grand_rapids",
    /// earners: [{ name: "Me", grossAnnualCents: 6_000_000 }] })`.
    fn estimate_mi_grand_rapids_60k() -> TaxEstimate {
        estimate(
            4_719_075,
            &[
                (Federal, 502_000),
                (Fica, 372_000),
                (Fica, 87_000),
                (State, 229_925),
                (Local, 90_000),
            ],
        )
    }
    /// `estimateTaxes({ filingStatus: "single", state: "CO", earners: [{ name: "A",
    /// grossAnnualCents: 6_000_000 }] })`.
    fn estimate_co_60k() -> TaxEstimate {
        estimate(
            4_845_840,
            &[
                (Federal, 502_000),
                (Fica, 372_000),
                (Fica, 87_000),
                (State, 193_160),
            ],
        )
    }

    // ── buildBudgetSankey ──

    #[test]
    fn routes_all_income_out_of_the_hub_allocated_plus_savings() {
        let cats = [cat("g", "Groceries", None), cat("t", "Transport", None)];
        let out = build_budget_sankey(100_000, &cats, &budgets(&[("g", 40_000), ("t", 20_000)]));
        assert_eq!(out.allocated, 60_000);
        // Nothing may vanish between income and its destinations.
        assert_eq!(sum_links_from(&out.graph.links, "hub"), 100_000);
        assert_eq!(sum_links_from(&out.graph.links, "income"), 100_000);
    }

    #[test]
    fn emits_an_unallocated_savings_leaf_for_the_remainder() {
        let out = build_budget_sankey(
            100_000,
            &[cat("g", "Groceries", None)],
            &budgets(&[("g", 30_000)]),
        );
        assert_eq!(node(&out.graph, "saved").unwrap().value_cents, 70_000);
    }

    #[test]
    fn omits_the_savings_leaf_when_income_is_fully_allocated() {
        let out = build_budget_sankey(
            50_000,
            &[cat("g", "Groceries", None)],
            &budgets(&[("g", 50_000)]),
        );
        assert!(node(&out.graph, "saved").is_none());
    }

    #[test]
    fn never_emits_negative_savings_when_over_allocated() {
        // Allocating more than you earn is a real state the planner allows.
        let out = build_budget_sankey(
            50_000,
            &[cat("g", "Groceries", None)],
            &budgets(&[("g", 80_000)]),
        );
        assert_eq!(out.allocated, 80_000);
        assert!(node(&out.graph, "saved").is_none());
    }

    #[test]
    fn rolls_child_budgets_up_into_the_parents_subtree_total() {
        let cats = [
            cat("f", "Food", None),
            cat("g", "Groceries", Some("f")),
            cat("d", "Dining", Some("f")),
        ];
        let out = build_budget_sankey(100_000, &cats, &budgets(&[("g", 30_000), ("d", 10_000)]));
        assert_eq!(node(&out.graph, "cat:f").unwrap().value_cents, 40_000);
    }

    #[test]
    fn splits_a_parents_own_allocation_into_a_direct_child_node() {
        let cats = [cat("f", "Food", None), cat("g", "Groceries", Some("f"))];
        let out = build_budget_sankey(100_000, &cats, &budgets(&[("f", 5_000), ("g", 30_000)]));
        assert_eq!(node(&out.graph, "cat:f").unwrap().value_cents, 35_000);
        let direct = node(&out.graph, "cat:f:direct").unwrap();
        assert_eq!(direct.value_cents, 5_000);
        assert_eq!(direct.label, "Food (direct)");
        assert_eq!(direct.depth, 3);
    }

    #[test]
    fn drops_categories_with_no_allocation() {
        let cats = [cat("g", "Groceries", None), cat("z", "Unused", None)];
        let out = build_budget_sankey(100_000, &cats, &budgets(&[("g", 10_000)]));
        assert!(node(&out.graph, "cat:z").is_none());
    }

    #[test]
    fn survives_a_cyclic_parent_reference_without_hanging() {
        // Defensive: a corrupt tree must not spin forever behind the UI.
        let cats = [cat("a", "A", Some("b")), cat("b", "B", Some("a"))];
        let out = build_budget_sankey(10_000, &cats, &budgets(&[("a", 1_000)]));
        assert!(!out.graph.nodes.is_empty());
    }

    #[test]
    fn produces_an_empty_plan_for_zero_income_and_no_budgets() {
        let out = build_budget_sankey(0, &[], &HashMap::new());
        assert_eq!(out.allocated, 0);
        assert_eq!(sum_links_from(&out.graph.links, "hub"), 0);
    }

    #[test]
    fn orders_siblings_by_sort_order_then_name() {
        let mut b = cat("b", "banana", None);
        let mut a = cat("a", "Apple", None);
        let c = cat("c", "Cherry", None);
        b.sort_order = 1;
        a.sort_order = 1;
        let out = build_budget_sankey(
            100_000,
            &[b, a, c],
            &budgets(&[("a", 1), ("b", 1), ("c", 1)]),
        );
        let hub_targets: Vec<&str> = out
            .graph
            .links
            .iter()
            .filter(|l| l.from == "hub")
            .map(|l| l.to.as_str())
            .collect();
        assert_eq!(hub_targets, ["cat:c", "cat:a", "cat:b", "saved"]);
    }

    // ── withTaxBranch ──

    #[test]
    fn starts_from_gross_pay_and_branches_taxes_off_beside_the_take_home_hub() {
        let est = estimate_co_100k();
        let take_home = js_round(est.take_home_cents as f64 / 12.0);
        let base = build_budget_sankey(
            take_home,
            &[cat("g", "Groceries", None)],
            &budgets(&[("g", 60_000)]),
        );
        let out = with_tax_branch(base.graph, &pre_income_branches(Some(&est), None));
        let gross = node(&out, "income").unwrap();
        assert_eq!(gross.label, "Gross pay");
        assert_eq!(node(&out, "hub").unwrap().label, "Take-home to allocate");
        let leaves: Vec<&SankeyNode> = out
            .nodes
            .iter()
            .filter(|n| n.id.starts_with("tax:"))
            .collect();
        let mut ids: Vec<&str> = leaves.iter().map(|n| n.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["tax:federal", "tax:fica", "tax:pretax", "tax:state"]);
        assert!(leaves.iter().all(|n| n.depth == 1));
        // Everything leaving gross adds back up to it.
        assert_eq!(sum_links_from(&out.links, "income"), gross.value_cents);
        assert!((gross.value_cents - js_round(10_000_000.0 / 12.0)).abs() <= 6);
    }

    #[test]
    fn leaves_the_diagram_alone_without_an_income_node() {
        let est = estimate_co_100k();
        let empty = SankeyGraph::default();
        assert_eq!(
            with_tax_branch(empty.clone(), &pre_income_branches(Some(&est), None)),
            empty
        );
    }

    // ── withGrossBranch ──

    fn actual_diagram() -> SankeyGraph {
        // One deposit account → hub → one category.
        let mut g = SankeyNode::new(
            "cat:g",
            "Groceries",
            400_000,
            "#ff0",
            2,
            SankeyNodeKind::Category,
        );
        g.category_id = Some("g".into());
        SankeyGraph {
            nodes: vec![
                SankeyNode::new(
                    "income:acct",
                    "Checking",
                    400_000,
                    "#3ecf8e",
                    0,
                    SankeyNodeKind::Income,
                ),
                SankeyNode::new(
                    "hub",
                    "Total income",
                    400_000,
                    "#9397ab",
                    1,
                    SankeyNodeKind::Hub,
                ),
                g,
            ],
            links: vec![
                SankeyLink::new("income:acct", "hub", 400_000),
                SankeyLink::new("hub", "cat:g", 400_000),
            ],
        }
    }

    #[test]
    fn puts_gross_pay_first_with_taxes_beside_the_real_income_and_shifts_the_rest_right() {
        let est = estimate_mi_grand_rapids_60k();
        let out = with_gross_branch(actual_diagram(), &pre_income_branches(Some(&est), None));
        let gross = node(&out, "gross").unwrap();
        assert_eq!(gross.depth, 0);
        assert_eq!(gross.section, Some(SankeySection::Taxes));
        assert_eq!(gross.label, "Gross pay (est.)");
        assert_eq!(node(&out, "income:acct").unwrap().depth, 1);
        assert_eq!(node(&out, "cat:g").unwrap().depth, 3);
        let taxes: Vec<&SankeyNode> = out
            .nodes
            .iter()
            .filter(|n| n.id.starts_with("tax:"))
            .collect();
        let mut ids: Vec<&str> = taxes.iter().map(|n| n.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["tax:federal", "tax:fica", "tax:local", "tax:state"]);
        assert_eq!(sum_links_from(&out.links, "gross"), gross.value_cents);
        assert_eq!(
            gross.value_cents - 400_000,
            taxes.iter().map(|n| n.value_cents).sum::<i64>()
        );
    }

    #[test]
    fn does_nothing_without_income() {
        let est = estimate_mi_grand_rapids_60k();
        let empty = SankeyGraph::default();
        assert_eq!(
            with_gross_branch(empty.clone(), &pre_income_branches(Some(&est), None)),
            empty
        );
    }

    // ── preIncomeBranches ──

    fn items() -> Vec<PreIncomeItem> {
        vec![
            PreIncomeItem {
                id: "a".into(),
                name: "Federal withholding".into(),
                kind: PreIncomeKind::Tax,
                monthly_cents: 52_000,
                color: None,
            },
            PreIncomeItem {
                id: "b".into(),
                name: "Health insurance".into(),
                kind: PreIncomeKind::Deduction,
                monthly_cents: 18_000,
                color: Some("#123456".into()),
            },
            PreIncomeItem {
                id: "c".into(),
                name: "Empty".into(),
                kind: PreIncomeKind::Pretax,
                monthly_cents: 0,
                color: None,
            },
        ]
    }
    fn pre(use_estimate: bool) -> PreIncome {
        PreIncome {
            items: items(),
            use_estimate,
        }
    }

    #[test]
    fn adds_the_users_items_after_the_estimate_skipping_zero_amounts() {
        let est = estimate_co_60k();
        let out = pre_income_branches(Some(&est), Some(&pre(true)));
        assert!(out.iter().any(|b| b.id.starts_with("tax:")));
        let mine: Vec<(&str, i64, &str)> = out
            .iter()
            .filter(|b| b.id.starts_with("pre:"))
            .map(|b| (b.label.as_str(), b.value_cents, b.color.as_str()))
            .collect();
        assert_eq!(
            mine,
            [
                ("Federal withholding", 52_000, "#6f8ef2"),
                ("Health insurance", 18_000, "#123456"),
            ]
        );
        // The estimate comes first, grouped and monthly.
        assert_eq!(out[0].id, "tax:federal");
        assert_eq!(out[1].id, "tax:fica");
        assert_eq!(out[1].value_cents, js_round(459_000.0 / 12.0));
        assert_eq!(out[1].label, "Social Security & Medicare");
    }

    #[test]
    fn uses_only_the_users_items_when_the_estimate_is_off_or_theres_no_tax_profile() {
        let est = estimate_co_60k();
        let ids = |v: Vec<PreIncomeBranch>| v.into_iter().map(|b| b.id).collect::<Vec<_>>();
        assert_eq!(
            ids(pre_income_branches(Some(&est), Some(&pre(false)))),
            ["pre:a", "pre:b"]
        );
        assert_eq!(
            ids(pre_income_branches(None, Some(&pre(true)))),
            ["pre:a", "pre:b"]
        );
        assert_eq!(pre_income_branches(None, None), []);
    }

    #[test]
    fn drives_the_actual_diagram_from_the_items_alone_without_est() {
        let actual = SankeyGraph {
            nodes: vec![SankeyNode::new(
                "income:acct",
                "Checking",
                400_000,
                "#3ecf8e",
                0,
                SankeyNodeKind::Income,
            )],
            links: vec![],
        };
        let out = with_gross_branch(actual, &pre_income_branches(None, Some(&pre(true))));
        let gross = node(&out, "gross").unwrap();
        assert_eq!(gross.label, "Gross pay");
        assert_eq!(gross.value_cents, 400_000 + 52_000 + 18_000);
    }

    // ── buildBudgetVsActual ──

    fn budget(category_id: &str, amount_cents: i64, spent_cents: i64) -> BudgetWithSpend {
        BudgetWithSpend {
            id: format!("b-{category_id}"),
            category_id: category_id.into(),
            amount_cents,
            rollover: false,
            starts_on: "2026-11-01".into(),
            period: None,
            period_amount_cents: None,
            spent_cents,
            period_spent_cents: None,
            period_start: None,
            period_end: None,
        }
    }
    fn spend(category_id: Option<&str>, spent_cents: i64) -> UnbudgetedSpending {
        UnbudgetedSpending {
            category_id: category_id.map(Into::into),
            spent_cents,
        }
    }
    fn total(links: &[SankeyLink], to: bool, id: &str) -> i64 {
        links
            .iter()
            .filter(|l| if to { l.to == id } else { l.from == id })
            .map(|l| l.value_cents)
            .sum()
    }
    fn cats() -> Vec<Category> {
        vec![
            cat("g", "Groceries", None),
            cat("d", "Dining", None),
            cat("r", "Rent", None),
        ]
    }

    #[test]
    fn balances_to_the_cent_under_and_over_budget_alike() {
        let view = build_budget_vs_actual(
            &[budget("g", 60_037, 61_099), budget("d", 20_001, 12_345)],
            &[spend(Some("r"), 150_033)],
            &cats(),
            usd,
        );
        assert_eq!(view.budgeted_cents, 80_038);
        assert_eq!(view.actual_cents, 223_477);
        assert_eq!(view.over_cents, 1_062 + 150_033);
        assert_eq!(view.unspent_cents, 7_656);
        assert_eq!(
            view.budgeted_cents + view.over_cents,
            view.actual_cents + view.unspent_cents
        );
        // Every category passes on exactly what it takes in.
        for n in view.graph.nodes.iter().filter(|n| n.depth == 1) {
            assert_eq!(total(&view.graph.links, true, &n.id), n.value_cents);
            assert_eq!(total(&view.graph.links, false, &n.id), n.value_cents);
        }
        assert_eq!(total(&view.graph.links, false, "budgeted"), 80_038);
        assert_eq!(total(&view.graph.links, false, "over"), 151_095);
        assert_eq!(total(&view.graph.links, true, "actual"), 223_477);
        assert_eq!(total(&view.graph.links, true, "unspent"), 7_656);
        // Largest first.
        let labels: Vec<&str> = view.rows.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(labels, ["Rent", "Groceries", "Dining"]);
    }

    #[test]
    fn draws_one_ribbon_for_the_budget_and_one_for_the_actual() {
        let view = build_budget_vs_actual(&[budget("g", 60_037, 12_345)], &[], &cats(), usd);
        let has = |from: &str, to: &str, v: i64| {
            view.graph
                .links
                .iter()
                .any(|l| l.from == from && l.to == to && l.value_cents == v)
        };
        assert!(has("budgeted", "cat:g", 60_037));
        assert!(has("cat:g", "actual", 12_345));
        assert!(has("cat:g", "unspent", 47_692));
        let unspent = view.graph.links.iter().find(|l| l.to == "unspent").unwrap();
        assert_eq!(unspent.color.as_deref(), Some("#43cfc0"));
    }

    #[test]
    fn shows_cents_for_both_figures_on_each_category() {
        let view = build_budget_vs_actual(&[budget("g", 60_037, 12_345)], &[], &cats(), usd);
        let caption = node(&view.graph, "cat:g").unwrap().caption.clone().unwrap();
        assert_eq!(caption, "$600.37 budgeted · $123.45 actual");
        let budgeted = node(&view.graph, "budgeted").unwrap();
        assert_eq!(budgeted.caption.as_deref(), Some("$600.37"));
        assert_eq!(
            budgeted.note.as_deref(),
            Some("Everything you budgeted this month, across all categories.")
        );
    }

    #[test]
    fn marks_unbudgeted_spending_and_keeps_uncategorized_spending_in_the_total() {
        let view = build_budget_vs_actual(
            &[],
            &[spend(Some("d"), 1_999), spend(None, 333)],
            &cats(),
            usd,
        );
        assert_eq!(view.actual_cents, 2_332);
        assert_eq!(
            view.rows
                .iter()
                .find(|r| r.category_id.is_none())
                .unwrap()
                .label,
            "Uncategorized"
        );
        assert!(node(&view.graph, "cat:d")
            .unwrap()
            .caption
            .as_deref()
            .unwrap()
            .starts_with("No budget"));
        assert!(node(&view.graph, "cat:none").is_some());
        assert!(node(&view.graph, "budgeted").is_none());
    }

    #[test]
    fn counts_a_sub_categorys_spending_against_its_budgeted_parent() {
        let tree = [
            cat("food", "Food", None),
            cat("g", "Groceries", Some("food")),
            cat("d", "Dining", Some("food")),
        ];
        let view = build_budget_vs_actual(
            &[budget("food", 50_000, 1_001), budget("d", 10_000, 2_002)],
            &[spend(Some("g"), 30_303)],
            &tree,
            usd,
        );
        let row = |id: &str| {
            view.rows
                .iter()
                .find(|r| r.category_id.as_deref() == Some(id))
        };
        assert_eq!(row("food").unwrap().actual_cents, 31_304);
        // Dining has its own budget, so it stays separate.
        assert_eq!(row("d").unwrap().actual_cents, 2_002);
        assert!(row("g").is_none());
        assert_eq!(view.actual_cents, 33_306);
    }

    #[test]
    fn leaves_out_negative_amounts_in_income_categories() {
        let mut income = cat("pay", "Salary", None);
        income.kind = CategoryKind::Income;
        let view = build_budget_vs_actual(&[], &[spend(Some("pay"), 500)], &[income], usd);
        assert_eq!(view.rows, []);
        assert_eq!(view.graph.nodes, []);
    }

    #[test]
    fn is_empty_with_no_budgets_and_no_spending() {
        let view = build_budget_vs_actual(&[], &[], &cats(), usd);
        assert_eq!(view.graph.nodes, []);
        assert_eq!(view.graph.links, []);
    }
}
