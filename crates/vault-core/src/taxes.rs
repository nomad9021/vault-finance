//! The tax estimate the server returns with the tax profile
//! (`TaxProfileResponse.estimate`, built by packages/shared/src/tax/engine.ts).
//! Only the types: the engine itself isn't ported.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaxGroup {
    Pretax,
    Federal,
    Fica,
    State,
    Local,
    Payroll,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxLine {
    pub id: String,
    pub label: String,
    pub group: TaxGroup,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EarnerEstimate {
    pub name: String,
    pub gross_cents: i64,
    pub pretax_cents: i64,
    pub tax_cents: i64,
    pub take_home_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxEstimate {
    pub year: i32,
    pub state: String,
    pub state_name: String,
    pub locality: Option<String>,
    pub gross_cents: i64,
    /// Retirement, HSA, premiums: money that's still yours but not take-home.
    pub pretax_cents: i64,
    /// Income taxes + FICA + payroll programs.
    pub tax_cents: i64,
    pub take_home_cents: i64,
    pub effective_rate_pct: f64,
    pub marginal_federal_pct: f64,
    pub marginal_state_pct: f64,
    pub lines: Vec<TaxLine>,
    pub per_earner: Vec<EarnerEstimate>,
}

/// The one field of `TaxProfile` the budget planner reads.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxProfileFlags {
    /// The planner's income follows the estimated take-home.
    #[serde(default = "yes")]
    pub sync_planned_income: bool,
}

fn yes() -> bool {
    true
}

/// `client.taxProfile()`. Of the profile itself only the planner's flag is
/// read for now.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TaxProfileResponse {
    pub year: i32,
    #[serde(default)]
    pub profile: Option<TaxProfileFlags>,
    pub estimate: Option<TaxEstimate>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_profile_flag() {
        let r: TaxProfileResponse = serde_json::from_str(
            r#"{"year":2026,"profile":{"filingStatus":"single","state":"CO","dependents":0,
                "earners":[{"name":"Alex","grossAnnualCents":10000000}],"syncPlannedIncome":false},
                "estimate":null}"#,
        )
        .unwrap();
        assert_eq!(
            r.profile,
            Some(TaxProfileFlags {
                sync_planned_income: false
            })
        );
        let none: TaxProfileResponse =
            serde_json::from_str(r#"{"year":2026,"profile":null,"estimate":null}"#).unwrap();
        assert_eq!(none.profile, None);
        let default: TaxProfileResponse =
            serde_json::from_str(r#"{"year":2026,"profile":{"earners":[]},"estimate":null}"#)
                .unwrap();
        assert!(default.profile.unwrap().sync_planned_income);
    }
}
