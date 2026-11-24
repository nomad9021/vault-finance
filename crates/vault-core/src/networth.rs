//! Net Worth page logic (apps/desktop/src/screens/shell/NetWorthPage.tsx).

use crate::accounts::{Account, AccountType};

/// Assets vs liabilities split of the account list.
#[derive(Debug, Clone, PartialEq)]
pub struct NetWorth {
    pub assets: Vec<Account>,
    pub liabilities: Vec<Account>,
    pub asset_total: i64,
    /// Liability balances are stored negative; owed is the magnitude.
    pub owed_total: i64,
}

impl NetWorth {
    pub fn new(accounts: &[Account]) -> Self {
        let (liabilities, assets): (Vec<_>, Vec<_>) =
            accounts.iter().cloned().partition(|a| a.is_liability);
        let asset_total = assets.iter().map(|a| a.balance_cents).sum();
        let owed_total = liabilities.iter().map(|a| a.balance_cents.abs()).sum();
        Self {
            assets,
            liabilities,
            asset_total,
            owed_total,
        }
    }

    pub fn net(&self) -> i64 {
        self.asset_total - self.owed_total
    }
}

/// Change over the whole series (last − first) and over the last month
/// (last − previous); 0 when there aren't enough points.
pub fn changes(history: &[i64]) -> (i64, i64) {
    let n = history.len();
    let change = if n >= 1 {
        history[n - 1] - history[0]
    } else {
        0
    };
    let month = if n >= 2 {
        history[n - 1] - history[n - 2]
    } else {
        0
    };
    (change, month)
}

/// One account type on a breakdown panel.
#[derive(Debug, Clone, PartialEq)]
pub struct TypeGroup {
    pub kind: AccountType,
    /// Largest balance (by magnitude) first.
    pub list: Vec<Account>,
    /// Sum of balance magnitudes.
    pub total: i64,
}

/// Groups by type in first-seen order, then sorts groups by total, largest
/// first. Both sorts are stable, like `Array.prototype.sort`.
pub fn group_by_type(accounts: &[Account]) -> Vec<TypeGroup> {
    let mut groups: Vec<TypeGroup> = Vec::new();
    for a in accounts {
        match groups.iter_mut().find(|g| g.kind == a.kind) {
            Some(g) => g.list.push(a.clone()),
            None => groups.push(TypeGroup {
                kind: a.kind,
                list: vec![a.clone()],
                total: 0,
            }),
        }
    }
    for g in &mut groups {
        g.list
            .sort_by_key(|a| std::cmp::Reverse(a.balance_cents.abs()));
        g.total = g.list.iter().map(|a| a.balance_cents.abs()).sum();
    }
    groups.sort_by_key(|g| std::cmp::Reverse(g.total));
    groups
}

/// Bar width as the CSS percentage string React builds with
/// `${total > 0 ? (part / total) * 100 : 0}%`.
pub fn share_percent(part: i64, total: i64) -> String {
    let pct = if total > 0 {
        part as f64 / total as f64 * 100.0
    } else {
        0.0
    };
    format!("{pct}%")
}

pub fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{tests::SAMPLE, AccountListResponse};

    fn acct(id: &str, kind: AccountType, cents: i64, liability: bool) -> Account {
        let mut a = sample()[0].clone();
        a.id = id.into();
        a.kind = kind;
        a.balance_cents = cents;
        a.is_liability = liability;
        a
    }

    fn sample() -> Vec<Account> {
        serde_json::from_str::<AccountListResponse>(SAMPLE)
            .unwrap()
            .accounts
    }

    #[test]
    fn totals() {
        let nw = NetWorth::new(&sample());
        assert_eq!(nw.assets.len(), 2);
        assert_eq!(nw.liabilities.len(), 1);
        assert_eq!(nw.asset_total, 482150 + 1250000);
        assert_eq!(nw.owed_total, 184033);
        assert_eq!(nw.net(), 482150 + 1250000 - 184033);
    }

    #[test]
    fn change_maths() {
        assert_eq!(changes(&[]), (0, 0));
        assert_eq!(changes(&[5]), (0, 0));
        assert_eq!(changes(&[10, 30, 25]), (15, -5));
    }

    #[test]
    fn groups_sorted_stably() {
        let accounts = vec![
            acct("a", AccountType::Checking, 100, false),
            acct("b", AccountType::Savings, 300, false),
            acct("c", AccountType::Checking, 200, false),
            acct("d", AccountType::Investment, 300, false),
            acct("e", AccountType::Checking, -200, false),
        ];
        let g = group_by_type(&accounts);
        let kinds: Vec<_> = g.iter().map(|g| g.kind).collect();
        // Checking 500, then savings/investment tie at 300 in first-seen order.
        assert_eq!(
            kinds,
            [
                AccountType::Checking,
                AccountType::Savings,
                AccountType::Investment
            ]
        );
        assert_eq!(g[0].total, 500);
        let ids: Vec<_> = g[0].list.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["c", "e", "a"]);
    }

    #[test]
    fn percent_strings_match_js() {
        assert_eq!(share_percent(1, 3), "33.33333333333333%");
        assert_eq!(share_percent(5, 5), "100%");
        assert_eq!(share_percent(5, 0), "0%");
        assert_eq!(share_percent(1, 2), "50%");
    }

    #[test]
    fn plurals() {
        assert_eq!(plural(1, "account"), "1 account");
        assert_eq!(plural(0, "account"), "0 accounts");
        assert_eq!(plural(3, "account"), "3 accounts");
    }
}
