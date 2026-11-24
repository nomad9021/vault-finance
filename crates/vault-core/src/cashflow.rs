//! Mirrors packages/shared/src/schemas/cashflow.ts (the summary and trend
//! types) and the summary figures under the Cash Flow page's bar chart.

use serde::Deserialize;

use crate::money::js_round;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthSummary {
    /// "YYYY-MM".
    pub month: String,
    pub income_cents: i64,
    pub spending_cents: i64,
    /// income − spending.
    pub net_cents: i64,
    /// 0–1, null when there was no income that month.
    pub savings_rate: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CashflowSummaryResponse {
    pub months: Vec<MonthSummary>,
}

/// The three metric cards on the trends tab.
#[derive(Debug, Clone, PartialEq)]
pub struct CashflowStats {
    /// Tallest bar: `Math.max(1, ...income/spending)`.
    pub max_cents: i64,
    /// Average net over months with any activity, rounded like `Math.round`.
    pub avg_net_cents: i64,
    /// Mean savings rate of active months that have one.
    pub avg_rate: Option<f64>,
    /// Sum of the positive months' net.
    pub total_saved_cents: i64,
}

pub fn stats(months: &[MonthSummary]) -> CashflowStats {
    let max_cents = months
        .iter()
        .map(|m| m.income_cents.max(m.spending_cents))
        .fold(1, i64::max);
    let with_data: Vec<&MonthSummary> = months
        .iter()
        .filter(|m| m.income_cents > 0 || m.spending_cents > 0)
        .collect();
    let avg_net_cents = if with_data.is_empty() {
        0
    } else {
        let sum: i64 = with_data.iter().map(|m| m.net_cents).sum();
        js_round(sum as f64 / with_data.len() as f64) as i64
    };
    let rates: Vec<f64> = with_data.iter().filter_map(|m| m.savings_rate).collect();
    let avg_rate = (!rates.is_empty()).then(|| rates.iter().sum::<f64>() / rates.len() as f64);
    let total_saved_cents = with_data.iter().map(|m| m.net_cents.max(0)).sum();
    CashflowStats {
        max_cents,
        avg_net_cents,
        avg_rate,
        total_saved_cents,
    }
}

/// `${Math.round(avgRate * 100)}%`, or "—".
pub fn rate_label(rate: Option<f64>) -> String {
    match rate {
        Some(r) => format!("{}%", js_round(r * 100.0) as i64),
        None => "\u{2014}".into(),
    }
}

/// A bar's CSS height, `${(cents / max) * 100}%`.
pub fn bar_height(cents: i64, max_cents: i64) -> String {
    let pct = (cents as f64 / max_cents as f64) * 100.0;
    if pct == 0.0 {
        "0%".into()
    } else {
        format!("{pct}%")
    }
}

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

    const SAMPLE: &str = r#"{"months":[
      {"month":"2026-06","incomeCents":0,"spendingCents":0,"netCents":0,"savingsRate":null},
      {"month":"2026-07","incomeCents":612500,"spendingCents":480233,"netCents":132267,"savingsRate":0.2159461224489796},
      {"month":"2026-08","incomeCents":612500,"spendingCents":701150,"netCents":-88650,"savingsRate":-0.14473469387755103},
      {"month":"2026-09","incomeCents":0,"spendingCents":12000,"netCents":-12000,"savingsRate":null},
      {"month":"2026-10","incomeCents":650000,"spendingCents":402001,"netCents":247999,"savingsRate":0.3815369230769231},
      {"month":"2026-11","incomeCents":325000,"spendingCents":118745,"netCents":206255,"savingsRate":0.6346307692307692}
    ]}"#;

    #[test]
    fn parses_and_summarises() {
        let r: CashflowSummaryResponse = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(r.months.len(), 6);
        assert_eq!(r.months[0].savings_rate, None);
        let s = stats(&r.months);
        assert_eq!(s.max_cents, 701_150);
        // (132267 − 88650 − 12000 + 247999 + 206255) / 5 = 97174.2
        assert_eq!(s.avg_net_cents, 97_174);
        assert_eq!(s.total_saved_cents, 132_267 + 247_999 + 206_255);
        let rate = s.avg_rate.unwrap();
        assert!((rate - 0.27184478).abs() < 1e-6, "{rate}");
        assert_eq!(rate_label(s.avg_rate), "27%");
    }

    #[test]
    fn empty_months() {
        let s = stats(&[]);
        assert_eq!(
            s,
            CashflowStats {
                max_cents: 1,
                avg_net_cents: 0,
                avg_rate: None,
                total_saved_cents: 0
            }
        );
        assert_eq!(rate_label(None), "—");
    }

    #[test]
    fn rounding_matches_math_round() {
        let m = |net: i64| MonthSummary {
            month: "2026-01".into(),
            income_cents: 1,
            spending_cents: 0,
            net_cents: net,
            savings_rate: None,
        };
        // −3 / 2 = −1.5 → Math.round gives −1.
        assert_eq!(stats(&[m(-1), m(-2)]).avg_net_cents, -1);
        assert_eq!(stats(&[m(1), m(2)]).avg_net_cents, 2);
        assert_eq!(rate_label(Some(0.125)), "13%");
    }

    #[test]
    fn bar_heights_print_like_js() {
        assert_eq!(bar_height(612_500, 701_150), "87.35648577337231%");
        assert_eq!(bar_height(701_150, 701_150), "100%");
        assert_eq!(bar_height(0, 1), "0%");
        assert_eq!(bar_height(1, 3), "33.33333333333333%");
    }

    #[test]
    fn parses_trends() {
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
