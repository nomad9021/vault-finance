//! Mirrors packages/shared/src/schemas/goals.ts, plus the card and form logic
//! of apps/desktop/src/screens/shell/GoalsPage.tsx.

use serde::{Deserialize, Serialize};

use crate::money::{cents_to_fixed2, js_round, parse_amount_to_cents};

/// Swatches offered in the goal dialog, first is the default.
pub const GOAL_COLORS: [&str; 6] = [
    "#3ecf8e", "#43cfc0", "#6f8ef2", "#b47ef0", "#ec6a9c", "#d8b23c",
];

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub name: String,
    pub target_cents: i64,
    /// Linked-account balance when linked; manual amount otherwise.
    pub saved_cents: i64,
    pub monthly_cents: i64,
    pub linked_account_id: Option<String>,
    pub target_date: Option<String>,
    pub color: String,
    pub note: Option<String>,
    /// "YYYY-MM" the goal is projected to complete.
    pub projected_completion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct GoalListResponse {
    pub goals: Vec<Goal>,
}

/// What the tag on a goal card says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalEta {
    Funded,
    /// "YYYY-MM"; the UI prints it as "~Mar 2027".
    Projected(String),
    /// "YYYY-MM-DD", printed as "target 2027-03-01".
    Target(String),
    NoTimeline,
}

impl Goal {
    /// Share funded, 0–1 (0 when there's no target).
    pub fn progress(&self) -> f64 {
        if self.target_cents > 0 {
            (self.saved_cents as f64 / self.target_cents as f64).min(1.0)
        } else {
            0.0
        }
    }

    pub fn funded(&self) -> bool {
        self.saved_cents >= self.target_cents
    }

    /// `Math.round(pct * 100)`.
    pub fn percent(&self) -> i64 {
        js_round(self.progress() * 100.0)
    }

    pub fn eta(&self) -> GoalEta {
        if self.funded() {
            GoalEta::Funded
        } else if let Some(m) = non_empty(&self.projected_completion) {
            GoalEta::Projected(m.to_string())
        } else if let Some(d) = non_empty(&self.target_date) {
            GoalEta::Target(d.to_string())
        } else {
            GoalEta::NoTimeline
        }
    }

    /// The account id to link to, when there is one (`g.linkedAccountId ? … : …`).
    pub fn linked_account(&self) -> Option<&str> {
        non_empty(&self.linked_account_id)
    }
}

/// JS truthiness for an optional string: `null` and `""` are both "no".
pub fn non_empty(v: &Option<String>) -> Option<&str> {
    v.as_deref().filter(|s| !s.is_empty())
}

/// Body of `createGoal` / `updateGoal`. `None` goes over as `null` (the
/// update is a PATCH, so null clears a link, date or note).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalPayload {
    pub name: String,
    pub target_cents: i64,
    pub saved_cents: i64,
    pub monthly_cents: i64,
    pub linked_account_id: Option<String>,
    pub target_date: Option<String>,
    pub color: String,
    pub note: Option<String>,
}

/// The goal dialog's fields, as typed.
#[derive(Debug, Clone, PartialEq)]
pub struct GoalForm {
    pub name: String,
    pub target: String,
    pub linked_account_id: String,
    pub saved: String,
    pub monthly: String,
    pub target_date: String,
    pub color: String,
    pub note: String,
}

impl GoalForm {
    /// Starting values: a goal's own, or blanks for a new one.
    pub fn new(goal: Option<&Goal>) -> Self {
        match goal {
            None => GoalForm {
                name: String::new(),
                target: String::new(),
                linked_account_id: String::new(),
                saved: "0".into(),
                monthly: String::new(),
                target_date: String::new(),
                color: GOAL_COLORS[0].into(),
                note: String::new(),
            },
            Some(g) => GoalForm {
                name: g.name.clone(),
                target: cents_to_fixed2(g.target_cents),
                linked_account_id: g.linked_account_id.clone().unwrap_or_default(),
                saved: if g.linked_account().is_none() {
                    cents_to_fixed2(g.saved_cents)
                } else {
                    "0".into()
                },
                monthly: cents_to_fixed2(g.monthly_cents),
                target_date: g.target_date.clone().unwrap_or_default(),
                color: g.color.clone(),
                note: g.note.clone().unwrap_or_default(),
            },
        }
    }

    /// The request body, or `None` while the form isn't valid (Save stays
    /// disabled): a name, a positive target, and a non-negative saved amount
    /// unless an account is linked.
    pub fn payload(&self) -> Option<GoalPayload> {
        let target_cents = parse_amount_to_cents(&self.target)?;
        let monthly_cents = if self.monthly.trim().is_empty() {
            0
        } else {
            parse_amount_to_cents(&self.monthly).unwrap_or(0)
        };
        let linked = !self.linked_account_id.is_empty();
        let saved_cents = if linked {
            0
        } else {
            parse_amount_to_cents(&self.saved).unwrap_or(-1)
        };
        let name = trim_js(&self.name);
        if name.is_empty() || target_cents <= 0 || saved_cents < 0 {
            return None;
        }
        let note = trim_js(&self.note);
        Some(GoalPayload {
            name: name.to_string(),
            target_cents,
            saved_cents,
            monthly_cents,
            linked_account_id: linked.then(|| self.linked_account_id.clone()),
            target_date: (!self.target_date.is_empty()).then(|| self.target_date.clone()),
            color: self.color.clone(),
            note: (!note.is_empty()).then(|| note.to_string()),
        })
    }
}

/// `String#trim`: JS whitespace is Unicode whitespace plus the BOM.
pub fn trim_js(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r##"{"goals":[
      {"id":"6b0e1f0a-4a1c-4f6e-9a51-1f1d2b1c3c4d","name":"Emergency fund","targetCents":1500000,
       "savedCents":620000,"monthlyCents":25000,"linkedAccountId":"0e5d2a51-5b8e-4b8e-8e0e-2f6a1c9d7b31",
       "targetDate":null,"color":"#3ecf8e","note":"3 months of expenses","projectedCompletion":"2027-09"},
      {"id":"a1c0e6f2-8f6b-4c3e-9d7a-5b2e1f0c9d8e","name":"Japan trip","targetCents":400000,
       "savedCents":400000,"monthlyCents":0,"linkedAccountId":null,"targetDate":"2027-04-01",
       "color":"#6f8ef2","note":null,"projectedCompletion":null},
      {"id":"c3d2e1f0-1a2b-4c3d-8e9f-0a1b2c3d4e5f","name":"Car","targetCents":2000000,
       "savedCents":150000,"monthlyCents":0,"linkedAccountId":null,"targetDate":"2028-01-15",
       "color":"#d8b23c","note":null,"projectedCompletion":null}
    ]}"##;

    fn goals() -> Vec<Goal> {
        serde_json::from_str::<GoalListResponse>(SAMPLE)
            .unwrap()
            .goals
    }

    #[test]
    fn parses_server_shape() {
        let g = goals();
        assert_eq!(g.len(), 3);
        assert_eq!(g[0].saved_cents, 620_000);
        assert_eq!(g[0].projected_completion.as_deref(), Some("2027-09"));
        assert_eq!(g[1].linked_account_id, None);
    }

    #[test]
    fn card_numbers() {
        let g = goals();
        assert_eq!(g[0].percent(), 41);
        assert_eq!(g[0].eta(), GoalEta::Projected("2027-09".into()));
        assert_eq!(g[1].eta(), GoalEta::Funded);
        assert_eq!(g[1].percent(), 100);
        assert_eq!(g[2].eta(), GoalEta::Target("2028-01-15".into()));
        let mut none = g[2].clone();
        none.target_date = None;
        assert_eq!(none.eta(), GoalEta::NoTimeline);
        let mut over = g[2].clone();
        over.saved_cents = 9_000_000;
        assert_eq!(over.progress(), 1.0);
        let mut zero = g[2].clone();
        zero.target_cents = 0;
        assert_eq!(zero.progress(), 0.0);
        assert!(zero.funded());
    }

    #[test]
    fn form_starts_from_the_goal() {
        let g = goals();
        let f = GoalForm::new(Some(&g[0]));
        assert_eq!(f.target, "15000.00");
        assert_eq!(f.saved, "0");
        assert_eq!(f.monthly, "250.00");
        let f = GoalForm::new(Some(&g[2]));
        assert_eq!(f.saved, "1500.00");
        assert_eq!(f.monthly, "0.00");
        let blank = GoalForm::new(None);
        assert_eq!(blank.color, "#3ecf8e");
        assert_eq!(blank.payload(), None);
    }

    #[test]
    fn form_validation_and_payload() {
        let mut f = GoalForm::new(None);
        f.name = "  Trip ".into();
        f.target = "1,000".into();
        let p = f.payload().unwrap();
        assert_eq!(p.name, "Trip");
        assert_eq!(p.target_cents, 100_000);
        assert_eq!(p.saved_cents, 0);
        assert_eq!(p.monthly_cents, 0);
        assert_eq!(p.note, None);
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r##"{"name":"Trip","targetCents":100000,"savedCents":0,"monthlyCents":0,"linkedAccountId":null,"targetDate":null,"color":"#3ecf8e","note":null}"##
        );
        // Bad monthly text counts as 0; bad saved text blocks the save.
        f.monthly = "abc".into();
        assert_eq!(f.payload().unwrap().monthly_cents, 0);
        f.saved = "x".into();
        assert_eq!(f.payload(), None);
        // …unless an account is linked, which ignores the saved field.
        f.linked_account_id = "acct".into();
        assert_eq!(
            f.payload().unwrap().linked_account_id.as_deref(),
            Some("acct")
        );
        f.target = "0".into();
        assert_eq!(f.payload(), None);
        f.target = "5".into();
        f.name = "   ".into();
        assert_eq!(f.payload(), None);
    }
}
