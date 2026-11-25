//! Salary & taxes: packages/shared/src/schemas/taxes.ts (the tax profile and
//! places), the `TaxEstimate` the server builds with
//! packages/shared/src/tax/engine.ts, and the Taxes page's own maths
//! (apps/desktop/src/screens/shell/TaxesPage.tsx): the tax Sankey, per-period
//! amounts and the number fields. The engine itself runs on the server
//! (`client.estimateTax`) and isn't ported.

use serde::{Deserialize, Serialize};

use crate::money::js_round;
use crate::sankey::{Datum, LinkDatum, SankeyNodeKind};

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

impl TaxGroup {
    /// The group's name in a `TaxGroup` string.
    pub fn id(self) -> &'static str {
        match self {
            TaxGroup::Pretax => "pretax",
            TaxGroup::Federal => "federal",
            TaxGroup::Fica => "fica",
            TaxGroup::State => "state",
            TaxGroup::Local => "local",
            TaxGroup::Payroll => "payroll",
        }
    }

    /// `GROUP[g].label`.
    pub fn label(self) -> &'static str {
        match self {
            TaxGroup::Pretax => "Pre-tax savings",
            TaxGroup::Federal => "Federal tax",
            TaxGroup::Fica => "Social Security & Medicare",
            TaxGroup::State => "State tax",
            TaxGroup::Local => "Local tax",
            TaxGroup::Payroll => "State payroll programs",
        }
    }

    /// `GROUP[g].color`.
    pub fn color(self) -> &'static str {
        match self {
            TaxGroup::Pretax => "#43cfc0",
            TaxGroup::Federal => "#6f8ef2",
            TaxGroup::Fica => "#b47ef0",
            TaxGroup::State => "#ec6a9c",
            TaxGroup::Local => "#d8b23c",
            TaxGroup::Payroll => "#4db6d0",
        }
    }
}

/// `GROUP.takehome`.
pub const TAKE_HOME_LABEL: &str = "Take-home pay";
pub const TAKE_HOME_COLOR: &str = "#3ecf8e";

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
    #[serde(default)]
    pub notes: Vec<String>,
}

/// `client.taxProfile()` and `client.saveTaxProfile()`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TaxProfileResponse {
    pub year: i32,
    #[serde(default)]
    pub profile: Option<TaxProfile>,
    pub estimate: Option<TaxEstimate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilingStatus {
    Single,
    MarriedJoint,
    MarriedSeparate,
    HeadOfHousehold,
}

impl FilingStatus {
    /// `STATUS_LABELS`, in order.
    pub const ALL: [FilingStatus; 4] = [
        FilingStatus::Single,
        FilingStatus::MarriedJoint,
        FilingStatus::MarriedSeparate,
        FilingStatus::HeadOfHousehold,
    ];

    pub fn id(self) -> &'static str {
        match self {
            FilingStatus::Single => "single",
            FilingStatus::MarriedJoint => "married_joint",
            FilingStatus::MarriedSeparate => "married_separate",
            FilingStatus::HeadOfHousehold => "head_of_household",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            FilingStatus::Single => "Single",
            FilingStatus::MarriedJoint => "Married, filing jointly",
            FilingStatus::MarriedSeparate => "Married, filing separately",
            FilingStatus::HeadOfHousehold => "Head of household",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.id() == id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PayFrequency {
    Weekly,
    #[default]
    Biweekly,
    Semimonthly,
    Monthly,
}

impl PayFrequency {
    /// `FREQ_LABELS`, in order.
    pub const ALL: [PayFrequency; 4] = [
        PayFrequency::Weekly,
        PayFrequency::Biweekly,
        PayFrequency::Semimonthly,
        PayFrequency::Monthly,
    ];

    pub fn id(self) -> &'static str {
        match self {
            PayFrequency::Weekly => "weekly",
            PayFrequency::Biweekly => "biweekly",
            PayFrequency::Semimonthly => "semimonthly",
            PayFrequency::Monthly => "monthly",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PayFrequency::Weekly => "Weekly",
            PayFrequency::Biweekly => "Every 2 weeks",
            PayFrequency::Semimonthly => "Twice a month",
            PayFrequency::Monthly => "Monthly",
        }
    }

    /// `PAY_PERIODS[f]`: paychecks a year.
    pub fn periods(self) -> i64 {
        match self {
            PayFrequency::Weekly => 52,
            PayFrequency::Biweekly => 26,
            PayFrequency::Semimonthly => 24,
            PayFrequency::Monthly => 12,
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.id() == id)
    }
}

fn default_true() -> bool {
    true
}

/// `TaxEarner` (as `TaxProfileInput["earners"][number]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxEarner {
    pub name: String,
    pub gross_annual_cents: i64,
    #[serde(default)]
    pub pay_frequency: PayFrequency,
    #[serde(default)]
    pub retirement_pct: Option<f64>,
    #[serde(default)]
    pub retirement_cents: Option<i64>,
    #[serde(default)]
    pub hsa_cents: Option<i64>,
    #[serde(default)]
    pub health_premium_cents: Option<i64>,
    #[serde(default)]
    pub other_pretax_cents: Option<i64>,
}

impl TaxEarner {
    /// `blankEarner(n)`.
    pub fn blank(n: usize) -> Self {
        TaxEarner {
            name: if n > 0 {
                format!("Earner {}", n + 1)
            } else {
                "Me".into()
            },
            gross_annual_cents: 0,
            pay_frequency: PayFrequency::Biweekly,
            retirement_pct: None,
            retirement_cents: None,
            hsa_cents: None,
            health_premium_cents: None,
            other_pretax_cents: None,
        }
    }
}

/// `TaxProfile` / `TaxProfileInput`: what `saveTaxProfile` and
/// `estimateTax` take.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxProfile {
    pub filing_status: FilingStatus,
    pub state: String,
    #[serde(default)]
    pub locality: Option<String>,
    #[serde(default)]
    pub custom_local_rate_pct: Option<f64>,
    #[serde(default)]
    pub other_payroll_pct: Option<f64>,
    #[serde(default)]
    pub dependents: i64,
    pub earners: Vec<TaxEarner>,
    #[serde(default = "default_true")]
    pub sync_planned_income: bool,
}

impl Default for TaxProfile {
    /// `DEFAULT_PROFILE`.
    fn default() -> Self {
        TaxProfile {
            filing_status: FilingStatus::Single,
            state: "CO".into(),
            locality: None,
            custom_local_rate_pct: None,
            other_payroll_pct: None,
            dependents: 0,
            earners: vec![TaxEarner::blank(0)],
            sync_planned_income: true,
        }
    }
}

impl TaxProfile {
    /// `profile.earners.some((e) => e.grossAnnualCents > 0)`: worth estimating.
    pub fn has_pay(&self) -> bool {
        self.earners.iter().any(|e| e.gross_annual_cents > 0)
    }

    /// The same household somewhere else (`CompareMove`): the place's own
    /// local and payroll overrides are dropped.
    pub fn moved_to(&self, state: &str, locality: Option<String>) -> Self {
        TaxProfile {
            state: state.to_string(),
            locality,
            custom_local_rate_pct: None,
            other_payroll_pct: None,
            ..self.clone()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxState {
    pub code: String,
    pub name: String,
    pub taxes_wages: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxLocality {
    pub id: String,
    pub state: String,
    pub name: String,
    pub verified: bool,
}

/// `client.taxPlaces()`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TaxPlacesResponse {
    pub year: i32,
    pub states: Vec<TaxState>,
    pub localities: Vec<TaxLocality>,
}

impl TaxPlacesResponse {
    /// `places.localities.filter((l) => l.state === state)`.
    pub fn localities_in<'a>(&'a self, state: &'a str) -> impl Iterator<Item = &'a TaxLocality> {
        self.localities.iter().filter(move |l| l.state == state)
    }
}

/// The page's Yearly / Monthly toggle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    Year,
    Month,
}

impl Period {
    pub fn divisor(self) -> f64 {
        match self {
            Period::Year => 1.0,
            Period::Month => 12.0,
        }
    }

    /// `Math.round(c / div)`.
    pub fn amount(self, cents: i64) -> i64 {
        js_round(cents as f64 / self.divisor())
    }
}

/// `TaxSankey`'s nodes and links: each earner → gross pay → pre-tax and
/// each tax group (split into its lines when there's more than one) and
/// take-home, in the period's amounts.
pub fn tax_sankey(estimate: &TaxEstimate, period: Period) -> (Vec<Datum>, Vec<LinkDatum>) {
    let v = |c: i64| period.amount(c).max(0) as f64;
    let node = |id: String, label: &str, value: f64, color: &str, depth: u32, kind| Datum {
        id,
        label: label.to_string(),
        value,
        color: color.to_string(),
        depth,
        kind,
        caption: None,
    };
    let link = |from: &str, to: &str, value: f64| LinkDatum {
        from: from.to_string(),
        to: to.to_string(),
        value,
        color: None,
    };
    let mut nodes = Vec::new();
    let mut links = Vec::new();
    for (i, p) in estimate.per_earner.iter().enumerate() {
        let id = format!("earner:{i}");
        nodes.push(node(
            id.clone(),
            &p.name,
            v(p.gross_cents),
            "#6f8ef2",
            0,
            SankeyNodeKind::Income,
        ));
        links.push(link(&id, "hub", v(p.gross_cents)));
    }
    nodes.push(node(
        "hub".into(),
        "Gross pay",
        v(estimate.gross_cents),
        "#9397ab",
        1,
        SankeyNodeKind::Hub,
    ));
    // A Map in first-seen order.
    let mut groups: Vec<(TaxGroup, i64)> = Vec::new();
    for l in &estimate.lines {
        let amount = l.amount_cents.max(0);
        match groups.iter_mut().find(|(g, _)| *g == l.group) {
            Some((_, c)) => *c += amount,
            None => groups.push((l.group, amount)),
        }
    }
    for &(g, cents) in &groups {
        if cents <= 0 {
            continue;
        }
        let gid = format!("g:{}", g.id());
        nodes.push(node(
            gid.clone(),
            g.label(),
            v(cents),
            g.color(),
            2,
            SankeyNodeKind::Category,
        ));
        links.push(link("hub", &gid, v(cents)));
        let in_group = estimate.lines.iter().filter(|x| x.group == g).count();
        for l in estimate
            .lines
            .iter()
            .filter(|x| x.group == g && x.amount_cents > 0)
        {
            if cents == l.amount_cents && in_group == 1 {
                continue;
            }
            let lid = format!("l:{}", l.id);
            nodes.push(node(
                lid.clone(),
                &l.label,
                v(l.amount_cents),
                g.color(),
                3,
                SankeyNodeKind::Category,
            ));
            links.push(link(&gid, &lid, v(l.amount_cents)));
        }
    }
    nodes.push(node(
        "takehome".into(),
        TAKE_HOME_LABEL,
        v(estimate.take_home_cents),
        TAKE_HOME_COLOR,
        2,
        SankeyNodeKind::Saved,
    ));
    links.push(link("hub", "takehome", v(estimate.take_home_cents)));
    (nodes, links)
}

/// "Next dollar earned": `Math.round((federal + state) * 10) / 10`.
pub fn marginal_total_pct(estimate: &TaxEstimate) -> f64 {
    js_round((estimate.marginal_federal_pct + estimate.marginal_state_pct) * 10.0) as f64 / 10.0
}

/// A JS number as `String(n)` prints it, for the plain figures this page
/// shows (no exponents).
pub fn js_number_string(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if n == 0.0 {
        "0".into()
    } else {
        format!("{n}")
    }
}

/// `Number(text)` for a decimal field: blank is 0, anything that isn't a
/// number is NaN.
pub fn js_number(text: &str) -> f64 {
    let t = text.trim();
    if t.is_empty() {
        return 0.0;
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let lower = unsigned.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            // JS takes no sign on these.
            if unsigned.len() != t.len() || digits.is_empty() {
                return f64::NAN;
            }
            return u64::from_str_radix(digits, radix)
                .map(|n| n as f64)
                .unwrap_or(f64::NAN);
        }
    }
    // Rust also reads "inf" and "nan"; JS doesn't.
    if !unsigned
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
        || !unsigned.bytes().any(|b| b.is_ascii_digit())
    {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

/// `e.target.value ? Number(e.target.value) : null`.
pub fn optional_number(text: &str) -> Option<f64> {
    (!text.is_empty()).then(|| js_number(text))
}

/// "Children under 17": `Math.max(0, Math.floor(Number(v) || 0))`.
pub fn dependents_from(text: &str) -> i64 {
    let n = js_number(text);
    if n.is_nan() || n == 0.0 {
        0
    } else {
        n.floor().max(0.0).min(i64::MAX as f64) as i64
    }
}

/// `MoneyField`'s text for a cents value: whole dollars, blank for none.
pub fn whole_dollars_text(cents: Option<i64>) -> String {
    match cents {
        Some(c) if c != 0 => js_round(c as f64 / 100.0).to_string(),
        _ => String::new(),
    }
}

/// The move comparison's difference: sign (`+` or U+2212), then the yearly
/// and monthly sizes in cents.
pub fn move_diff(other_take_home: i64, current_take_home: i64) -> (char, i64, i64) {
    let diff = other_take_home - current_take_home;
    let sign = if diff >= 0 { '+' } else { '\u{2212}' };
    (sign, diff.abs(), js_round(diff as f64 / 12.0).abs())
}

/// The other place `CompareMove` starts on.
pub fn compare_start_state(state: &str) -> &'static str {
    if state == "TX" {
        "CO"
    } else {
        "TX"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROFILE: &str = r#"{
        "filingStatus": "married_joint", "state": "NY", "locality": "nyc",
        "customLocalRatePct": null, "otherPayrollPct": 0.5, "dependents": 2,
        "earners": [
            { "name": "Sam", "grossAnnualCents": 12000000, "payFrequency": "semimonthly",
              "retirementPct": 6, "retirementCents": null, "hsaCents": 200000,
              "healthPremiumCents": 360000, "otherPretaxCents": null },
            { "name": "Alex", "grossAnnualCents": 8500000, "payFrequency": "biweekly" }
        ],
        "syncPlannedIncome": false
    }"#;

    fn line(id: &str, group: TaxGroup, amount_cents: i64) -> TaxLine {
        TaxLine {
            id: id.into(),
            label: id.to_uppercase(),
            group,
            amount_cents,
        }
    }

    fn estimate(lines: Vec<TaxLine>) -> TaxEstimate {
        TaxEstimate {
            year: 2026,
            state: "NY".into(),
            state_name: "New York".into(),
            locality: Some("nyc".into()),
            gross_cents: 20_500_000,
            pretax_cents: 0,
            tax_cents: 0,
            take_home_cents: 13_000_005,
            effective_rate_pct: 26.1,
            marginal_federal_pct: 22.0,
            marginal_state_pct: 4.4,
            lines,
            per_earner: vec![
                EarnerEstimate {
                    name: "Sam".into(),
                    gross_cents: 12_000_000,
                    pretax_cents: 0,
                    tax_cents: 0,
                    take_home_cents: 0,
                },
                EarnerEstimate {
                    name: "Alex".into(),
                    gross_cents: 8_500_000,
                    pretax_cents: 0,
                    tax_cents: 0,
                    take_home_cents: 0,
                },
            ],
            notes: vec![],
        }
    }

    #[test]
    fn parses_profile_response_and_places() {
        let json = format!(
            r#"{{ "year": 2026, "profile": {PROFILE}, "estimate": {{
                "year": 2026, "state": "NY", "stateName": "New York", "locality": "nyc",
                "grossCents": 20500000, "pretaxCents": 1100000, "taxCents": 5200000,
                "takeHomeCents": 14200000, "effectiveRatePct": 25.4,
                "marginalFederalPct": 22, "marginalStatePct": 9.73,
                "lines": [{{ "id": "federal", "label": "Federal income tax", "group": "federal", "amountCents": 2500000 }}],
                "perEarner": [{{ "name": "Sam", "grossCents": 12000000, "pretaxCents": 1100000, "taxCents": 3000000, "takeHomeCents": 7900000 }}],
                "notes": ["Assumes wages are your only income."]
            }} }}"#
        );
        let r: TaxProfileResponse = serde_json::from_str(&json).unwrap();
        let p = r.profile.unwrap();
        assert_eq!(p.filing_status, FilingStatus::MarriedJoint);
        assert_eq!(p.earners[0].pay_frequency, PayFrequency::Semimonthly);
        assert_eq!(p.earners[0].retirement_pct, Some(6.0));
        // Defaults zod fills in.
        assert_eq!(p.earners[1].pay_frequency, PayFrequency::Biweekly);
        assert_eq!(p.earners[1].hsa_cents, None);
        assert!(!p.sync_planned_income);
        let e = r.estimate.unwrap();
        assert_eq!(e.notes, vec!["Assumes wages are your only income."]);
        assert_eq!(e.lines[0].group, TaxGroup::Federal);

        let empty: TaxProfileResponse =
            serde_json::from_str(r#"{ "year": 2026, "profile": null, "estimate": null }"#).unwrap();
        assert_eq!(empty.profile, None);

        let places: TaxPlacesResponse = serde_json::from_str(
            r#"{ "year": 2026,
                "states": [{ "code": "NY", "name": "New York", "taxesWages": true },
                           { "code": "TX", "name": "Texas", "taxesWages": false }],
                "localities": [{ "id": "nyc", "state": "NY", "name": "New York City", "verified": true },
                               { "id": "yonkers", "state": "NY", "name": "Yonkers", "verified": false },
                               { "id": "phl", "state": "PA", "name": "Philadelphia", "verified": true }] }"#,
        )
        .unwrap();
        let ny: Vec<_> = places.localities_in("NY").map(|l| l.id.as_str()).collect();
        assert_eq!(ny, ["nyc", "yonkers"]);
        assert_eq!(places.localities_in("TX").count(), 0);
    }

    #[test]
    fn profile_serializes_as_the_api_expects() {
        let p: TaxProfile = serde_json::from_str(PROFILE).unwrap();
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["filingStatus"], "married_joint");
        assert_eq!(back["earners"][1]["payFrequency"], "biweekly");
        assert_eq!(back["earners"][1]["hsaCents"], serde_json::Value::Null);
        assert_eq!(back["syncPlannedIncome"], false);
        let round: TaxProfile = serde_json::from_value(back).unwrap();
        assert_eq!(round, p);

        let d = serde_json::to_value(TaxProfile::default()).unwrap();
        assert_eq!(d["filingStatus"], "single");
        assert_eq!(d["state"], "CO");
        assert_eq!(d["earners"][0]["name"], "Me");
        assert_eq!(d["earners"][0]["grossAnnualCents"], 0);
        assert_eq!(d["syncPlannedIncome"], true);
    }

    #[test]
    fn blank_earners_and_pay() {
        assert_eq!(TaxEarner::blank(0).name, "Me");
        assert_eq!(TaxEarner::blank(2).name, "Earner 3");
        let mut p = TaxProfile::default();
        assert!(!p.has_pay());
        p.earners.push(TaxEarner::blank(1));
        p.earners[1].gross_annual_cents = 1;
        assert!(p.has_pay());
    }

    #[test]
    fn moving_drops_local_overrides() {
        let p: TaxProfile = serde_json::from_str(PROFILE).unwrap();
        let m = p.moved_to("TX", None);
        assert_eq!(m.state, "TX");
        assert_eq!(m.locality, None);
        assert_eq!(m.other_payroll_pct, None);
        assert_eq!(m.custom_local_rate_pct, None);
        assert_eq!(m.earners, p.earners);
        assert_eq!(compare_start_state("TX"), "CO");
        assert_eq!(compare_start_state("CO"), "TX");
    }

    #[test]
    fn pay_periods_and_labels() {
        let periods: Vec<_> = PayFrequency::ALL.iter().map(|f| f.periods()).collect();
        assert_eq!(periods, [52, 26, 24, 12]);
        assert_eq!(
            PayFrequency::from_id("semimonthly"),
            Some(PayFrequency::Semimonthly)
        );
        assert_eq!(
            FilingStatus::from_id("head_of_household").unwrap().label(),
            "Head of household"
        );
        assert_eq!(FilingStatus::from_id("nope"), None);
    }

    #[test]
    fn sankey_groups_and_splits_lines() {
        let e = estimate(vec![
            line("k401", TaxGroup::Pretax, 720_000),
            line("hsa", TaxGroup::Pretax, 200_000),
            line("federal", TaxGroup::Federal, 2_500_000),
            line("ss", TaxGroup::Fica, 1_271_000),
            line("medicare", TaxGroup::Fica, 297_250),
            line("state", TaxGroup::State, 900_000),
            // A group of one zero line is left out altogether.
            line("local", TaxGroup::Local, 0),
            // A negative line counts as nothing.
            line("credit", TaxGroup::Federal, -100),
        ]);
        let (nodes, links) = tax_sankey(&e, Period::Year);
        let ids: Vec<_> = nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "earner:0",
                "earner:1",
                "hub",
                "g:pretax",
                "l:k401",
                "l:hsa",
                "g:federal",
                "l:federal",
                "g:fica",
                "l:ss",
                "l:medicare",
                "g:state",
                "takehome",
            ]
        );
        // Federal has two lines (one negative), so its single positive line
        // still gets its own node; state has one line equal to the group.
        let fed = nodes.iter().find(|n| n.id == "g:federal").unwrap();
        assert_eq!(fed.value, 2_500_000.0);
        assert_eq!(fed.color, "#6f8ef2");
        assert_eq!(fed.label, "Federal tax");
        assert_eq!(fed.kind, SankeyNodeKind::Category);
        assert_eq!(nodes.iter().find(|n| n.id == "l:ss").unwrap().depth, 3);
        let th = nodes.last().unwrap();
        assert_eq!(
            (th.label.as_str(), th.color.as_str(), th.depth),
            ("Take-home pay", "#3ecf8e", 2)
        );
        assert_eq!(th.kind, SankeyNodeKind::Saved);
        let pairs: Vec<_> = links
            .iter()
            .map(|l| (l.from.as_str(), l.to.as_str()))
            .collect();
        assert_eq!(
            &pairs[..3],
            &[
                ("earner:0", "hub"),
                ("earner:1", "hub"),
                ("hub", "g:pretax")
            ]
        );
        assert_eq!(pairs.last(), Some(&("hub", "takehome")));
        assert!(!pairs.contains(&("g:state", "l:state")));
    }

    #[test]
    fn sankey_monthly_rounds_like_math_round() {
        let e = estimate(vec![line("state", TaxGroup::State, 18)]);
        let (nodes, _) = tax_sankey(&e, Period::Month);
        // 18 / 12 = 1.5 → 2; take-home 13_000_005 / 12 = 1_083_333.75 → 1_083_334.
        assert_eq!(nodes.iter().find(|n| n.id == "g:state").unwrap().value, 2.0);
        assert_eq!(nodes.last().unwrap().value, 1_083_334.0);
        assert_eq!(Period::Month.amount(-18), -1);
        assert_eq!(Period::Year.amount(123), 123);
    }

    #[test]
    fn next_dollar_rate() {
        let e = estimate(vec![]);
        assert_eq!(js_number_string(marginal_total_pct(&e)), "26.4");
        let mut e2 = e.clone();
        e2.marginal_federal_pct = 24.0;
        e2.marginal_state_pct = 0.0;
        assert_eq!(js_number_string(marginal_total_pct(&e2)), "24");
        e2.marginal_state_pct = 4.25;
        assert_eq!(js_number_string(marginal_total_pct(&e2)), "28.3");
    }

    #[test]
    fn number_fields_read_like_js_number() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 3.5 "), 3.5);
        assert_eq!(js_number("5."), 5.0);
        assert_eq!(js_number(".5"), 0.5);
        assert_eq!(js_number("1e2"), 100.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert!(js_number("1,5").is_nan());
        assert!(js_number("inf").is_nan());
        assert!(js_number("nan").is_nan());
        assert!(js_number(".").is_nan());
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(optional_number(""), None);
        assert_eq!(optional_number("4"), Some(4.0));
        assert!(optional_number("x").unwrap().is_nan());
        assert_eq!(dependents_from("2.7"), 2);
        assert_eq!(dependents_from("-3"), 0);
        assert_eq!(dependents_from("abc"), 0);
        assert_eq!(dependents_from(""), 0);
        assert_eq!(js_number_string(0.5), "0.5");
        assert_eq!(js_number_string(f64::NAN), "NaN");
        assert_eq!(js_number_string(-0.0), "0");
        assert_eq!(js_number_string(10.0), "10");
    }

    #[test]
    fn money_field_text() {
        assert_eq!(whole_dollars_text(None), "");
        assert_eq!(whole_dollars_text(Some(0)), "");
        assert_eq!(whole_dollars_text(Some(5050)), "51");
        assert_eq!(whole_dollars_text(Some(12_000_000)), "120000");
    }

    #[test]
    fn move_difference() {
        assert_eq!(move_diff(10_000, 4_000), ('+', 6_000, 500));
        assert_eq!(move_diff(4_000, 4_000), ('+', 0, 0));
        // −30 / 12 = −2.5 → Math.round gives −2.
        assert_eq!(move_diff(0, 30), ('\u{2212}', 30, 2));
        assert_eq!(move_diff(0, 42), ('\u{2212}', 42, 3));
    }
}
