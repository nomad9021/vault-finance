//! Mirrors the trend types in packages/shared/src/schemas/cashflow.ts.

use serde::Deserialize;

/// One month on the trend charts. Net worth is reconstructed from current
/// balances minus later transaction flows, so market moves aren't captured.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    /// `YYYY-MM`.
    pub month: String,
    pub net_worth_cents: i64,
    pub income_cents: i64,
    pub spending_cents: i64,
}

impl TrendPoint {
    /// (year, month 1–12) of `month`.
    pub fn year_month(&self) -> Option<(i32, u32)> {
        let (y, m) = self.month.split_once('-')?;
        Some((y.parse().ok()?, m.parse().ok()?))
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendsResponse {
    pub points: Vec<TrendPoint>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_shape() {
        let r: TrendsResponse = serde_json::from_str(
            r#"{"points":[
              {"month":"2026-10","netWorthCents":1520000,"incomeCents":640000,"spendingCents":512340},
              {"month":"2026-11","netWorthCents":1548117,"incomeCents":640000,"spendingCents":611883}
            ]}"#,
        )
        .unwrap();
        assert_eq!(r.points.len(), 2);
        assert_eq!(r.points[1].net_worth_cents, 1548117);
        assert_eq!(r.points[0].year_month(), Some((2026, 10)));
    }
}
