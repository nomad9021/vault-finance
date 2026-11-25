//! Mirrors packages/shared/src/schemas/giving.ts, plus the pure logic of
//! apps/desktop/src/screens/shell/GivingPage.tsx.

use serde::{Deserialize, Serialize};

use crate::goals::trim_js;
use crate::money::{cents_to_fixed2, js_round, parse_amount_to_cents};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GivingKind {
    Giving,
    Gift,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GivingFund {
    pub id: String,
    pub name: String,
    pub kind: GivingKind,
    pub recipient: Option<String>,
    pub monthly_cents: i64,
    pub saved_cents: i64,
    pub target_cents: Option<i64>,
    pub occasion_date: Option<String>,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub color: String,
    pub note: Option<String>,
    pub days_until_occasion: Option<i64>,
    pub needed_monthly_cents: Option<i64>,
    pub given_this_year_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GivingListResponse {
    pub funds: Vec<GivingFund>,
    pub monthly_giving_cents: i64,
    pub monthly_gift_cents: i64,
    pub total_saved_cents: i64,
    pub given_this_year_cents: i64,
}

impl GivingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GivingKind::Giving => "giving",
            GivingKind::Gift => "gift",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "giving" => Some(GivingKind::Giving),
            "gift" => Some(GivingKind::Gift),
            _ => None,
        }
    }
}

/// `GIVING_COLORS`: the swatches in the fund dialog.
pub const GIVING_COLORS: [&str; 6] = [
    "#b47ef0", "#ec6a9c", "#6f8ef2", "#3ecf8e", "#d8b23c", "#4db6d0",
];

/// `occasionLabel(days).text`: how far off a gift's date is.
pub fn occasion_label(days: Option<i64>) -> String {
    match days {
        None => "no date".into(),
        Some(d) if d < 0 => format!("{}d ago", d.unsigned_abs()),
        Some(0) => "today".into(),
        Some(d) if d <= 30 => format!("in {d} days"),
        Some(d) => format!("in {} months", js_round(d as f64 / 30.0)),
    }
}

/// "Still to save for gifts": what gift funds with a target still need.
pub fn gift_shortfall(funds: &[GivingFund]) -> i64 {
    funds
        .iter()
        .filter(|f| f.kind == GivingKind::Gift)
        .filter_map(|f| {
            f.target_cents
                .filter(|&t| t != 0)
                .map(|t| (t - f.saved_cents).max(0))
        })
        .sum()
}

/// Whether the four totals are worth showing (four $0 cards say nothing).
pub fn has_giving(data: Option<&GivingListResponse>) -> bool {
    data.is_some_and(|d| !d.funds.is_empty() || d.given_this_year_cents > 0)
}

fn present(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

impl GivingFund {
    /// `f.targetCents ?? 0`.
    pub fn target(&self) -> i64 {
        self.target_cents.unwrap_or(0)
    }

    /// Share of the target set aside, 0–1 (0 with no target).
    pub fn progress(&self) -> f64 {
        let t = self.target();
        if t > 0 {
            (self.saved_cents as f64 / t as f64).min(1.0)
        } else {
            0.0
        }
    }

    pub fn funded(&self) -> bool {
        let t = self.target();
        t > 0 && self.saved_cents >= t
    }

    /// Setting aside less per month than the date needs.
    pub fn behind(&self) -> bool {
        self.needed_monthly_cents
            .is_some_and(|n| n > self.monthly_cents)
    }

    pub fn linked_account(&self) -> Option<&str> {
        present(&self.account_id)
    }

    /// The row's grey line, before the account name: "recipient · " then
    /// the gift's date or "monthly".
    pub fn meta_line(&self) -> String {
        let mut s = String::new();
        if let Some(r) = present(&self.recipient) {
            s.push_str(r);
            s.push_str(" · ");
        }
        match (self.kind, present(&self.occasion_date)) {
            (GivingKind::Gift, Some(d)) => s.push_str(&format!(
                "{d} ({})",
                occasion_label(self.days_until_occasion)
            )),
            _ => s.push_str("monthly"),
        }
        s
    }
}

/// Body of `createGivingFund` / `updateGivingFund`. `None` goes over as
/// `null`, except `saved_cents`, which is left out for a linked fund.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GivingPayload {
    pub name: String,
    pub kind: GivingKind,
    pub recipient: Option<String>,
    pub monthly_cents: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_cents: Option<i64>,
    pub target_cents: Option<i64>,
    pub occasion_date: Option<String>,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub color: String,
    pub note: Option<String>,
}

/// The fund dialog's fields, as typed.
#[derive(Debug, Clone, PartialEq)]
pub struct GivingForm {
    pub kind: GivingKind,
    pub name: String,
    pub recipient: String,
    pub monthly: String,
    pub target: String,
    pub occasion_date: String,
    pub saved: String,
    pub account_id: String,
    pub category_id: String,
    pub color: String,
    pub note: String,
}

impl GivingForm {
    pub fn new(fund: Option<&GivingFund>, default_kind: GivingKind) -> Self {
        let s = |o: &Option<String>| o.clone().unwrap_or_default();
        match fund {
            None => GivingForm {
                kind: default_kind,
                name: String::new(),
                recipient: String::new(),
                monthly: String::new(),
                target: String::new(),
                occasion_date: String::new(),
                saved: "0".into(),
                account_id: String::new(),
                category_id: String::new(),
                color: GIVING_COLORS[0].into(),
                note: String::new(),
            },
            Some(f) => GivingForm {
                kind: f.kind,
                name: f.name.clone(),
                recipient: s(&f.recipient),
                monthly: cents_to_fixed2(f.monthly_cents),
                target: f
                    .target_cents
                    .filter(|&t| t != 0)
                    .map(cents_to_fixed2)
                    .unwrap_or_default(),
                occasion_date: s(&f.occasion_date),
                saved: if f.linked_account().is_none() {
                    cents_to_fixed2(f.saved_cents)
                } else {
                    "0".into()
                },
                account_id: s(&f.account_id),
                category_id: s(&f.category_id),
                color: f.color.clone(),
                note: s(&f.note),
            },
        }
    }

    /// The request body, or `None` while Save stays disabled (no name, or a
    /// negative monthly amount).
    pub fn payload(&self) -> Option<GivingPayload> {
        let monthly_cents = parse_amount_to_cents(&self.monthly).unwrap_or(0);
        let name = trim_js(&self.name);
        if name.is_empty() || monthly_cents < 0 {
            return None;
        }
        let linked = !self.account_id.is_empty();
        let opt = |s: &str| (!s.is_empty()).then(|| s.to_string());
        let gift = self.kind == GivingKind::Gift;
        Some(GivingPayload {
            name: name.to_string(),
            kind: self.kind,
            recipient: opt(trim_js(&self.recipient)),
            monthly_cents,
            // Only ours to write when unlinked: a linked fund shows the
            // account's balance, and sending 0 would wipe the manual figure.
            saved_cents: (!linked).then(|| parse_amount_to_cents(&self.saved).unwrap_or(0).max(0)),
            target_cents: if gift && !self.target.is_empty() {
                parse_amount_to_cents(&self.target)
            } else {
                None
            },
            occasion_date: if gift { opt(&self.occasion_date) } else { None },
            account_id: opt(&self.account_id),
            category_id: opt(&self.category_id),
            color: self.color.clone(),
            note: opt(trim_js(&self.note)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_funds() {
        let r: GivingListResponse = serde_json::from_str(
            r##"{"funds":[{"id":"1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f","name":"Birthdays","kind":"gift","recipient":null,
              "monthlyCents":5000,"savedCents":12000,"targetCents":30000,"occasionDate":"2027-03-14","accountId":null,
              "categoryId":null,"color":"#d8b23c","note":null,"daysUntilOccasion":110,"neededMonthlyCents":4500,
              "givenThisYearCents":0}],"monthlyGivingCents":0,"monthlyGiftCents":5000,"totalSavedCents":12000,
              "givenThisYearCents":0}"##,
        )
        .unwrap();
        assert_eq!(r.funds[0].kind, GivingKind::Gift);
        assert_eq!(r.funds[0].target_cents, Some(30_000));
    }

    fn fund(json: &str) -> GivingFund {
        let base = r##"{"id":"f1","name":"Tithe","kind":"giving","recipient":null,"monthlyCents":20000,
          "savedCents":0,"targetCents":null,"occasionDate":null,"accountId":null,"categoryId":null,
          "color":"#b47ef0","note":null,"daysUntilOccasion":null,"neededMonthlyCents":null,
          "givenThisYearCents":0}"##;
        let mut v: serde_json::Value = serde_json::from_str(base).unwrap();
        let patch: serde_json::Value = serde_json::from_str(json).unwrap();
        for (k, x) in patch.as_object().unwrap() {
            v[k] = x.clone();
        }
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn occasion_labels() {
        assert_eq!(occasion_label(None), "no date");
        assert_eq!(occasion_label(Some(-3)), "3d ago");
        assert_eq!(occasion_label(Some(0)), "today");
        assert_eq!(occasion_label(Some(1)), "in 1 days");
        assert_eq!(occasion_label(Some(30)), "in 30 days");
        assert_eq!(occasion_label(Some(31)), "in 1 months");
        // Math.round(45 / 30) = Math.round(1.5) = 2
        assert_eq!(occasion_label(Some(45)), "in 2 months");
        assert_eq!(occasion_label(Some(110)), "in 4 months");
    }

    #[test]
    fn shortfall_and_row_figures() {
        let funds = vec![
            fund(r#"{"kind":"gift","targetCents":30000,"savedCents":12000}"#),
            fund(r#"{"kind":"gift","targetCents":10000,"savedCents":15000}"#),
            fund(r#"{"kind":"gift","targetCents":0,"savedCents":0}"#),
            fund(r#"{"kind":"giving","targetCents":50000}"#),
        ];
        assert_eq!(gift_shortfall(&funds), 18_000);
        assert!((funds[0].progress() - 0.4).abs() < 1e-9);
        assert_eq!(funds[1].progress(), 1.0);
        assert!(funds[1].funded() && !funds[0].funded() && !funds[2].funded());
        assert_eq!(funds[2].progress(), 0.0);
        let behind = fund(r#"{"monthlyCents":4000,"neededMonthlyCents":4500}"#);
        assert!(behind.behind());
        assert!(!fund(r#"{"monthlyCents":4500,"neededMonthlyCents":4500}"#).behind());
    }

    #[test]
    fn meta_lines() {
        assert_eq!(fund("{}").meta_line(), "monthly");
        assert_eq!(fund(r#"{"recipient":""}"#).meta_line(), "monthly");
        assert_eq!(
            fund(r#"{"kind":"gift","recipient":"The kids","occasionDate":"2026-12-25","daysUntilOccasion":31}"#)
                .meta_line(),
            "The kids · 2026-12-25 (in 1 months)"
        );
        // A giving fund never shows a date, even with one stored.
        assert_eq!(
            fund(r#"{"occasionDate":"2026-12-25","daysUntilOccasion":31}"#).meta_line(),
            "monthly"
        );
        assert_eq!(fund(r#"{"kind":"gift"}"#).meta_line(), "monthly");
    }

    #[test]
    fn has_giving_needs_funds_or_history() {
        let empty: GivingListResponse = serde_json::from_str(
            r#"{"funds":[],"monthlyGivingCents":0,"monthlyGiftCents":0,"totalSavedCents":0,"givenThisYearCents":0}"#,
        )
        .unwrap();
        assert!(!has_giving(None));
        assert!(!has_giving(Some(&empty)));
        let given = GivingListResponse {
            given_this_year_cents: 100,
            ..empty
        };
        assert!(has_giving(Some(&given)));
    }

    #[test]
    fn form_starts_from_fund() {
        let new = GivingForm::new(None, GivingKind::Gift);
        assert_eq!(new.kind, GivingKind::Gift);
        assert_eq!((new.saved.as_str(), new.color.as_str()), ("0", "#b47ef0"));
        let f = fund(
            r#"{"kind":"gift","monthlyCents":5000,"savedCents":12345,"targetCents":30000,"recipient":"Mum","occasionDate":"2027-03-14"}"#,
        );
        let form = GivingForm::new(Some(&f), GivingKind::Giving);
        assert_eq!(form.kind, GivingKind::Gift);
        assert_eq!(
            (
                form.monthly.as_str(),
                form.target.as_str(),
                form.saved.as_str()
            ),
            ("50.00", "300.00", "123.45")
        );
        let linked = fund(r#"{"accountId":"a1","savedCents":999,"targetCents":0}"#);
        let form = GivingForm::new(Some(&linked), GivingKind::Giving);
        assert_eq!((form.saved.as_str(), form.target.as_str()), ("0", ""));
    }

    #[test]
    fn payload_matches_the_react_body() {
        let mut form = GivingForm::new(None, GivingKind::Giving);
        assert_eq!(form.payload(), None);
        form.name = "  Tithe ".into();
        form.monthly = "-5".into();
        assert_eq!(form.payload(), None);
        form.monthly = "abc".into(); // unparseable reads as 0
        form.target = "600".into(); // ignored for giving
        form.occasion_date = "2026-12-25".into();
        form.saved = "-20".into();
        form.recipient = "  ".into();
        let p = form.payload().unwrap();
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r##"{"name":"Tithe","kind":"giving","recipient":null,"monthlyCents":0,"savedCents":0,"targetCents":null,"occasionDate":null,"accountId":null,"categoryId":null,"color":"#b47ef0","note":null}"##
        );

        form.kind = GivingKind::Gift;
        form.account_id = "a1".into();
        form.monthly = "50".into();
        form.note = " pledged ".into();
        let p = form.payload().unwrap();
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r##"{"name":"Tithe","kind":"gift","recipient":null,"monthlyCents":5000,"targetCents":60000,"occasionDate":"2026-12-25","accountId":"a1","categoryId":null,"color":"#b47ef0","note":"pledged"}"##
        );
        form.target = "x".into();
        assert_eq!(form.payload().unwrap().target_cents, None);
    }
}
