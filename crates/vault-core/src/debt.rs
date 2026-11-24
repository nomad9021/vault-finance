//! The "Get out of debt" planner: mirrors packages/shared/src/schemas/debts.ts
//! and the pure parts of apps/desktop/src/screens/shell/DebtCalculator.tsx
//! (the payoff simulation, seeding debts from liability accounts, labels).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::accounts::{Account, AccountType};
use crate::money::js_round;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strategy {
    #[default]
    Avalanche,
    Snowball,
}

impl Strategy {
    /// The wire value, also shown capitalized by CSS in the plan summary.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Avalanche => "avalanche",
            Self::Snowball => "snowball",
        }
    }
}

/// One debt in the planner. Also the wire shape of `ManualDebt`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Debt {
    pub id: String,
    pub name: String,
    pub balance_cents: i64,
    pub apr: f64,
    pub min_cents: i64,
}

/// `DebtOverride` / `Partial<Debt>`: per-account tweaks. Unset fields are
/// left out of the JSON (zod `.optional()` rejects null).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance_cents: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apr: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_cents: Option<i64>,
}

impl DebtPatch {
    /// `{ ...self, ...other }` for the fields `other` sets.
    pub fn merge(&mut self, other: &DebtPatch) {
        if let Some(v) = &other.name {
            self.name = Some(v.clone());
        }
        if let Some(v) = other.balance_cents {
            self.balance_cents = Some(v);
        }
        if let Some(v) = other.apr {
            self.apr = Some(v);
        }
        if let Some(v) = other.min_cents {
            self.min_cents = Some(v);
        }
    }

    pub fn apply(&self, d: &mut Debt) {
        if let Some(v) = &self.name {
            d.name = v.clone();
        }
        if let Some(v) = self.balance_cents {
            d.balance_cents = v;
        }
        if let Some(v) = self.apr {
            d.apr = v;
        }
        if let Some(v) = self.min_cents {
            d.min_cents = v;
        }
    }
}

/// Persisted planner state (`DebtPlan`, also the `updateDebtPlan` body).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPlan {
    pub extra_cents: i64,
    pub strategy: Strategy,
    /// Keyed by liability account id.
    pub overrides: BTreeMap<String, DebtPatch>,
    pub manual: Vec<Debt>,
}

/// Figures are `f64` like the JS numbers they mirror: a debt whose minimum
/// never outruns its interest compounds far past `i64` over the 100-year cap,
/// and the page shows those (absurd) totals exactly as the React page did.
#[derive(Debug, Clone, PartialEq)]
pub struct PayoffResult {
    pub months: u32,
    pub total_interest_cents: f64,
    pub never_payoff: bool,
    /// Total remaining balance at the end of each month (starts with month 0).
    pub trajectory: Vec<f64>,
}

/// Months simulated before a plan counts as never paying off.
pub const CAP: u32 = 1200;

/// Month-by-month simulation: minimums on all debts + extra to the target
/// debt (highest APR first for avalanche, smallest starting balance first for
/// snowball). Same double arithmetic as `simulate` in DebtCalculator.tsx.
pub fn simulate(debts: &[Debt], extra_cents: i64, strategy: Strategy) -> PayoffResult {
    let mut balances: Vec<f64> = debts.iter().map(|d| d.balance_cents as f64).collect();
    let mins: Vec<f64> = debts.iter().map(|d| d.min_cents as f64).collect();
    let mut order: Vec<usize> = (0..debts.len()).collect();
    // Array.prototype.sort is stable, so is sort_by; ties keep list order.
    let by = |x: f64, y: f64| x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal);
    match strategy {
        Strategy::Avalanche => order.sort_by(|&a, &b| by(debts[b].apr, debts[a].apr)),
        Strategy::Snowball => order.sort_by(|&a, &b| by(balances[a], balances[b])),
    }
    let sum = |b: &[f64]| b.iter().fold(0.0, |s, &x| s + x.max(0.0));
    let mut trajectory = vec![sum(&balances)];
    let mut month = 0;
    let mut total_interest = 0.0;
    while balances.iter().any(|&b| b > 0.0) && month < CAP {
        month += 1;
        for (b, d) in balances.iter_mut().zip(debts) {
            if *b <= 0.0 {
                continue;
            }
            let interest = js_round((*b * (d.apr / 100.0)) / 12.0);
            *b += interest;
            total_interest += interest;
        }
        let mut budget = mins
            .iter()
            .zip(&balances)
            .fold(0.0, |s, (&m, &b)| s + if b > 0.0 { m } else { 0.0 })
            + extra_cents as f64;
        for (b, &m) in balances.iter_mut().zip(&mins) {
            if *b <= 0.0 {
                continue;
            }
            let pay = b.min(m);
            *b -= pay;
            budget -= pay;
        }
        for &i in &order {
            if budget <= 0.0 {
                break;
            }
            if balances[i] <= 0.0 {
                continue;
            }
            let pay = balances[i].min(budget);
            balances[i] -= pay;
            budget -= pay;
        }
        trajectory.push(sum(&balances));
    }
    PayoffResult {
        months: month,
        total_interest_cents: total_interest,
        never_payoff: month >= CAP && balances.iter().any(|&b| b > 0.0),
        trajectory,
    }
}

/// `seedDefaults`: APR and minimum guesses for a liability account.
pub fn seed_defaults(a: &Account) -> (f64, i64) {
    let bal = a.balance_cents.unsigned_abs() as f64;
    let at_least = |floor: i64, share: f64| floor.max(js_round(bal * share) as i64);
    match a.kind {
        AccountType::CreditCard => (22.0, at_least(2500, 0.02)),
        AccountType::Mortgage => (6.5, at_least(50000, 0.005)),
        _ => (8.0, at_least(5000, 0.01)),
    }
}

/// Liability accounts with a balance: the planner seeds a debt from each.
pub fn liabilities(accounts: &[Account]) -> Vec<&Account> {
    accounts
        .iter()
        .filter(|a| a.is_liability && a.balance_cents != 0)
        .collect()
}

/// The planner's debt list: liabilities (with any overrides) then manual ones.
pub fn build_debts(
    liabilities: &[&Account],
    overrides: &BTreeMap<String, DebtPatch>,
    manual: &[Debt],
) -> Vec<Debt> {
    liabilities
        .iter()
        .map(|a| {
            let (apr, min_cents) = seed_defaults(a);
            let mut d = Debt {
                id: a.id.clone(),
                name: a.name.clone(),
                balance_cents: a.balance_cents.abs(),
                apr,
                min_cents,
            };
            if let Some(o) = overrides.get(&a.id) {
                o.apply(&mut d);
            }
            d
        })
        .chain(manual.iter().cloned())
        .collect()
}

/// `monthsLabel`: "7 mo", "2 yr", "1 yr 3 mo".
pub fn months_label(m: u32) -> String {
    let (y, mo) = (m / 12, m % 12);
    if y == 0 {
        format!("{mo} mo")
    } else if mo == 0 {
        format!("{y} yr")
    } else {
        format!("{y} yr {mo} mo")
    }
}

/// The extra-payment field's text for a saved plan:
/// `(extraCents / 100).toFixed(extraCents % 100 === 0 ? 0 : 2)`.
pub fn extra_input(extra_cents: i64) -> String {
    let sign = if extra_cents < 0 { "-" } else { "" };
    let abs = extra_cents.unsigned_abs();
    if abs.is_multiple_of(100) {
        format!("{sign}{}", abs / 100)
    } else {
        format!("{sign}{}.{:02}", abs / 100, abs % 100)
    }
}

/// The APR field: `Number(value.replace(/[^0-9.]/g, "")) || 0`.
pub fn parse_apr(input: &str) -> f64 {
    let kept: String = input
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if kept.is_empty() {
        return 0.0;
    }
    match kept.parse::<f64>() {
        Ok(v) if v.is_finite() => v,
        _ => 0.0,
    }
}

/// `String(apr)` for the APR field. Rust's shortest round-trip float text
/// matches JS for everything an APR field holds (no exponents below 1e21).
pub fn apr_text(apr: f64) -> String {
    if apr == 0.0 {
        "0".into()
    } else {
        format!("{apr}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card() -> Debt {
        Debt {
            id: "a".into(),
            name: "Card".into(),
            balance_cents: 100_000,
            apr: 24.0,
            min_cents: 5_000,
        }
    }
    fn with(balance_cents: i64, apr: f64, min_cents: i64) -> Debt {
        Debt {
            balance_cents,
            apr,
            min_cents,
            ..card()
        }
    }

    // ── DebtCalculator.test.ts: "simulate: basic mechanics" ──

    #[test]
    fn pays_off_zero_interest_debt_in_balance_over_payment_months() {
        let r = simulate(&[with(100_000, 0.0, 10_000)], 0, Strategy::Avalanche);
        assert_eq!(r.months, 10);
        assert_eq!(r.total_interest_cents, 0.0);
        assert!(!r.never_payoff);
    }

    #[test]
    fn charges_interest_on_a_carried_balance() {
        let r = simulate(&[with(100_000, 12.0, 10_000)], 0, Strategy::Avalanche);
        assert!(r.total_interest_cents > 0.0);
        assert!(r.total_interest_cents < 12_000.0);
        assert!(r.months > 10);
    }

    #[test]
    fn flags_a_debt_whose_minimum_cannot_outrun_its_interest() {
        let r = simulate(&[with(1_000_000, 24.0, 5_000)], 0, Strategy::Avalanche);
        assert!(r.never_payoff);
    }

    #[test]
    fn applies_extra_payment_to_shorten_the_schedule() {
        let d = Debt {
            min_cents: 10_000,
            ..card()
        };
        let base = simulate(std::slice::from_ref(&d), 0, Strategy::Avalanche);
        let extra = simulate(&[d], 10_000, Strategy::Avalanche);
        assert!(extra.months < base.months);
        assert!(extra.total_interest_cents < base.total_interest_cents);
    }

    #[test]
    fn trajectory_starts_at_total_and_ends_at_zero() {
        let r = simulate(&[with(60_000, 0.0, 10_000)], 0, Strategy::Avalanche);
        assert_eq!(r.trajectory[0], 60_000.0);
        assert_eq!(*r.trajectory.last().unwrap(), 0.0);
        for w in r.trajectory.windows(2) {
            assert!(w[1] <= w[0]);
        }
    }

    // ── "simulate: strategy ordering" ──

    fn two_debts() -> Vec<Debt> {
        vec![
            Debt {
                id: "big-low".into(),
                name: "Loan".into(),
                balance_cents: 500_000,
                apr: 5.0,
                min_cents: 10_000,
            },
            Debt {
                id: "small-high".into(),
                name: "Card".into(),
                balance_cents: 100_000,
                apr: 25.0,
                min_cents: 5_000,
            },
        ]
    }

    #[test]
    fn avalanche_costs_no_more_interest_than_snowball() {
        let av = simulate(&two_debts(), 50_000, Strategy::Avalanche);
        let sb = simulate(&two_debts(), 50_000, Strategy::Snowball);
        assert!(av.total_interest_cents <= sb.total_interest_cents);
    }

    #[test]
    fn extra_clears_debts_no_later_than_minimums() {
        let minimums = simulate(&two_debts(), 0, Strategy::Avalanche);
        let av = simulate(&two_debts(), 50_000, Strategy::Avalanche);
        assert!(av.months <= minimums.months);
    }

    // ── "simulate: edge cases" ──

    #[test]
    fn handles_an_empty_debt_list() {
        let r = simulate(&[], 0, Strategy::Avalanche);
        assert_eq!(r.months, 0);
        assert_eq!(r.total_interest_cents, 0.0);
        assert!(!r.never_payoff);
    }

    #[test]
    fn treats_an_already_cleared_debt_as_done() {
        let r = simulate(&[with(0, 24.0, 5_000)], 0, Strategy::Avalanche);
        assert_eq!(r.months, 0);
        assert!(!r.never_payoff);
    }

    // ── Exact figures, recorded from the TypeScript `simulate` (vitest) ──

    fn rec(r: &PayoffResult) -> (u32, f64, bool, usize, Vec<f64>) {
        (
            r.months,
            r.total_interest_cents,
            r.never_payoff,
            r.trajectory.len(),
            r.trajectory[..4.min(r.trajectory.len())].to_vec(),
        )
    }

    #[test]
    fn matches_typescript_figures() {
        let r = simulate(&[with(100_000, 12.0, 10_000)], 0, Strategy::Avalanche);
        let one = (
            11,
            5_898.0,
            false,
            12,
            vec![100_000.0, 91_000.0, 81_910.0, 72_729.0],
        );
        assert_eq!(rec(&r), one);
        let two = (
            11,
            16_305.0,
            false,
            12,
            vec![600_000.0, 539_166.0, 477_197.0, 419_185.0],
        );
        assert_eq!(
            rec(&simulate(&two_debts(), 50_000, Strategy::Avalanche)),
            two
        );
        assert_eq!(
            rec(&simulate(&two_debts(), 50_000, Strategy::Snowball)),
            two
        );
        let min = (
            56,
            92_002.0,
            false,
            57,
            vec![600_000.0, 589_166.0, 578_239.0, 567_217.0],
        );
        assert_eq!(rec(&simulate(&two_debts(), 0, Strategy::Avalanche)), min);
        assert_eq!(rec(&simulate(&two_debts(), 0, Strategy::Snowball)), min);
        let three = [
            with(250_000, 19.99, 7_500),
            with(80_000, 29.5, 2_500),
            with(1_200_000, 6.9, 32_000),
        ];
        let three_out = (
            25,
            129_704.0,
            false,
            26,
            vec![1_530_000.0, 1_467_699.0, 1_404_365.0, 1_339_977.0],
        );
        assert_eq!(
            rec(&simulate(&three, 33_333, Strategy::Snowball)),
            three_out
        );
        assert_eq!(
            rec(&simulate(&three, 33_333, Strategy::Avalanche)),
            three_out
        );
        // Never pays off: past 2^53 the figures are inexact doubles, the same
        // inexact doubles as JS.
        let r = simulate(&[with(1_000_000, 24.0, 5_000)], 0, Strategy::Avalanche);
        let never = (
            1200,
            15_677_142_742_188_256.0,
            true,
            1201,
            vec![1_000_000.0, 1_015_000.0, 1_030_300.0, 1_045_906.0],
        );
        assert_eq!(rec(&r), never);
        assert_eq!(r.trajectory[1200], 15_677_142_737_188_256.0);
        // 65% APR on $4,200 with a $60.18 minimum compounds to ~1e33: the
        // figure the React page prints as "save $9,570,902,…".
        let hot = simulate(&[with(420_000, 65.0, 6_018)], 0, Strategy::Snowball);
        assert_eq!((hot.months, hot.never_payoff), (1200, true));
        assert_eq!(hot.total_interest_cents, 9.57090214022184e32);
        assert_eq!(hot.trajectory[600], 17_194_327_607_190_899_000.0);
        assert_eq!(hot.trajectory[1200], 9.57090214022184e32);
    }

    // ── Seeding and labels ──

    fn account(kind: AccountType, balance_cents: i64) -> Account {
        Account {
            id: "acc".into(),
            name: "Visa".into(),
            kind,
            is_liability: true,
            balance_cents,
            ..Account::sample()
        }
    }

    #[test]
    fn seed_defaults_by_type() {
        assert_eq!(
            seed_defaults(&account(AccountType::CreditCard, -50_000)),
            (22.0, 2500)
        );
        assert_eq!(
            seed_defaults(&account(AccountType::CreditCard, -500_000)),
            (22.0, 10_000)
        );
        assert_eq!(
            seed_defaults(&account(AccountType::Mortgage, -30_000_000)),
            (6.5, 150_000)
        );
        assert_eq!(
            seed_defaults(&account(AccountType::Loan, -1_000_000)),
            (8.0, 10_000)
        );
        assert_eq!(
            seed_defaults(&account(AccountType::Other, -100)),
            (8.0, 5000)
        );
    }

    #[test]
    fn build_debts_applies_overrides_then_appends_manual() {
        let a = account(AccountType::CreditCard, -123_456);
        let mut overrides = BTreeMap::new();
        overrides.insert(
            "acc".to_string(),
            DebtPatch {
                apr: Some(19.9),
                ..Default::default()
            },
        );
        let manual = vec![card()];
        let debts = build_debts(&[&a], &overrides, &manual);
        assert_eq!(debts.len(), 2);
        assert_eq!(debts[0].balance_cents, 123_456);
        assert_eq!(debts[0].apr, 19.9);
        assert_eq!(debts[0].min_cents, 2_500); // max(2500, round(123456 * 0.02))
        assert_eq!(debts[0].name, "Visa");
        assert_eq!(debts[1], card());
    }

    #[test]
    fn liabilities_skip_assets_and_zero_balances() {
        let mut asset = account(AccountType::Checking, 5_000);
        asset.is_liability = false;
        let zero = account(AccountType::CreditCard, 0);
        let owing = account(AccountType::CreditCard, -1);
        let all = [asset, zero, owing];
        assert_eq!(liabilities(&all).len(), 1);
    }

    #[test]
    fn labels() {
        assert_eq!(months_label(0), "0 mo");
        assert_eq!(months_label(7), "7 mo");
        assert_eq!(months_label(24), "2 yr");
        assert_eq!(months_label(15), "1 yr 3 mo");
        assert_eq!(extra_input(20_000), "200");
        assert_eq!(extra_input(2_050), "20.50");
        assert_eq!(extra_input(5), "0.05");
        assert_eq!(parse_apr("22"), 22.0);
        assert_eq!(parse_apr("6.5%"), 6.5);
        assert_eq!(parse_apr("6."), 6.0);
        assert_eq!(parse_apr(".5"), 0.5);
        assert_eq!(parse_apr(""), 0.0);
        assert_eq!(parse_apr("."), 0.0);
        assert_eq!(parse_apr("1.2.3"), 0.0);
        assert_eq!(apr_text(22.0), "22");
        assert_eq!(apr_text(6.5), "6.5");
        assert_eq!(apr_text(0.0), "0");
    }

    #[test]
    fn plan_round_trips_the_wire_shape() {
        let json = r#"{"extraCents":20000,"strategy":"snowball",
          "overrides":{"9b2e4f7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b":{"apr":19.99,"minCents":3500}},
          "manual":[{"id":"manual-1732400000000","name":"Car loan","balanceCents":850000,"apr":6.9,"minCents":32000}]}"#;
        let p: DebtPlan = serde_json::from_str(json).unwrap();
        assert_eq!(p.strategy, Strategy::Snowball);
        assert_eq!(p.manual[0].name, "Car loan");
        let o = &p.overrides["9b2e4f7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b"];
        assert_eq!(
            (o.apr, o.min_cents, o.name.as_ref()),
            (Some(19.99), Some(3500), None)
        );
        let out = serde_json::to_string(&p).unwrap();
        assert!(out.contains(r#"{"apr":19.99,"minCents":3500}"#), "{out}");
        assert_eq!(serde_json::from_str::<DebtPlan>(&out).unwrap(), p);
    }
}
