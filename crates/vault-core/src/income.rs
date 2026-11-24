//! The Income page's logic (apps/desktop/src/screens/shell/IncomePage.tsx):
//! income-kind categories are the "sources", every money-in transaction of
//! the month counts toward its source or the unassigned bucket.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::categories::{Category, CategoryKind};
use crate::dates::{days_in_month, Month};
use crate::transactions::Transaction;

/// `SOURCE_COLORS`: a new source takes the next one round.
pub const SOURCE_COLORS: [&str; 7] = [
    "#3ecf8e", "#43cfc0", "#6f8ef2", "#b47ef0", "#ec6a9c", "#d8b23c", "#4db6d0",
];

/// The colour for the source added after `existing` ones.
pub fn next_source_color(existing: usize) -> &'static str {
    SOURCE_COLORS[existing % SOURCE_COLORS.len()]
}

/// `"2026-11"`, like `toISOString().slice(0, 7)`.
pub fn month_key(m: Month) -> String {
    format!("{:04}-{:02}", m.year, m.month)
}

/// `monthBounds`: the first and last day of the month.
pub fn month_bounds(m: Month) -> (String, String) {
    let key = month_key(m);
    let last = days_in_month(m.year, m.month);
    (format!("{key}-01"), format!("{key}-{last:02}"))
}

/// Income categories by `sortOrder`, then name. `name_cmp` is the name
/// comparison (`localeCompare` in the browser).
pub fn sources(
    categories: &[Category],
    name_cmp: impl Fn(&str, &str) -> Ordering,
) -> Vec<Category> {
    let mut out: Vec<Category> = categories
        .iter()
        .filter(|c| c.kind == CategoryKind::Income)
        .cloned()
        .collect();
    // Stable, like Array#sort.
    out.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| name_cmp(&a.name, &b.name))
    });
    out
}

/// Money in only.
pub fn income_items(txns: &[Transaction]) -> Vec<Transaction> {
    txns.iter()
        .filter(|t| t.amount_cents > 0)
        .cloned()
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct IncomeTotals {
    /// Per source id; sources with nothing this month are absent.
    pub by_source: HashMap<String, i64>,
    /// "Other income (unassigned)": no category, or a non-income one.
    pub other_cents: i64,
    pub total_cents: i64,
}

impl IncomeTotals {
    pub fn new(sources: &[Category], items: &[Transaction]) -> Self {
        let ids: HashSet<&str> = sources.iter().map(|s| s.id.as_str()).collect();
        let mut t = IncomeTotals::default();
        for item in items {
            match item.category_id.as_deref() {
                Some(id) if ids.contains(id) => {
                    *t.by_source.entry(id.to_string()).or_default() += item.amount_cents;
                }
                _ => t.other_cents += item.amount_cents,
            }
            t.total_cents += item.amount_cents;
        }
        t
    }

    pub fn source(&self, id: &str) -> i64 {
        self.by_source.get(id).copied().unwrap_or(0)
    }
}

/// `postedAt.slice(5)`: "11-14".
pub fn short_date(posted_at: &str) -> &str {
    posted_at.get(5..).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categories::{tests::SAMPLE as CATS, CategoryListResponse};
    use crate::transactions::{tests::SAMPLE as TXNS, TransactionListResponse};

    fn cats() -> Vec<Category> {
        serde_json::from_str::<CategoryListResponse>(CATS)
            .unwrap()
            .categories
    }
    fn txns() -> Vec<Transaction> {
        serde_json::from_str::<TransactionListResponse>(TXNS)
            .unwrap()
            .transactions
    }

    #[test]
    fn sources_are_income_by_order_then_name() {
        let s = sources(&cats(), |a, b| a.cmp(b));
        let names: Vec<&str> = s.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Gifts", "Salary", "Side Income"]);
    }

    #[test]
    fn totals_split_sources_and_other() {
        let s = sources(&cats(), |a, b| a.cmp(b));
        let mut items = income_items(&txns());
        assert_eq!(items.len(), 2);
        // Money in on an expense category counts as unassigned.
        let mut odd = items[0].clone();
        odd.category_id = Some("7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d".into());
        odd.amount_cents = 100;
        items.push(odd);
        let t = IncomeTotals::new(&s, &items);
        assert_eq!(t.source("9c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f"), 412500);
        assert_eq!(t.source("0d4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a"), 0);
        assert_eq!(t.other_cents, 15100);
        assert_eq!(t.total_cents, 427600);
        assert_eq!(IncomeTotals::new(&s, &[]), IncomeTotals::default());
    }

    #[test]
    fn month_helpers() {
        let feb = Month {
            year: 2028,
            month: 2,
        };
        assert_eq!(month_key(feb), "2028-02");
        assert_eq!(
            month_bounds(feb),
            ("2028-02-01".into(), "2028-02-29".into())
        );
        assert_eq!(
            month_bounds(Month {
                year: 2026,
                month: 11
            })
            .1,
            "2026-11-30"
        );
        assert_eq!(short_date("2026-11-14"), "11-14");
        assert_eq!(short_date("bad"), "");
        assert_eq!(next_source_color(0), "#3ecf8e");
        assert_eq!(next_source_color(8), "#43cfc0");
    }
}
