//! Mirrors packages/shared/src/schemas/bills.ts, plus the
//! list, calendar and form logic of apps/desktop/src/screens/shell/BillsPage.tsx.

use serde::{Deserialize, Serialize};

use crate::dates::{days_in_month, weekday};
use crate::goals::trim_js;
use crate::money::{cents_to_fixed2, js_round, parse_amount_to_cents};

/// Swatches offered in the bill dialog, first is the default.
pub const BILL_COLORS: [&str; 7] = [
    "#6f8ef2", "#ef8354", "#3ecf8e", "#c96f9c", "#d8b23c", "#4db6d0", "#b47ef0",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BillCadence {
    Weekly,
    Monthly,
    Quarterly,
    Yearly,
}

impl BillCadence {
    pub const ALL: [BillCadence; 4] = [
        BillCadence::Weekly,
        BillCadence::Monthly,
        BillCadence::Quarterly,
        BillCadence::Yearly,
    ];

    /// The wire value, which the list row prints as is.
    pub fn as_str(self) -> &'static str {
        match self {
            BillCadence::Weekly => "weekly",
            BillCadence::Monthly => "monthly",
            BillCadence::Quarterly => "quarterly",
            BillCadence::Yearly => "yearly",
        }
    }

    /// `c[0].toUpperCase() + c.slice(1)`.
    pub fn label(self) -> &'static str {
        match self {
            BillCadence::Weekly => "Weekly",
            BillCadence::Monthly => "Monthly",
            BillCadence::Quarterly => "Quarterly",
            BillCadence::Yearly => "Yearly",
        }
    }

    pub fn parse(s: &str) -> Option<BillCadence> {
        BillCadence::ALL.into_iter().find(|c| c.as_str() == s)
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bill {
    pub id: String,
    pub name: String,
    pub amount_cents: i64,
    pub saved_cents: i64,
    pub due_day: u32,
    pub cadence: BillCadence,
    pub autopay: bool,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub color: String,
    /// Server-computed next occurrence, YYYY-MM-DD.
    pub next_due_date: String,
    /// Server-computed whole days until `next_due_date` (negative if overdue).
    pub days_until_due: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillListResponse {
    pub bills: Vec<Bill>,
    pub total_due_cents: i64,
    pub total_saved_cents: i64,
}

/// How urgent a due date reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DueTone {
    Over,
    Soon,
    Ok,
}

impl DueTone {
    pub fn color(self) -> &'static str {
        match self {
            DueTone::Over => "var(--color-negative)",
            DueTone::Soon => "var(--color-accent)",
            DueTone::Ok => "var(--content-tertiary)",
        }
    }
}

/// `dueLabel(days)`.
pub fn due_label(days: i64) -> (String, DueTone) {
    match days {
        d if d < 0 => (format!("{}d overdue", d.unsigned_abs()), DueTone::Over),
        0 => ("Due today".into(), DueTone::Over),
        1 => ("Due tomorrow".into(), DueTone::Soon),
        d if d <= 7 => (format!("Due in {d} days"), DueTone::Soon),
        d => (format!("Due in {d} days"), DueTone::Ok),
    }
}

impl Bill {
    /// Share set aside, 0–1 (0 for a zero amount).
    pub fn progress(&self) -> f64 {
        if self.amount_cents > 0 {
            (self.saved_cents as f64 / self.amount_cents as f64).min(1.0)
        } else {
            0.0
        }
    }

    pub fn funded(&self) -> bool {
        self.saved_cents >= self.amount_cents
    }
}

/// The page-head totals: (upcoming, set aside, still to set aside).
pub fn totals(data: Option<&BillListResponse>) -> (i64, i64, i64) {
    let due = data.map_or(0, |d| d.total_due_cents);
    let saved = data.map_or(0, |d| d.total_saved_cents);
    (due, saved, (due - saved).max(0))
}

/// One day on the bill calendar.
#[derive(Debug, Clone, PartialEq)]
pub struct CalendarDay {
    pub day: u32,
    /// Indexes into the bill list, in list order.
    pub bills: Vec<usize>,
    pub total_cents: i64,
    pub is_today: bool,
    pub is_past: bool,
    /// The `color-mix` share of accent behind a day with bills (3–17).
    pub heat_pct: i64,
}

/// `BillCalendar`'s month grid for `year`/`month` (1–12), `today` being the
/// day of the month it is now.
#[derive(Debug, Clone, PartialEq)]
pub struct BillMonth {
    /// Blank cells before the 1st, Monday-first.
    pub lead: u32,
    pub days: Vec<CalendarDay>,
    pub total_cents: i64,
}

/// Which days of the month a bill lands on: weekly bills on every day
/// matching `min(dueDay, 7) % 7`, the rest once, clamped to the month.
fn days_for(bill: &Bill, days_in_month: u32) -> Vec<u32> {
    if bill.cadence == BillCadence::Weekly {
        let k = bill.due_day.min(7) % 7;
        (1..=days_in_month).filter(|d| d % 7 == k).collect()
    } else {
        vec![bill.due_day.min(days_in_month)]
    }
}

pub fn bill_month(bills: &[Bill], year: i32, month: u32, today: u32) -> BillMonth {
    let dim = days_in_month(year, month);
    let mut by_day: Vec<Vec<usize>> = vec![Vec::new(); dim as usize + 1];
    for (i, bill) in bills.iter().enumerate() {
        for d in days_for(bill, dim) {
            by_day[d as usize].push(i);
        }
    }
    let day_total = |list: &[usize]| list.iter().map(|&i| bills[i].amount_cents).sum::<i64>();
    let total_cents = by_day.iter().map(|l| day_total(l)).sum();
    let heaviest = by_day.iter().map(|l| day_total(l)).fold(1, i64::max);
    let days = (1..=dim)
        .map(|day| {
            let list = std::mem::take(&mut by_day[day as usize]);
            let total = day_total(&list);
            CalendarDay {
                day,
                total_cents: total,
                is_today: day == today,
                is_past: day < today,
                heat_pct: js_round(total as f64 / heaviest as f64 * 14.0) + 3,
                bills: list,
            }
        })
        .collect();
    BillMonth {
        lead: (weekday(year, month, 1) + 6) % 7,
        days,
        total_cents,
    }
}

/// Body of `createBill` / `updateBill`. `None` goes over as `null`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillPayload {
    pub name: String,
    pub amount_cents: i64,
    pub due_day: u32,
    pub cadence: BillCadence,
    pub autopay: bool,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub color: String,
}

/// The bill dialog's fields, as typed.
#[derive(Debug, Clone, PartialEq)]
pub struct BillForm {
    pub name: String,
    pub amount: String,
    pub due_day: String,
    pub cadence: BillCadence,
    pub autopay: bool,
    pub account_id: String,
    pub category_id: String,
    pub color: String,
}

/// `.replace(/[^0-9]/g, "")` on the due-day field.
pub fn digits_only(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

impl BillForm {
    pub fn new(bill: Option<&Bill>) -> Self {
        match bill {
            None => BillForm {
                name: String::new(),
                amount: String::new(),
                due_day: "1".into(),
                cadence: BillCadence::Monthly,
                autopay: false,
                account_id: String::new(),
                category_id: String::new(),
                color: BILL_COLORS[0].into(),
            },
            Some(b) => BillForm {
                name: b.name.clone(),
                amount: cents_to_fixed2(b.amount_cents),
                due_day: b.due_day.to_string(),
                cadence: b.cadence,
                autopay: b.autopay,
                account_id: b.account_id.clone().unwrap_or_default(),
                category_id: b.category_id.clone().unwrap_or_default(),
                color: b.color.clone(),
            },
        }
    }

    /// The request body, or `None` while Save stays disabled: a name, a
    /// positive amount and a due day of 1–31.
    pub fn payload(&self) -> Option<BillPayload> {
        let amount_cents = parse_amount_to_cents(&self.amount).unwrap_or(-1);
        // Number(dueDay): "" is 0; the field only ever holds digits.
        let day: u64 = if self.due_day.is_empty() {
            0
        } else {
            self.due_day.parse().unwrap_or(u64::MAX)
        };
        let name = trim_js(&self.name);
        if name.is_empty() || amount_cents <= 0 || !(1..=31).contains(&day) {
            return None;
        }
        let opt = |s: &str| (!s.is_empty()).then(|| s.to_string());
        Some(BillPayload {
            name: name.to_string(),
            amount_cents,
            due_day: day as u32,
            cadence: self.cadence,
            autopay: self.autopay,
            account_id: opt(&self.account_id),
            category_id: opt(&self.category_id),
            color: self.color.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r##"{"bills":[
      {"id":"4f3c2b1a-0e9d-4c8b-a7f6-e5d4c3b2a190","name":"Rent","amountCents":185000,"savedCents":92500,
       "dueDay":1,"cadence":"monthly","autopay":true,"accountId":"0e5d2a51-5b8e-4b8e-8e0e-2f6a1c9d7b31",
       "categoryId":null,"color":"#6f8ef2","nextDueDate":"2026-12-01","daysUntilDue":7},
      {"id":"9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d","name":"Gym","amountCents":2500,"savedCents":2500,
       "dueDay":3,"cadence":"weekly","autopay":false,"accountId":null,
       "categoryId":"5d1c0c8e-8a43-4a4e-9a51-1f1d2b1c3c4d","color":"#3ecf8e","nextDueDate":"2026-11-25","daysUntilDue":1},
      {"id":"1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e","name":"Insurance","amountCents":64000,"savedCents":0,
       "dueDay":31,"cadence":"quarterly","autopay":false,"accountId":null,"categoryId":null,
       "color":"#d8b23c","nextDueDate":"2026-11-20","daysUntilDue":-4}
    ],"totalDueCents":251500,"totalSavedCents":95000}"##;

    fn sample() -> BillListResponse {
        serde_json::from_str(SAMPLE).unwrap()
    }

    #[test]
    fn parses_bill_list() {
        let r = sample();
        assert_eq!(r.bills.len(), 3);
        assert_eq!(r.bills[1].cadence, BillCadence::Weekly);
        assert_eq!(r.bills[2].days_until_due, -4);
        assert_eq!(
            r.bills[0].account_id.as_deref(),
            Some("0e5d2a51-5b8e-4b8e-8e0e-2f6a1c9d7b31")
        );
        assert_eq!(totals(Some(&r)), (251500, 95000, 156500));
        assert_eq!(totals(None), (0, 0, 0));
    }

    #[test]
    fn due_labels() {
        assert_eq!(due_label(-4), ("4d overdue".into(), DueTone::Over));
        assert_eq!(due_label(0), ("Due today".into(), DueTone::Over));
        assert_eq!(due_label(1), ("Due tomorrow".into(), DueTone::Soon));
        assert_eq!(due_label(7), ("Due in 7 days".into(), DueTone::Soon));
        assert_eq!(due_label(8), ("Due in 8 days".into(), DueTone::Ok));
    }

    #[test]
    fn progress_and_funded() {
        let r = sample();
        assert_eq!(r.bills[0].progress(), 0.5);
        assert!(!r.bills[0].funded());
        assert!(r.bills[1].funded());
        let mut zero = r.bills[2].clone();
        zero.amount_cents = 0;
        assert_eq!(zero.progress(), 0.0);
        assert!(zero.funded());
    }

    #[test]
    fn calendar_month() {
        let r = sample();
        // February 2027: 28 days, starts on a Monday.
        let m = bill_month(&r.bills, 2027, 2, 10);
        assert_eq!(m.lead, 0);
        assert_eq!(m.days.len(), 28);
        // Rent on the 1st, gym (weekly, dueDay 3) on 3, 10, 17, 24,
        // insurance's 31st clamped to the 28th.
        assert_eq!(m.days[0].bills, vec![0]);
        let gym: Vec<u32> = m
            .days
            .iter()
            .filter(|d| d.bills.contains(&1))
            .map(|d| d.day)
            .collect();
        assert_eq!(gym, vec![3, 10, 17, 24]);
        assert_eq!(m.days[27].bills, vec![2]);
        assert_eq!(m.total_cents, 185000 + 4 * 2500 + 64000);
        assert_eq!(m.days[0].heat_pct, 17);
        // round(2500 / 185000 * 14) + 3
        assert_eq!(m.days[2].heat_pct, 3);
        assert_eq!(m.days[1].heat_pct, 3);
        assert_eq!(m.days[1].total_cents, 0);
        assert!(m.days[8].is_past && m.days[9].is_today && !m.days[10].is_past);
        // November 2026 starts on a Sunday.
        assert_eq!(bill_month(&[], 2026, 11, 24).lead, 6);
    }

    #[test]
    fn weekly_day_seven_and_beyond_lands_on_sevens() {
        let mut b = sample().bills[1].clone();
        b.due_day = 12;
        assert_eq!(days_for(&b, 30), vec![7, 14, 21, 28]);
    }

    #[test]
    fn form_payload() {
        let mut f = BillForm::new(None);
        assert_eq!(f.payload(), None);
        f.name = "  Electric ".into();
        f.amount = "84.5".into();
        let p = f.payload().unwrap();
        assert_eq!(p.name, "Electric");
        assert_eq!(p.amount_cents, 8450);
        assert_eq!(p.due_day, 1);
        assert_eq!(p.account_id, None);
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({"name":"Electric","amountCents":8450,"dueDay":1,"cadence":"monthly",
                "autopay":false,"accountId":null,"categoryId":null,"color":"#6f8ef2"})
        );
        for bad in ["", "0", "32", "99999999999999999999999"] {
            f.due_day = bad.into();
            assert_eq!(f.payload(), None, "{bad}");
        }
        f.due_day = "031".into();
        assert_eq!(f.payload().unwrap().due_day, 31);
        f.amount = "0".into();
        assert_eq!(f.payload(), None);
        assert_eq!(digits_only("1a2-"), "12");
    }

    #[test]
    fn form_from_bill() {
        let r = sample();
        let f = BillForm::new(Some(&r.bills[0]));
        assert_eq!(f.amount, "1850.00");
        assert_eq!(f.due_day, "1");
        assert!(f.autopay);
        assert_eq!(f.category_id, "");
        assert_eq!(f.payload().unwrap().account_id, r.bills[0].account_id);
    }
}
