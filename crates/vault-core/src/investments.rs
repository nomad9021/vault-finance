//! Mirrors packages/shared/src/schemas/investments.ts, plus the summary and
//! holding-dialog logic of apps/desktop/src/screens/shell/InvestmentsPage.tsx.

use serde::{Deserialize, Serialize};

use crate::goals::trim_js;
use crate::money::{cents_to_fixed2, parse_amount_to_cents, to_fixed};

/// Allocation bar colours, cycled by slice index.
pub const SLICE_COLORS: [&str; 6] = [
    "#6f8ef2", "#43cfc0", "#b47ef0", "#d8b23c", "#ec6a9c", "#9aa0ab",
];

/// One position. Values are user-entered: no market-data feeds.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub id: String,
    pub account_id: String,
    pub symbol: String,
    pub name: Option<String>,
    /// Decimal text, up to 6 places ("10.5").
    pub quantity: String,
    pub cost_basis_cents: Option<i64>,
    pub market_value_cents: i64,
    /// "YYYY-MM-DD".
    pub as_of_date: String,
}

impl Holding {
    /// Unrealized gain, when a cost basis was entered.
    pub fn gain_cents(&self) -> Option<i64> {
        self.cost_basis_cents.map(|c| self.market_value_cents - c)
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentAccount {
    pub id: String,
    pub name: String,
    pub institution: Option<String>,
    /// Sum of the holdings' market values.
    pub holdings_value_cents: i64,
    pub cost_basis_cents: i64,
    pub holdings: Vec<Holding>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationSlice {
    pub symbol: String,
    pub name: Option<String>,
    pub value_cents: i64,
    /// 0–1 share of total holdings value.
    pub share: f64,
}

impl AllocationSlice {
    /// `(share * 100).toFixed(1)`.
    pub fn percent_label(&self) -> String {
        to_fixed(self.share * 100.0, 1)
    }

    /// The bar segment's CSS width: `${share * 100}%`.
    pub fn width(&self) -> String {
        format!("{}%", js_number(self.share * 100.0))
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentsResponse {
    pub accounts: Vec<InvestmentAccount>,
    pub total_value_cents: i64,
    pub total_cost_basis_cents: i64,
    pub allocation: Vec<AllocationSlice>,
}

impl InvestmentsResponse {
    pub fn gain_cents(&self) -> i64 {
        self.total_value_cents - self.total_cost_basis_cents
    }

    /// The "Unrealized gain" sub line: "+12.3%", or "—" with no cost basis.
    pub fn gain_percent_label(&self) -> String {
        if self.total_cost_basis_cents <= 0 {
            return "—".into();
        }
        let pct = self.gain_cents() as f64 / self.total_cost_basis_cents as f64 * 100.0;
        format!("{}{}%", if pct >= 0.0 { "+" } else { "" }, to_fixed(pct, 1))
    }
}

/// `String(x)` for the plain numbers a CSS width takes: shortest round-trip
/// digits, exponent form below 1e-6 like JS.
fn js_number(x: f64) -> String {
    if x != 0.0 && x.abs() < 1e-6 {
        format!("{x:e}")
    } else {
        format!("{x}")
    }
}

/// Body of `createHolding` / `updateHolding` (the update sends every field).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingPayload {
    pub symbol: String,
    pub name: Option<String>,
    pub quantity: String,
    pub cost_basis_cents: Option<i64>,
    pub market_value_cents: i64,
}

/// The holding dialog's fields, as typed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HoldingForm {
    pub symbol: String,
    pub name: String,
    pub quantity: String,
    pub cost_basis: String,
    pub value: String,
}

impl HoldingForm {
    /// Starting values: the holding's own, or blanks.
    pub fn new(holding: Option<&Holding>) -> Self {
        match holding {
            None => HoldingForm::default(),
            Some(h) => HoldingForm {
                symbol: h.symbol.clone(),
                name: h.name.clone().unwrap_or_default(),
                quantity: h.quantity.clone(),
                cost_basis: h.cost_basis_cents.map(cents_to_fixed2).unwrap_or_default(),
                value: cents_to_fixed2(h.market_value_cents),
            },
        }
    }

    /// Error under "Current value": text typed that isn't a non-negative amount.
    pub fn value_error(&self) -> Option<&'static str> {
        let bad = !matches!(parse_amount_to_cents(&self.value), Some(c) if c >= 0);
        (!self.value.is_empty() && bad).then_some("Enter an amount like 2600.00")
    }

    /// The request body, or `None` while Save is disabled: a symbol, a
    /// quantity like `10.5` (≤ 6 places), a non-negative value, and a cost
    /// basis that is blank or an amount.
    pub fn payload(&self) -> Option<HoldingPayload> {
        let symbol = trim_js(&self.symbol);
        let quantity = trim_js(&self.quantity);
        let market_value_cents = parse_amount_to_cents(&self.value).filter(|c| *c >= 0)?;
        let cost_basis_cents = if self.cost_basis.is_empty() {
            None
        } else {
            Some(parse_amount_to_cents(&self.cost_basis)?)
        };
        if symbol.is_empty() || !valid_quantity(quantity) {
            return None;
        }
        let name = trim_js(&self.name);
        Some(HoldingPayload {
            symbol: symbol.to_string(),
            name: (!name.is_empty()).then(|| name.to_string()),
            quantity: quantity.to_string(),
            cost_basis_cents,
            market_value_cents,
        })
    }
}

/// `/^\d+(\.\d{1,6})?$/` (ASCII digits).
fn valid_quantity(q: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match q.split_once('.') {
        None => digits(q),
        Some((w, f)) => digits(w) && digits(f) && f.len() <= 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "accounts": [
        {
          "id": "0f8b6a1e-3c2d-4e5f-9a1b-2c3d4e5f6a7b",
          "name": "Brokerage",
          "institution": "Fidelity",
          "holdingsValueCents": 4540000,
          "costBasisCents": 3800000,
          "holdings": [
            {"id":"6a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d","accountId":"0f8b6a1e-3c2d-4e5f-9a1b-2c3d4e5f6a7b",
             "symbol":"VTI","name":"Total Market ETF","quantity":"120.5",
             "costBasisCents":3800000,"marketValueCents":4200000,"asOfDate":"2026-11-01"},
            {"id":"7b2c3d4e-5f6a-4b8c-9d0e-1f2a3b4c5d6e","accountId":"0f8b6a1e-3c2d-4e5f-9a1b-2c3d4e5f6a7b",
             "symbol":"BND","name":null,"quantity":"40",
             "costBasisCents":null,"marketValueCents":340000,"asOfDate":"2026-10-15"}
          ]
        },
        {
          "id": "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
          "name": "Roth IRA",
          "institution": null,
          "holdingsValueCents": 0,
          "costBasisCents": 0,
          "holdings": []
        }
      ],
      "totalValueCents": 4540000,
      "totalCostBasisCents": 3800000,
      "allocation": [
        {"symbol":"VTI","name":"Total Market ETF","valueCents":4200000,"share":0.9251101321585903},
        {"symbol":"BND","name":null,"valueCents":340000,"share":0.07488986784140969}
      ]
    }"#;

    fn sample() -> InvestmentsResponse {
        serde_json::from_str(SAMPLE).unwrap()
    }

    #[test]
    fn parses_server_shape() {
        let r = sample();
        assert_eq!(r.accounts.len(), 2);
        assert_eq!(r.accounts[0].institution.as_deref(), Some("Fidelity"));
        assert_eq!(r.accounts[1].institution, None);
        let h = &r.accounts[0].holdings;
        assert_eq!(h[0].quantity, "120.5");
        assert_eq!(h[1].name, None);
        assert_eq!(h[1].cost_basis_cents, None);
        assert_eq!(h[0].as_of_date, "2026-11-01");
        assert_eq!(r.allocation[1].value_cents, 340_000);
    }

    #[test]
    fn summary_numbers() {
        let mut r = sample();
        assert_eq!(r.gain_cents(), 740_000);
        assert_eq!(r.gain_percent_label(), "+19.5%");
        assert_eq!(r.accounts[0].holdings[0].gain_cents(), Some(400_000));
        assert_eq!(r.accounts[0].holdings[1].gain_cents(), None);
        assert_eq!(r.allocation[0].percent_label(), "92.5");
        assert_eq!(r.allocation[1].percent_label(), "7.5");
        // serde_json's float parsing isn't exactly rounded; in the app the
        // share arrives as a JS number, so check the formatting on a literal.
        // JS: `${0.9251101321585903 * 100}%`.
        r.allocation[0].share = 0.9251101321585903;
        assert_eq!(r.allocation[0].width(), "92.51101321585902%");
        r.allocation[0].share = 1.0;
        assert_eq!(r.allocation[0].width(), "100%");
        r.allocation[0].share = 1e-9;
        assert_eq!(r.allocation[0].width(), "1.0000000000000001e-7%");
        r.total_value_cents = 3_000_000;
        assert_eq!(r.gain_percent_label(), "-21.1%");
        r.total_value_cents = 3_800_000;
        assert_eq!(r.gain_percent_label(), "+0.0%");
        r.total_cost_basis_cents = 0;
        assert_eq!(r.gain_percent_label(), "—");
    }

    #[test]
    fn form_starts_from_the_holding() {
        let r = sample();
        let f = HoldingForm::new(Some(&r.accounts[0].holdings[0]));
        assert_eq!(f.cost_basis, "38000.00");
        assert_eq!(f.value, "42000.00");
        let f = HoldingForm::new(Some(&r.accounts[0].holdings[1]));
        assert_eq!(f.name, "");
        assert_eq!(f.cost_basis, "");
        assert_eq!(HoldingForm::new(None), HoldingForm::default());
        assert_eq!(HoldingForm::default().payload(), None);
        assert_eq!(HoldingForm::default().value_error(), None);
    }

    #[test]
    fn form_validation_and_payload() {
        let mut f = HoldingForm {
            symbol: " VTI ".into(),
            name: "  ".into(),
            quantity: " 10.5 ".into(),
            cost_basis: String::new(),
            value: "2,600".into(),
        };
        let p = f.payload().unwrap();
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"symbol":"VTI","name":null,"quantity":"10.5","costBasisCents":null,"marketValueCents":260000}"#
        );
        f.cost_basis = "2000".into();
        assert_eq!(f.payload().unwrap().cost_basis_cents, Some(200_000));
        f.cost_basis = "abc".into();
        assert_eq!(f.payload(), None);
        f.cost_basis = String::new();
        for bad in ["", "1.", ".5", "1.1234567", "1e3", "-1", "١"] {
            f.quantity = bad.into();
            assert_eq!(f.payload(), None, "{bad}");
        }
        f.quantity = "0.123456".into();
        assert!(f.payload().is_some());
        f.value = "-5".into();
        assert_eq!(f.payload(), None);
        assert_eq!(f.value_error(), Some("Enter an amount like 2600.00"));
        f.value = "x".into();
        assert_eq!(f.value_error(), Some("Enter an amount like 2600.00"));
        f.value = String::new();
        assert_eq!(f.value_error(), None);
        assert_eq!(f.payload(), None);
        f.value = "0".into();
        f.symbol = "  ".into();
        assert_eq!(f.payload(), None);
    }
}
