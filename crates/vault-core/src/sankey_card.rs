//! The pure parts of apps/desktop/src/screens/shell/SankeyCard.tsx: the
//! period toggle, which page owns each kind of node, and every text the
//! drill-in panel and its inline amount editor show.

use crate::bills::{Bill, BillCadence};
use crate::dates::days_in_month;
use crate::giving::{GivingFund, GivingKind};
use crate::goals::Goal;
use crate::nav::NavFilter;
use crate::sankey::{SankeyNode, SankeyNodeKind, SankeySection};
use crate::transactions::TransactionQuery;

/// The weekly/monthly/yearly toggle; figures are monthly.
pub const PERIODS: [&str; 3] = ["weekly", "monthly", "yearly"];

pub fn period_factor(period: &str) -> f64 {
    match period {
        "weekly" => 12.0 / 52.0,
        "yearly" => 12.0,
        _ => 1.0,
    }
}

/// `SECTION_TARGET`: where each kind of node lives in the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SectionTarget {
    pub page: &'static str,
    pub label: &'static str,
    pub tab: Option<&'static str>,
}

pub fn section_target(section: SankeySection) -> SectionTarget {
    let t = |page, label| SectionTarget {
        page,
        label,
        tab: None,
    };
    match section {
        SankeySection::Income => t("income", "Income"),
        SankeySection::Spending => t("transactions", "Transactions"),
        SankeySection::Bills => t("bills", "Bills"),
        SankeySection::Debt => SectionTarget {
            tab: Some("debt"),
            ..t("cashflow", "Debt payoff")
        },
        SankeySection::Savings => t("goals", "Savings goals"),
        SankeySection::Giving => t("giving", "Giving"),
        SankeySection::Saved => t("cashflow", "Cash flow"),
        SankeySection::Taxes => t("taxes", "Salary & taxes"),
    }
}

/// Income and the hub open their panel on the right; everything else on the left.
pub fn is_income_side(n: &SankeyNode) -> bool {
    matches!(n.kind, SankeyNodeKind::Income | SankeyNodeKind::Hub)
}

/// Group headers and aggregates have no transactions of their own. Income
/// is not one: an income source lists its deposits.
pub fn is_aggregate(n: &SankeyNode) -> bool {
    let planned_header = matches!(
        n.section,
        Some(
            SankeySection::Bills
                | SankeySection::Debt
                | SankeySection::Savings
                | SankeySection::Giving
                | SankeySection::Taxes
        )
    );
    matches!(n.kind, SankeyNodeKind::Hub | SankeyNodeKind::Saved)
        || (planned_header && n.entity_id.is_none())
}

/// The account or category a node's transactions are filtered by.
fn txn_filter(n: &SankeyNode) -> NavFilter {
    match &n.account_id {
        Some(a) => NavFilter::account(a),
        None => NavFilter {
            category_id: Some(n.category_id.clone().unwrap_or_else(|| "none".into())),
            ..Default::default()
        },
    }
}

/// The month's first transactions behind a node (8 of them), or `None` when
/// it has none to show ("Other income", the shortfall stub, aggregates).
pub fn transaction_query(n: &SankeyNode, month: &str) -> Option<TransactionQuery> {
    if is_aggregate(n)
        || (n.account_id.is_none()
            && n.category_id.is_none()
            && n.section != Some(SankeySection::Spending))
    {
        return None;
    }
    let mut parts = month.split('-').map(|p| p.parse::<i32>().unwrap_or(0));
    let (y, m) = (parts.next().unwrap_or(0), parts.next().unwrap_or(1));
    let last = days_in_month(y, m.clamp(1, 12) as u32);
    let f = txn_filter(n);
    Some(TransactionQuery {
        account_id: f.account_id,
        category_id: f.category_id,
        from: Some(format!("{month}-01")),
        to: Some(format!("{month}-{last:02}")),
        limit: Some(8),
        ..Default::default()
    })
}

/// Where "Manage in …" / "Open …" goes.
pub fn jump_filter(n: &SankeyNode) -> NavFilter {
    let mut f = match n.section {
        Some(SankeySection::Spending | SankeySection::Income) => txn_filter(n),
        _ => NavFilter::default(),
    };
    if let Some(tab) = n.section.and_then(|s| section_target(s).tab) {
        f.tab = Some(tab.into());
    }
    f
}

/// "View in Transactions →".
pub fn transactions_filter(n: &SankeyNode) -> NavFilter {
    txn_filter(n)
}

pub fn manage_label(n: &SankeyNode, target: SectionTarget) -> String {
    if n.entity_id.is_some() || n.section == Some(SankeySection::Spending) {
        format!("Manage in {}", target.label)
    } else {
        format!("Open {}", target.label)
    }
}

/// The small uppercase line above the node's name.
pub fn kicker(n: &SankeyNode, is_income: bool) -> String {
    if n.comparison.is_some() {
        "actual spending".into()
    } else if n.note.is_some() {
        "total".into()
    } else if n.kind == SankeyNodeKind::Saved {
        "left over".into()
    } else if is_income {
        "money in".into()
    } else {
        match n.section {
            Some(s) if s != SankeySection::Spending => format!("planned {}", s.as_str()),
            _ => "spending".into(),
        }
    }
}

/// What the panel says when there are no transactions to list.
pub fn empty_text(n: &SankeyNode) -> String {
    if let Some(note) = &n.note {
        return note.clone();
    }
    match n.kind {
        SankeyNodeKind::Saved => "Income that no plan has claimed yet — after spending, bills, debt, savings and giving. This is what's genuinely free to assign.".into(),
        SankeyNodeKind::Hub => "Everything that flowed in this month, before spending.".into(),
        _ if n.section.is_some_and(|s| s != SankeySection::Spending) && n.entity_id.is_none() => {
            "A planned group — open the section to change what's inside it.".into()
        }
        _ => "No individual transactions to show here.".into(),
    }
}

/// The comparison line: "$600 budgeted · $120 left" (or "… over").
pub fn comparison_parts(
    budgeted_cents: i64,
    actual_cents: i64,
    money: impl Fn(i64) -> String,
) -> (String, String, bool) {
    let left = budgeted_cents - actual_cents;
    let first = if budgeted_cents > 0 {
        format!("{} budgeted", money(budgeted_cents))
    } else {
        "No budget".into()
    };
    if left < 0 {
        (first, format!("{} over", money(-left)), true)
    } else {
        (first, format!("{} left", money(left)), false)
    }
}

/// The inline editor's field label and note for a bill.
pub fn bill_editor(b: &Bill) -> (String, String) {
    let label = if b.cadence == BillCadence::Monthly {
        "Amount per month".to_string()
    } else {
        format!("Amount per {}", b.cadence.as_str().replacen("ly", "", 1))
    };
    let note = format!(
        "Due day {} · {}{}",
        b.due_day,
        b.cadence.as_str(),
        if b.autopay { " · autopay" } else { "" }
    );
    (label, note)
}

pub fn goal_editor(g: &Goal, whole: impl Fn(i64) -> String) -> (String, String) {
    (
        "Contribution per month".into(),
        format!(
            "{} saved of {}",
            whole(g.saved_cents),
            whole(g.target_cents)
        ),
    )
}

pub fn giving_editor(f: &GivingFund, whole: impl Fn(i64) -> String) -> (String, String) {
    let gift = f.kind == GivingKind::Gift;
    let label = if gift {
        "Set aside per month"
    } else {
        "Given per month"
    };
    let note = match f.target_cents.filter(|&t| gift && t != 0) {
        Some(target) => format!(
            "{} saved of {}{}",
            whole(f.saved_cents),
            whole(target),
            f.occasion_date
                .as_deref()
                .filter(|d| !d.is_empty())
                .map(|d| format!(" by {d}"))
                .unwrap_or_default()
        ),
        None => f
            .recipient
            .clone()
            .unwrap_or_else(|| "Recurring giving".into()),
    };
    (label.into(), note)
}

/// The note for a planned debt payment.
pub fn debt_note(account: Option<(&str, i64)>, whole: impl Fn(i64) -> String) -> String {
    match account {
        Some((name, balance)) => format!("{name} · {} owed", whole(balance.abs())),
        None => "Planned debt payment".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sankey::SankeyComparison;

    fn node(kind: SankeyNodeKind, section: Option<SankeySection>) -> SankeyNode {
        let mut n = SankeyNode::new("n", "N", 100, "#888888", 2, kind);
        n.section = section;
        n
    }
    fn whole(c: i64) -> String {
        format!("${}", c / 100)
    }

    #[test]
    fn scales_by_period() {
        assert_eq!(period_factor("monthly"), 1.0);
        assert_eq!(period_factor("yearly"), 12.0);
        assert!((period_factor("weekly") - 0.230_769).abs() < 1e-6);
    }

    #[test]
    fn knows_which_nodes_have_transactions() {
        use SankeyNodeKind as K;
        use SankeySection as S;
        assert!(is_aggregate(&node(K::Hub, None)));
        assert!(is_aggregate(&node(K::Saved, Some(S::Saved))));
        assert!(is_aggregate(&node(K::Category, Some(S::Bills))));
        let mut bill = node(K::Category, Some(S::Bills));
        bill.entity_id = Some("b1".into());
        assert!(!is_aggregate(&bill));
        // An income source isn't an aggregate: it lists its deposits.
        let mut inc = node(K::Income, Some(S::Income));
        inc.account_id = Some("acct".into());
        assert!(!is_aggregate(&inc));
        let q = transaction_query(&inc, "2026-02").unwrap();
        assert_eq!(q.account_id.as_deref(), Some("acct"));
        assert_eq!(q.from.as_deref(), Some("2026-02-01"));
        assert_eq!(q.to.as_deref(), Some("2026-02-28"));
        assert_eq!(q.limit, Some(8));
        // Uncategorized spending filters by "none".
        let q = transaction_query(&node(K::Category, Some(S::Spending)), "2026-11").unwrap();
        assert_eq!(q.category_id.as_deref(), Some("none"));
        assert_eq!(q.to.as_deref(), Some("2026-11-30"));
        // "Other income" has nothing behind it.
        assert_eq!(
            transaction_query(&node(K::Income, Some(S::Income)), "2026-11"),
            None
        );
        assert_eq!(transaction_query(&bill, "2026-11"), None);
    }

    #[test]
    fn links_to_the_owning_page() {
        use SankeySection::*;
        let mut spend = node(SankeyNodeKind::Category, Some(Spending));
        spend.category_id = Some("c".into());
        assert_eq!(jump_filter(&spend).category_id.as_deref(), Some("c"));
        assert_eq!(
            manage_label(&spend, section_target(Spending)),
            "Manage in Transactions"
        );
        let debt = node(SankeyNodeKind::Category, Some(Debt));
        let f = jump_filter(&debt);
        assert_eq!((f.tab.as_deref(), f.category_id), (Some("debt"), None));
        assert_eq!(
            manage_label(&debt, section_target(Debt)),
            "Open Debt payoff"
        );
        assert_eq!(section_target(Taxes).label, "Salary & taxes");
    }

    #[test]
    fn says_what_a_node_is() {
        use SankeyNodeKind::*;
        assert_eq!(kicker(&node(Income, None), true), "money in");
        assert_eq!(kicker(&node(Saved, None), false), "left over");
        assert_eq!(
            kicker(&node(Category, Some(SankeySection::Bills)), false),
            "planned bills"
        );
        assert_eq!(
            kicker(&node(Category, Some(SankeySection::Spending)), false),
            "spending"
        );
        let mut cmp = node(Category, Some(SankeySection::Spending));
        cmp.comparison = Some(SankeyComparison {
            budgeted_cents: 1,
            actual_cents: 2,
        });
        assert_eq!(kicker(&cmp, false), "actual spending");
        let mut total = node(Category, None);
        total.note = Some("Everything.".into());
        assert_eq!(kicker(&total, false), "total");
        assert_eq!(empty_text(&total), "Everything.");
        assert_eq!(
            empty_text(&node(Hub, None)),
            "Everything that flowed in this month, before spending."
        );
        assert_eq!(
            empty_text(&node(Category, Some(SankeySection::Giving))),
            "A planned group — open the section to change what's inside it."
        );
        assert_eq!(
            empty_text(&node(Category, Some(SankeySection::Spending))),
            "No individual transactions to show here."
        );
    }

    #[test]
    fn compares_budget_and_actual() {
        assert_eq!(
            comparison_parts(60_000, 45_000, whole),
            ("$600 budgeted".into(), "$150 left".into(), false)
        );
        assert_eq!(
            comparison_parts(0, 2_000, whole),
            ("No budget".into(), "$20 over".into(), true)
        );
    }

    #[test]
    fn labels_the_inline_editors() {
        let bill = |cadence, autopay| Bill {
            id: "b".into(),
            name: "Rent".into(),
            amount_cents: 1,
            saved_cents: 0,
            due_day: 3,
            cadence,
            autopay,
            account_id: None,
            category_id: None,
            color: String::new(),
            next_due_date: String::new(),
            days_until_due: 0,
        };
        assert_eq!(
            bill_editor(&bill(BillCadence::Monthly, true)),
            (
                "Amount per month".into(),
                "Due day 3 · monthly · autopay".into()
            )
        );
        assert_eq!(
            bill_editor(&bill(BillCadence::Quarterly, false)).0,
            "Amount per quarter"
        );
        assert_eq!(
            bill_editor(&bill(BillCadence::Weekly, false)).0,
            "Amount per week"
        );
        assert_eq!(
            bill_editor(&bill(BillCadence::Yearly, false)).0,
            "Amount per year"
        );

        let fund = |kind, target, date: Option<&str>, recipient: Option<&str>| GivingFund {
            id: "f".into(),
            name: "F".into(),
            kind,
            recipient: recipient.map(Into::into),
            monthly_cents: 0,
            saved_cents: 12_000,
            target_cents: target,
            occasion_date: date.map(Into::into),
            account_id: None,
            category_id: None,
            color: String::new(),
            note: None,
            days_until_occasion: None,
            needed_monthly_cents: None,
            given_this_year_cents: 0,
        };
        assert_eq!(
            giving_editor(
                &fund(GivingKind::Gift, Some(30_000), Some("2027-03-14"), None),
                whole
            ),
            (
                "Set aside per month".into(),
                "$120 saved of $300 by 2027-03-14".into()
            )
        );
        assert_eq!(
            giving_editor(&fund(GivingKind::Gift, Some(0), None, None), whole).1,
            "Recurring giving"
        );
        assert_eq!(
            giving_editor(
                &fund(GivingKind::Giving, None, None, Some("Food bank")),
                whole
            ),
            ("Given per month".into(), "Food bank".into())
        );
        assert_eq!(
            debt_note(Some(("Visa", -250_000)), whole),
            "Visa · $2500 owed"
        );
        assert_eq!(debt_note(None, whole), "Planned debt payment");
    }
}
