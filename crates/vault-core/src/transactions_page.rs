//! Pure logic of the Transactions page
//! (apps/desktop/src/screens/shell/TransactionsPage.tsx): the date filter,
//! the list query, day grouping on phones, the add/edit form and the
//! messages the page prints.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::categorize::AutocategorizeResponse;
use crate::dates::{days_in_month, parse_iso, to_iso};
use crate::money::{cents_to_fixed2, parse_amount_to_cents};
use crate::transactions::{Transaction, TransactionQuery};

/// Rows per page (`limit: 50`).
pub const PAGE_SIZE: u32 = 50;

/// The "Filter by date" select.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Period {
    #[default]
    All,
    Month,
    ThreeMonths,
    TwelveMonths,
}

impl Period {
    /// In `PERIOD_LABELS` order.
    pub const ALL: [Period; 4] = [
        Period::All,
        Period::Month,
        Period::ThreeMonths,
        Period::TwelveMonths,
    ];

    /// The `<option value>`.
    pub fn value(self) -> &'static str {
        match self {
            Period::All => "all",
            Period::Month => "month",
            Period::ThreeMonths => "3m",
            Period::TwelveMonths => "12m",
        }
    }

    pub fn from_value(v: &str) -> Period {
        Period::ALL
            .into_iter()
            .find(|p| p.value() == v)
            .unwrap_or_default()
    }

    /// `PERIOD_LABELS[period]` (also the Summary panel's subtitle).
    pub fn label(self) -> &'static str {
        match self {
            Period::All => "All time",
            Period::Month => "This month",
            Period::ThreeMonths => "Last 3 months",
            Period::TwelveMonths => "Last 12 months",
        }
    }

    /// `periodRange(period)` given today's local date: `(from, to)`.
    pub fn range(self, today: (i32, u32, u32)) -> (Option<String>, Option<String>) {
        let (y, m, d) = today;
        let to = to_iso(y, m, d);
        match self {
            Period::All => (None, None),
            Period::Month => (Some(to_iso(y, m, 1)), Some(to)),
            Period::ThreeMonths => (Some(months_back(today, 3)), Some(to)),
            Period::TwelveMonths => (Some(months_back(today, 12)), Some(to)),
        }
    }
}

/// `d.setMonth(d.getMonth() - n)`: a day past the end of the target month
/// rolls into the next one, as JS dates do (May 31 − 3 months = Mar 3).
fn months_back((y, m, d): (i32, u32, u32), n: i32) -> String {
    let total = y * 12 + (m as i32 - 1) - n;
    let (ny, nm) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
    let dim = days_in_month(ny, nm);
    if d <= dim {
        to_iso(ny, nm, d)
    } else if nm == 12 {
        to_iso(ny + 1, 1, d - dim)
    } else {
        to_iso(ny, nm + 1, d - dim)
    }
}

/// The toolbar's filters, as the list query reads them (search already
/// debounced).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Filters {
    pub search: String,
    /// "" = all, "none" = uncategorized, or a category id.
    pub category_id: String,
    /// "" = all, or an account id.
    pub account_id: String,
    pub period: Period,
}

impl Filters {
    /// `client.transactions({...})`, leaving out what isn't set.
    pub fn query(&self, today: (i32, u32, u32), cursor: Option<&str>) -> TransactionQuery {
        let some = |s: &str| (!s.is_empty()).then(|| s.to_string());
        let (from, to) = self.period.range(today);
        TransactionQuery {
            search: some(&self.search),
            category_id: some(&self.category_id),
            account_id: some(&self.account_id),
            from,
            to,
            cursor: cursor.map(str::to_string),
            limit: Some(PAGE_SIZE),
        }
    }

    /// Nothing filtered at all, so an empty list means an empty ledger.
    fn is_unfiltered(&self) -> bool {
        self.search.is_empty()
            && self.category_id.is_empty()
            && self.account_id.is_empty()
            && self.period == Period::All
    }

    /// The empty-list text: the table and the phone list word the first
    /// one slightly differently.
    pub fn empty_text(&self, total_count: i64, phone: bool) -> &'static str {
        if total_count == 0 && self.is_unfiltered() {
            if phone {
                "No transactions yet. Add one or import a CSV from your bank."
            } else {
                "No transactions yet — add one or import a CSV from your bank."
            }
        } else {
            "Nothing matches these filters."
        }
    }
}

/// The header checkbox: every shown row is selected.
pub fn all_selected(rows: &[Transaction], selected: &HashSet<String>) -> bool {
    !rows.is_empty() && rows.iter().all(|r| selected.contains(&r.id))
}

/// The bulk "Set category…" value as the `categoryId` to send.
pub fn bulk_category(value: &str) -> Option<String> {
    (value != "__none__").then(|| value.to_string())
}

/// `Delete N transaction(s)?`
pub fn bulk_delete_title(n: usize) -> String {
    format!("Delete {n} transaction{}?", if n == 1 { "" } else { "s" })
}

/// What "Auto-categorize" reports.
pub fn autocat_message(r: &AutocategorizeResponse) -> String {
    let mut parts = vec![
        format!("{} by rule", r.by_rule),
        format!("{} learned from history", r.by_history),
    ];
    if r.by_ai > 0 {
        parts.push(format!("{} by AI", r.by_ai));
    }
    if r.categorized > 0 {
        format!(
            "Sorted {} of {} ({}).",
            r.categorized,
            r.scanned,
            parts.join(", ")
        )
    } else if r.scanned == 0 {
        "Nothing uncategorized to sort.".into()
    } else {
        format!(
            "No matches among {} uncategorized — add a rule in Settings, or enable the AI assistant to sort the rest.",
            r.scanned
        )
    }
}

/// Consecutive rows that share a day (the list arrives newest first).
pub fn group_by_day(rows: &[Transaction]) -> Vec<(String, Vec<Transaction>)> {
    let mut days: Vec<(String, Vec<Transaction>)> = Vec::new();
    for t in rows {
        match days.last_mut() {
            Some((day, items)) if *day == t.posted_at => items.push(t.clone()),
            _ => days.push((t.posted_at.clone(), vec![t.clone()])),
        }
    }
    days
}

/// A phone day heading: "Today", "Yesterday", or a date the UI formats
/// (with the year only when it isn't this year).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DayLabel {
    Today,
    Yesterday,
    Date { with_year: bool },
}

/// `dayLabel(ymd)` given today's local date.
pub fn day_label(ymd: &str, today: (i32, u32, u32)) -> DayLabel {
    let Some(day) = parse_iso(ymd) else {
        return DayLabel::Date { with_year: false };
    };
    if day == today {
        DayLabel::Today
    } else if day == previous_day(today) {
        DayLabel::Yesterday
    } else {
        DayLabel::Date {
            with_year: day.0 != today.0,
        }
    }
}

fn previous_day((y, m, d): (i32, u32, u32)) -> (i32, u32, u32) {
    if d > 1 {
        (y, m, d - 1)
    } else if m > 1 {
        (y, m - 1, days_in_month(y, m - 1))
    } else {
        (y - 1, 12, 31)
    }
}

/// `/^\d{4}-\d{2}-\d{2}$/`.
pub fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// The add/edit dialog's fields.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TxnForm {
    pub account_id: String,
    /// "" = uncategorized.
    pub category_id: String,
    pub posted_at: String,
    pub merchant: String,
    pub amount: String,
    pub notes: String,
    pub is_transfer: bool,
    pub also_rule: bool,
}

impl TxnForm {
    /// The fields a dialog opens with: the transaction's, or blanks with
    /// the first account and `today` (UTC, as `toISOString()` gives it).
    pub fn new(t: Option<&Transaction>, first_account: Option<&str>, today: &str) -> TxnForm {
        match t {
            Some(t) => TxnForm {
                account_id: t.account_id.clone(),
                category_id: t.category_id.clone().unwrap_or_default(),
                posted_at: t.posted_at.clone(),
                merchant: t.merchant_name.clone(),
                amount: cents_to_fixed2(t.amount_cents),
                notes: t.notes.clone().unwrap_or_default(),
                is_transfer: t.is_transfer.unwrap_or(false),
                also_rule: false,
            },
            None => TxnForm {
                account_id: first_account.unwrap_or_default().to_string(),
                posted_at: today.to_string(),
                ..Default::default()
            },
        }
    }

    pub fn amount_cents(&self) -> Option<i64> {
        parse_amount_to_cents(&self.amount)
    }

    /// The Amount field's error, once something is typed.
    pub fn amount_error(&self) -> Option<&'static str> {
        (!self.amount.is_empty() && matches!(self.amount_cents(), None | Some(0)))
            .then_some("Amounts look like -42.50 (spending) or 1200 (income).")
    }

    /// Save is enabled. `editing` = an existing transaction (its account
    /// can't change, so none needs picking).
    pub fn valid(&self, editing: bool) -> bool {
        !self.merchant.trim().is_empty()
            && matches!(self.amount_cents(), Some(c) if c != 0)
            && is_ymd(&self.posted_at)
            && (editing || !self.account_id.is_empty())
    }

    /// The "Always file … here" box shows: filing something that wasn't
    /// filed before.
    pub fn categorizing_fresh(&self, original: Option<&Transaction>) -> bool {
        original.and_then(|t| t.category_id.as_deref()).is_none() && !self.category_id.is_empty()
    }

    /// The rule checkbox's text.
    pub fn rule_label(&self) -> String {
        let m = self.merchant.trim();
        format!(
            "Always file \u{201c}{}\u{201d} here",
            if m.is_empty() { "this merchant" } else { m }
        )
    }

    fn category(&self) -> Option<String> {
        (!self.category_id.is_empty()).then(|| self.category_id.clone())
    }

    fn notes(&self) -> Option<String> {
        let n = self.notes.trim();
        (!n.is_empty()).then(|| n.to_string())
    }

    /// `createTransaction` body (only when `valid(false)`).
    pub fn create_body(&self) -> Option<CreateTransactionBody> {
        Some(CreateTransactionBody {
            category_id: self.category(),
            posted_at: self.posted_at.clone(),
            amount_cents: self.amount_cents()?,
            merchant_name: self.merchant.trim().to_string(),
            notes: self.notes(),
            account_id: self.account_id.clone(),
            pending: false,
        })
    }

    /// `updateTransaction` body; `isTransfer` only when it changed.
    pub fn update_body(&self, original: &Transaction) -> Option<UpdateTransactionBody> {
        Some(UpdateTransactionBody {
            category_id: self.category(),
            posted_at: self.posted_at.clone(),
            amount_cents: self.amount_cents()?,
            merchant_name: self.merchant.trim().to_string(),
            notes: self.notes(),
            is_transfer: (self.is_transfer != original.is_transfer.unwrap_or(false))
                .then_some(self.is_transfer),
        })
    }

    /// The rule to create after saving, when the box is ticked.
    pub fn rule(&self) -> Option<(String, String)> {
        let m = self.merchant.trim();
        (self.also_rule && !self.category_id.is_empty() && !m.is_empty())
            .then(|| (m.to_string(), self.category_id.clone()))
    }
}

/// `CreateTransactionRequest` as the page sends it (nulls included).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTransactionBody {
    pub category_id: Option<String>,
    pub posted_at: String,
    pub amount_cents: i64,
    pub merchant_name: String,
    pub notes: Option<String>,
    pub account_id: String,
    pub pending: bool,
}

/// `UpdateTransactionRequest` as the page sends it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTransactionBody {
    pub category_id: Option<String>,
    pub posted_at: String,
    pub amount_cents: i64,
    pub merchant_name: String,
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_transfer: Option<bool>,
}

/// `ImportResponse`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResponse {
    pub imported: i64,
    pub skipped_duplicates: i64,
    pub errors: Vec<ImportError>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ImportError {
    pub line: i64,
    pub message: String,
}

impl ImportResponse {
    /// " · skipped N duplicate(s)" after the imported count.
    pub fn skipped_text(&self) -> Option<String> {
        let n = self.skipped_duplicates;
        (n > 0).then(|| format!(" · skipped {n} duplicate{}", if n == 1 { "" } else { "s" }))
    }

    /// "N row(s) had problems (first: line L — message)".
    pub fn errors_text(&self) -> Option<String> {
        let first = self.errors.first()?;
        let n = self.errors.len();
        Some(format!(
            "{n} row{} had problems (first: line {} — {})",
            if n == 1 { "" } else { "s" },
            first.line,
            first.message
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transactions::{tests::SAMPLE, TransactionListResponse};

    fn rows() -> Vec<Transaction> {
        serde_json::from_str::<TransactionListResponse>(SAMPLE)
            .unwrap()
            .transactions
    }

    #[test]
    fn period_ranges_follow_js_dates() {
        let today = (2026, 11, 24);
        assert_eq!(Period::All.range(today), (None, None));
        assert_eq!(
            Period::Month.range(today),
            (Some("2026-11-01".into()), Some("2026-11-24".into()))
        );
        assert_eq!(
            Period::ThreeMonths.range(today).0.as_deref(),
            Some("2026-08-24")
        );
        assert_eq!(
            Period::TwelveMonths.range(today).0.as_deref(),
            Some("2025-11-24")
        );
        // Across the year, and setMonth's day overflow.
        assert_eq!(
            Period::ThreeMonths.range((2027, 2, 10)).0.as_deref(),
            Some("2026-11-10")
        );
        assert_eq!(
            Period::ThreeMonths.range((2026, 5, 31)).0.as_deref(),
            Some("2026-03-03")
        );
        assert_eq!(
            Period::TwelveMonths.range((2028, 2, 29)).0.as_deref(),
            Some("2027-03-01")
        );
        assert_eq!(
            Period::ThreeMonths.range((2027, 3, 31)).0.as_deref(),
            Some("2026-12-31")
        );
        for p in Period::ALL {
            assert_eq!(Period::from_value(p.value()), p);
        }
        assert_eq!(Period::from_value("junk"), Period::All);
        assert_eq!(Period::TwelveMonths.label(), "Last 12 months");
    }

    #[test]
    fn query_leaves_out_unset_filters() {
        let today = (2026, 11, 24);
        let f = Filters::default();
        assert_eq!(
            serde_json::to_string(&f.query(today, None)).unwrap(),
            r#"{"limit":50}"#
        );
        let f = Filters {
            search: "market".into(),
            category_id: "none".into(),
            account_id: "acc".into(),
            period: Period::Month,
        };
        assert_eq!(
            serde_json::to_string(&f.query(today, Some("cur"))).unwrap(),
            r#"{"search":"market","categoryId":"none","accountId":"acc","from":"2026-11-01","to":"2026-11-24","cursor":"cur","limit":50}"#
        );
    }

    #[test]
    fn empty_text_depends_on_filters() {
        let f = Filters::default();
        assert!(f.empty_text(0, false).starts_with("No transactions yet —"));
        assert!(f
            .empty_text(0, true)
            .starts_with("No transactions yet. Add"));
        assert_eq!(f.empty_text(5, false), "Nothing matches these filters.");
        let f = Filters {
            period: Period::Month,
            ..Default::default()
        };
        assert_eq!(f.empty_text(0, true), "Nothing matches these filters.");
    }

    #[test]
    fn selection_and_bulk() {
        let rows = rows();
        let mut sel: HashSet<String> = rows.iter().take(2).map(|r| r.id.clone()).collect();
        assert!(!all_selected(&rows, &sel));
        sel.insert(rows[2].id.clone());
        assert!(all_selected(&rows, &sel));
        assert!(!all_selected(&[], &sel));
        assert_eq!(bulk_category("__none__"), None);
        assert_eq!(bulk_category("c1").as_deref(), Some("c1"));
        assert_eq!(bulk_delete_title(1), "Delete 1 transaction?");
        assert_eq!(bulk_delete_title(3), "Delete 3 transactions?");
    }

    #[test]
    fn autocat_messages() {
        let r = |scanned, categorized, by_rule, by_history, by_ai| AutocategorizeResponse {
            scanned,
            categorized,
            by_rule,
            by_history,
            by_ai,
        };
        assert_eq!(
            autocat_message(&r(58, 41, 12, 29, 0)),
            "Sorted 41 of 58 (12 by rule, 29 learned from history)."
        );
        assert_eq!(
            autocat_message(&r(58, 41, 12, 27, 2)),
            "Sorted 41 of 58 (12 by rule, 27 learned from history, 2 by AI)."
        );
        assert_eq!(
            autocat_message(&r(0, 0, 0, 0, 0)),
            "Nothing uncategorized to sort."
        );
        assert!(autocat_message(&r(7, 0, 0, 0, 0)).starts_with("No matches among 7 uncategorized"));
    }

    #[test]
    fn groups_consecutive_days() {
        let mut rows = rows();
        rows[1].posted_at = rows[0].posted_at.clone();
        let days = group_by_day(&rows);
        assert_eq!(days.len(), 2);
        assert_eq!(days[0].0, "2026-11-14");
        assert_eq!(days[0].1.len(), 2);
        assert_eq!(days[1].1[0].merchant_name, "Venmo from Alex");
        assert!(group_by_day(&[]).is_empty());
    }

    #[test]
    fn day_labels() {
        let today = (2026, 11, 24);
        assert_eq!(day_label("2026-11-24", today), DayLabel::Today);
        assert_eq!(day_label("2026-11-23", today), DayLabel::Yesterday);
        assert_eq!(
            day_label("2026-11-02", today),
            DayLabel::Date { with_year: false }
        );
        assert_eq!(
            day_label("2025-12-31", today),
            DayLabel::Date { with_year: true }
        );
        assert_eq!(day_label("2025-12-31", (2026, 1, 1)), DayLabel::Yesterday);
        assert_eq!(day_label("2026-02-28", (2026, 3, 1)), DayLabel::Yesterday);
    }

    #[test]
    fn form_validation_and_bodies() {
        let rows = rows();
        let new = TxnForm::new(None, Some("acc"), "2026-11-24");
        assert_eq!(new.account_id, "acc");
        assert_eq!(new.posted_at, "2026-11-24");
        assert!(!new.valid(false));
        assert_eq!(new.amount_error(), None);

        let mut f = TxnForm {
            merchant: "  Fresh Market ".into(),
            amount: "-42.50".into(),
            notes: "  ".into(),
            ..new.clone()
        };
        assert!(f.valid(false));
        f.account_id.clear();
        assert!(!f.valid(false));
        assert!(f.valid(true));
        f.account_id = "acc".into();
        assert_eq!(
            serde_json::to_string(&f.create_body().unwrap()).unwrap(),
            r#"{"categoryId":null,"postedAt":"2026-11-24","amountCents":-4250,"merchantName":"Fresh Market","notes":null,"accountId":"acc","pending":false}"#
        );
        f.amount = "0".into();
        assert!(!f.valid(false));
        assert!(f.amount_error().is_some());
        f.amount = "abc".into();
        assert!(f.amount_error().is_some());
        f.amount = "-1".into();
        f.posted_at = "2026-1-4".into();
        assert!(!f.valid(false));

        // Editing: fields come from the transaction.
        let t = &rows[1];
        let mut e = TxnForm::new(Some(t), None, "x");
        assert_eq!(e.amount, "-84.23");
        assert_eq!(e.notes, "split with Sam");
        assert!(!e.is_transfer);
        assert!(e.valid(true));
        assert!(!e.categorizing_fresh(Some(t)));
        assert_eq!(
            serde_json::to_string(&e.update_body(t).unwrap()).unwrap(),
            r#"{"categoryId":"7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","postedAt":"2026-11-12","amountCents":-8423,"merchantName":"Corner Market","notes":"split with Sam"}"#
        );
        e.is_transfer = true;
        e.category_id.clear();
        let body = serde_json::to_string(&e.update_body(t).unwrap()).unwrap();
        assert!(body.starts_with(r#"{"categoryId":null"#));
        assert!(body.ends_with(r#""isTransfer":true}"#));

        // The rule box: only when filing something uncategorized.
        let u = &rows[2];
        let mut r = TxnForm::new(Some(u), None, "x");
        assert!(!r.categorizing_fresh(Some(u)));
        r.category_id = "cat".into();
        assert!(r.categorizing_fresh(Some(u)));
        assert!(new.categorizing_fresh(None) == !new.category_id.is_empty());
        assert_eq!(
            r.rule_label(),
            "Always file \u{201c}Venmo from Alex\u{201d} here"
        );
        assert_eq!(r.rule(), None);
        r.also_rule = true;
        assert_eq!(r.rule(), Some(("Venmo from Alex".into(), "cat".into())));
        r.merchant = " ".into();
        assert_eq!(
            r.rule_label(),
            "Always file \u{201c}this merchant\u{201d} here"
        );
        assert_eq!(r.rule(), None);
    }

    #[test]
    fn ymd() {
        assert!(is_ymd("2026-11-24"));
        assert!(!is_ymd("2026-11-2"));
        assert!(!is_ymd("2026/11/24"));
        assert!(!is_ymd(""));
    }

    #[test]
    fn parses_import_response() {
        let r: ImportResponse = serde_json::from_str(
            r#"{"imported":42,"skippedDuplicates":1,"errors":[{"line":7,"message":"Bad amount"},{"line":9,"message":"Missing date"}]}"#,
        )
        .unwrap();
        assert_eq!(r.imported, 42);
        assert_eq!(r.skipped_text().as_deref(), Some(" · skipped 1 duplicate"));
        assert_eq!(
            r.errors_text().as_deref(),
            Some("2 rows had problems (first: line 7 — Bad amount)")
        );
        let clean: ImportResponse =
            serde_json::from_str(r#"{"imported":3,"skippedDuplicates":0,"errors":[]}"#).unwrap();
        assert_eq!(clean.skipped_text(), None);
        assert_eq!(clean.errors_text(), None);
    }
}
