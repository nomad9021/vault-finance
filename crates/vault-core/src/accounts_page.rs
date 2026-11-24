//! Accounts page logic (apps/desktop/src/screens/shell/AccountsPage.tsx).

use serde::Serialize;

use crate::accounts::{Account, AccountType};
use crate::balance_view::shown_balance;
use crate::goals::trim_js;
use crate::money::{cents_to_fixed2, parse_amount_to_cents};

/// One section of the account list (and one allocation bar).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Group {
    pub title: &'static str,
    pub types: &'static [AccountType],
    pub color: &'static str,
    pub liability: bool,
}

/// `GROUPS`, in page order.
pub const GROUPS: &[Group] = &[
    Group {
        title: "Cash",
        types: &[AccountType::Checking, AccountType::Savings],
        color: "#3ecf8e",
        liability: false,
    },
    Group {
        title: "Investments",
        types: &[AccountType::Investment],
        color: "#6f8ef2",
        liability: false,
    },
    Group {
        title: "Other assets",
        types: &[AccountType::Other],
        color: "#d8b23c",
        liability: false,
    },
    Group {
        title: "Credit cards",
        types: &[AccountType::CreditCard],
        color: "#ec6a9c",
        liability: true,
    },
    Group {
        title: "Loans & mortgages",
        types: &[AccountType::Loan, AccountType::Mortgage],
        color: "#e25c5c",
        liability: true,
    },
];

impl Group {
    pub fn has(&self, account: &Account) -> bool {
        self.types.contains(&account.kind)
    }

    /// The group's accounts, in list order.
    pub fn rows<'a>(&self, accounts: &'a [Account]) -> Vec<&'a Account> {
        accounts.iter().filter(|a| self.has(a)).collect()
    }
}

/// `TYPE_ICONS`.
pub fn type_icon(kind: AccountType) -> &'static str {
    match kind {
        AccountType::Checking | AccountType::CreditCard => "card",
        AccountType::Savings => "bank",
        AccountType::Investment => "invest",
        AccountType::Loan => "receipt",
        AccountType::Mortgage => "home",
        AccountType::Other => "wallet",
    }
}

/// The header cards. Liabilities are stored negative, so they add straight
/// into net worth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub assets: i64,
    pub liabilities: i64,
    pub net_worth: i64,
}

impl Stats {
    pub fn new(accounts: &[Account]) -> Self {
        let sum = |liability: bool| -> i64 {
            accounts
                .iter()
                .filter(|a| a.is_liability == liability)
                .map(|a| a.balance_cents)
                .sum()
        };
        let (assets, liabilities) = (sum(false), sum(true));
        Stats {
            assets,
            liabilities,
            net_worth: assets + liabilities,
        }
    }
}

/// One allocation bar.
#[derive(Debug, Clone, PartialEq)]
pub struct AllocRow {
    pub title: &'static str,
    pub color: &'static str,
    pub subtotal: i64,
}

/// Per-group subtotals, split into the asset bars (groups above zero) and
/// liability bars (groups below zero, as magnitudes).
pub fn allocation(accounts: &[Account]) -> (Vec<AllocRow>, Vec<AllocRow>) {
    let rows = GROUPS.iter().map(|g| {
        let subtotal: i64 = g.rows(accounts).iter().map(|a| a.balance_cents).sum();
        (g, subtotal)
    });
    let mut assets = Vec::new();
    let mut liabilities = Vec::new();
    for (g, subtotal) in rows {
        let row = |subtotal| AllocRow {
            title: g.title,
            color: g.color,
            subtotal,
        };
        if !g.liability && subtotal > 0 {
            assets.push(row(subtotal));
        } else if g.liability && subtotal < 0 {
            liabilities.push(row(subtotal.abs()));
        }
    }
    (assets, liabilities)
}

/// `r.subtotal / total` (0 when there's no total).
pub fn share(part: i64, total: i64) -> f64 {
    if total > 0 {
        part as f64 / total as f64
    } else {
        0.0
    }
}

/// Money set aside across all accounts.
pub fn total_set_aside(accounts: &[Account]) -> i64 {
    accounts
        .iter()
        .map(|a| a.set_aside_cents.unwrap_or(0))
        .sum()
}

/// Accounts the list shows: a zero balance hides an account.
pub fn visible(accounts: &[Account]) -> Vec<Account> {
    accounts
        .iter()
        .filter(|a| a.balance_cents != 0)
        .cloned()
        .collect()
}

/// A group's subtotal in the current balance view.
pub fn shown_subtotal(rows: &[&Account], show_actual: bool) -> i64 {
    rows.iter().map(|a| shown_balance(a, show_actual)).sum()
}

/// Net-worth change over the trend (last − first) and that change as a
/// percentage of the first point; both 0 under two points.
pub fn trend_change(history: &[i64]) -> (i64, f64) {
    if history.len() < 2 {
        return (0, 0.0);
    }
    let first = history[0];
    let change = history[history.len() - 1] - first;
    let base = if first == 0 { 1 } else { first.abs() };
    (change, change as f64 / base as f64 * 100.0)
}

/// "Checking · First Bank · ••4821": type, then institution and mask when
/// they're non-empty.
pub fn meta_line(account: &Account) -> String {
    let mut parts = vec![account.kind.label().to_string()];
    if let Some(i) = account.institution.as_deref().filter(|s| !s.is_empty()) {
        parts.push(i.to_string());
    }
    if let Some(m) = account.mask.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("••{m}"));
    }
    parts.join(" · ")
}

/// The balance cell's tooltip: one "Name: $12.00" line per set-aside.
pub fn set_aside_title(account: &Account, format: impl Fn(i64) -> String) -> Option<String> {
    let list = account.set_aside.as_ref().filter(|l| !l.is_empty())?;
    Some(
        list.iter()
            .map(|p| format!("{}: {}", p.name, format(p.cents)))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// `replace(/\D/g, "")` for the last-4 field.
pub fn digits_only(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Body of `createAccount` / `updateAccount`. Empty institution and mask go
/// over as `null` (the update is a PATCH, so null clears them).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPayload {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: AccountType,
    pub institution: Option<String>,
    pub mask: Option<String>,
    pub balance_cents: i64,
}

/// The account dialog's fields, as typed.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountForm {
    pub name: String,
    pub kind: AccountType,
    pub institution: String,
    pub mask: String,
    pub balance: String,
}

impl AccountForm {
    pub fn new(account: Option<&Account>) -> Self {
        match account {
            None => AccountForm {
                name: String::new(),
                kind: AccountType::Checking,
                institution: String::new(),
                mask: String::new(),
                balance: "0.00".into(),
            },
            Some(a) => AccountForm {
                name: a.name.clone(),
                kind: a.kind,
                institution: a.institution.clone().unwrap_or_default(),
                mask: a.mask.clone().unwrap_or_default(),
                balance: cents_to_fixed2(a.balance_cents),
            },
        }
    }

    /// Whether the balance field holds an amount (otherwise it shows an
    /// error).
    pub fn balance_ok(&self) -> bool {
        parse_amount_to_cents(&self.balance).is_some()
    }

    /// The request body, or `None` while Save is disabled: a name and a
    /// parseable balance.
    pub fn payload(&self) -> Option<AccountPayload> {
        let balance_cents = parse_amount_to_cents(&self.balance)?;
        let name = trim_js(&self.name);
        if name.is_empty() {
            return None;
        }
        let opt = |s: &str| {
            let t = trim_js(s);
            (!t.is_empty()).then(|| t.to_string())
        };
        Some(AccountPayload {
            name: name.to_string(),
            kind: self.kind,
            institution: opt(&self.institution),
            mask: opt(&self.mask),
            balance_cents,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{tests::SAMPLE, AccountListResponse};

    fn sample() -> Vec<Account> {
        serde_json::from_str::<AccountListResponse>(SAMPLE)
            .unwrap()
            .accounts
    }

    fn acct(kind: AccountType, cents: i64) -> Account {
        let mut a = sample()[1].clone();
        a.kind = kind;
        a.is_liability = kind.is_liability_type();
        a.balance_cents = cents;
        a
    }

    #[test]
    fn stats_add_negative_liabilities() {
        let s = Stats::new(&sample());
        assert_eq!(s.assets, 482150 + 1250000);
        assert_eq!(s.liabilities, -184033);
        assert_eq!(s.net_worth, 482150 + 1250000 - 184033);
    }

    #[test]
    fn allocation_keeps_group_order_and_sign() {
        let accounts = vec![
            acct(AccountType::Mortgage, -30000000),
            acct(AccountType::Investment, 500000),
            acct(AccountType::Checking, 1000),
            acct(AccountType::Other, -50), // negative asset group: no bar
            acct(AccountType::CreditCard, 2000), // card in credit: no bar
            acct(AccountType::Loan, -100000),
        ];
        let (assets, liabilities) = allocation(&accounts);
        let titles: Vec<_> = assets.iter().map(|r| r.title).collect();
        assert_eq!(titles, ["Cash", "Investments"]);
        assert_eq!(assets[0].subtotal, 1000);
        assert_eq!(liabilities.len(), 1);
        assert_eq!(liabilities[0].title, "Loans & mortgages");
        assert_eq!(liabilities[0].subtotal, 30100000);
        assert_eq!(liabilities[0].color, "#e25c5c");
    }

    #[test]
    fn shares() {
        assert_eq!(share(1, 4), 0.25);
        assert_eq!(share(1, 0), 0.0);
        assert_eq!(share(1, -5), 0.0);
    }

    #[test]
    fn groups_cover_every_type_once() {
        for kind in AccountType::ALL {
            assert_eq!(GROUPS.iter().filter(|g| g.types.contains(&kind)).count(), 1);
        }
        let a = sample();
        let cash = GROUPS[0].rows(&a);
        assert_eq!(cash.len(), 2);
        assert_eq!(shown_subtotal(&cash, true), 482150 + 1250000);
        assert_eq!(shown_subtotal(&cash, false), 482150 - 60000 + 1250000);
    }

    #[test]
    fn set_aside_total_and_hidden_zeros() {
        let mut a = sample();
        assert_eq!(total_set_aside(&a), 60000);
        a[1].balance_cents = 0;
        let v = visible(&a);
        assert_eq!(v.len(), 2);
        assert!(v.iter().all(|x| x.balance_cents != 0));
    }

    #[test]
    fn trend_change_matches_js() {
        assert_eq!(trend_change(&[]), (0, 0.0));
        assert_eq!(trend_change(&[100]), (0, 0.0));
        assert_eq!(trend_change(&[200, 250, 300]), (100, 50.0));
        // Negative start: the percentage is of its magnitude.
        assert_eq!(trend_change(&[-200, -100]), (100, 50.0));
        // Zero start divides by 1 (`|| 1`).
        assert_eq!(trend_change(&[0, 5]), (5, 500.0));
    }

    #[test]
    fn meta_lines() {
        let a = sample();
        assert_eq!(meta_line(&a[0]), "Checking · First Bank · ••4821");
        assert_eq!(meta_line(&a[1]), "Savings");
        let mut c = a[2].clone();
        c.institution = Some(String::new());
        assert_eq!(meta_line(&c), "Credit card · ••0042");
    }

    #[test]
    fn set_aside_tooltip() {
        let a = sample();
        let f = |c: i64| format!("${}", cents_to_fixed2(c));
        assert_eq!(set_aside_title(&a[0], f).as_deref(), Some("Rent: $600.00"));
        assert_eq!(set_aside_title(&a[1], f), None);
        assert_eq!(set_aside_title(&a[2], f), None);
    }

    #[test]
    fn mask_digits() {
        assert_eq!(digits_only("12a3-4"), "1234");
        assert_eq!(digits_only("٣4"), "4");
    }

    #[test]
    fn form_round_trip() {
        let a = sample();
        let f = AccountForm::new(Some(&a[2]));
        assert_eq!(f.balance, "-1840.33");
        assert_eq!(f.kind, AccountType::CreditCard);
        let p = f.payload().unwrap();
        assert_eq!(p.balance_cents, -184033);
        assert_eq!(p.mask.as_deref(), Some("0042"));
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["type"], "credit_card");
        assert_eq!(json["balanceCents"], -184033);

        let mut new = AccountForm::new(None);
        assert_eq!(new.balance, "0.00");
        assert_eq!(new.payload(), None); // no name yet
        new.name = "  Joint  ".into();
        new.institution = "   ".into();
        let p = new.payload().unwrap();
        assert_eq!(p.name, "Joint");
        assert_eq!(p.institution, None);
        let json = serde_json::to_value(&p).unwrap();
        assert!(json["institution"].is_null() && json["mask"].is_null());
        new.balance = "12.345".into();
        assert!(!new.balance_ok());
        assert_eq!(new.payload(), None);
    }
}
