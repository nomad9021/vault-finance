//! Calendar maths for the date picker (mirrors the helpers at the bottom of
//! packages/ui/src/primitives/DateField.tsx). Plain YYYY-MM-DD calendar
//! dates, no time zones: the app stores bare dates and the TypeScript does all
//! of this in UTC.

/// A month on the calendar grid (`month` is 1–12).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Month {
    pub year: i32,
    pub month: u32,
}

/// One real day cell on the grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayCell {
    pub iso: String,
    pub day: u32,
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// 0 = Sunday … 6 = Saturday, like `Date#getUTCDay`.
pub fn weekday(year: i32, month: u32, day: u32) -> u32 {
    const T: [i32; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y = if month < 3 { year - 1 } else { year };
    (y + y.div_euclid(4) - y.div_euclid(100)
        + y.div_euclid(400)
        + T[month as usize - 1]
        + day as i32)
        .rem_euclid(7) as u32
}

pub fn to_iso(year: i32, month: u32, day: u32) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

/// `parseISO`: `Some((y, m, d))` for a plain calendar date. Like V8's
/// `Date.parse`, a day up to 31 past the month's end rolls over (Feb 30 →
/// Mar 2) and anything else out of range is rejected.
pub fn parse_iso(iso: &str) -> Option<(i32, u32, u32)> {
    let b = iso.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    let (y, m, d) = (&iso[0..4], &iso[5..7], &iso[8..10]);
    if !digits(y) || !digits(m) || !digits(d) {
        return None;
    }
    let (y, m, d): (i32, u32, u32) = (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let dim = days_in_month(y, m);
    if d > dim {
        let next = Month { year: y, month: m }.shift(1);
        return Some((next.year, next.month, d - dim));
    }
    Some((y, m, d))
}

impl Month {
    /// `monthOf(iso)`: the month a value sits in, or `today`'s month when the
    /// value isn't a date.
    pub fn of(iso: &str, today: &str) -> Month {
        let (year, month, _) = parse_iso(iso)
            .or_else(|| parse_iso(today))
            .unwrap_or((1970, 1, 1));
        Month { year, month }
    }

    /// `shiftMonth`: always lands on a month, never overflows a day.
    pub fn shift(self, delta: i32) -> Month {
        let index = self.year * 12 + self.month as i32 - 1 + delta;
        Month {
            year: index.div_euclid(12),
            month: index.rem_euclid(12) as u32 + 1,
        }
    }

    pub fn first_iso(self) -> String {
        to_iso(self.year, self.month, 1)
    }

    /// `daysFor`: Monday-first cells, with leading blanks for alignment.
    pub fn days(self) -> Vec<Option<DayCell>> {
        let lead = (weekday(self.year, self.month, 1) + 6) % 7;
        let mut cells: Vec<Option<DayCell>> = (0..lead).map(|_| None).collect();
        for day in 1..=days_in_month(self.year, self.month) {
            cells.push(Some(DayCell {
                iso: to_iso(self.year, self.month, day),
                day,
            }));
        }
        cells
    }
}

/// `outOfRange`: plain string comparison works on YYYY-MM-DD.
pub fn out_of_range(iso: &str, min: Option<&str>, max: Option<&str>) -> bool {
    min.is_some_and(|m| !m.is_empty() && iso < m) || max.is_some_and(|m| !m.is_empty() && iso > m)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The cases from packages/ui/src/primitives/DateField.test.ts.
    fn first(year: i32, month: u32) -> Month {
        Month { year, month }
    }
    fn real(m: Month) -> Vec<DayCell> {
        m.days().into_iter().flatten().collect()
    }
    fn lead(m: Month) -> usize {
        m.days().iter().position(Option::is_some).unwrap()
    }

    #[test]
    fn parses_plain_dates_only() {
        assert_eq!(parse_iso("2026-12-24"), Some((2026, 12, 24)));
        assert_eq!(parse_iso("2026-02-30"), Some((2026, 3, 2)));
        assert_eq!(parse_iso("2026-04-31"), Some((2026, 5, 1)));
        for bad in [
            "",
            "2026-12",
            "24/12/2026",
            "2026-12-24T10:00:00Z",
            "nope",
            "2026-02-00",
            "2026-02-32",
            "2026-13-01",
        ] {
            assert_eq!(parse_iso(bad), None, "{bad}");
        }
    }

    #[test]
    fn month_of_falls_back_and_snaps() {
        assert_eq!(Month::of("", "2026-11-24"), first(2026, 11));
        assert_eq!(
            Month::of("2026-12-24", "2026-11-24").first_iso(),
            "2026-12-01"
        );
    }

    #[test]
    fn pages_across_years() {
        assert_eq!(first(2026, 12).shift(1).first_iso(), "2027-01-01");
        assert_eq!(first(2026, 1).shift(-1).first_iso(), "2025-12-01");
        assert_eq!(
            Month::of("2026-01-31", "").shift(1).first_iso(),
            "2026-02-01"
        );
        assert_eq!(first(2026, 3).shift(-27), first(2023, 12));
    }

    #[test]
    fn every_month_has_its_real_length() {
        assert_eq!(real(first(2026, 1)).len(), 31);
        assert_eq!(real(first(2026, 2)).len(), 28);
        assert_eq!(real(first(2026, 4)).len(), 30);
        assert_eq!(real(first(2028, 2)).len(), 29);
        assert_eq!(real(first(2000, 2)).len(), 29);
        assert_eq!(real(first(1900, 2)).len(), 28);
    }

    #[test]
    fn pads_monday_first() {
        assert_eq!(lead(first(2026, 1)), 3);
        assert_eq!(lead(first(2026, 2)), 6);
        assert_eq!(lead(first(2026, 6)), 0);
    }

    #[test]
    fn numbers_days_sequentially() {
        let cells = real(first(2026, 2));
        assert_eq!(
            cells[0],
            DayCell {
                iso: "2026-02-01".into(),
                day: 1
            }
        );
        assert_eq!(cells.last().unwrap().iso, "2026-02-28");
    }

    #[test]
    fn range_bounds() {
        assert!(out_of_range("2026-01-01", Some("2026-01-02"), None));
        assert!(out_of_range("2026-01-03", None, Some("2026-01-02")));
        assert!(!out_of_range(
            "2026-01-02",
            Some("2026-01-02"),
            Some("2026-01-02")
        ));
        assert!(!out_of_range("2026-01-02", None, None));
    }
}
