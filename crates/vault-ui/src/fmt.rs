//! Money formatting through the browser's `Intl.NumberFormat`, so Rust pages
//! print exactly what `formatCents` / `formatCentsWhole` in
//! packages/shared/src/money.ts print (same locale, same symbols).

use js_sys::{
    Array, Date,
    Intl::{DateTimeFormat, NumberFormat},
    Object, Reflect,
};
use vault_core::dates::{parse_iso, Month};
use wasm_bindgen::JsValue;

fn formatter(currency: &str, min: Option<u8>, max: u8) -> NumberFormat {
    let opts = Object::new();
    let set = |k: &str, v: JsValue| {
        let _ = Reflect::set(&opts, &k.into(), &v);
    };
    set("style", "currency".into());
    set("currency", currency.into());
    if let Some(min) = min {
        set("minimumFractionDigits", min.into());
    }
    set("maximumFractionDigits", max.into());
    NumberFormat::new(&Array::new(), &opts)
}

fn run(f: &NumberFormat, n: f64) -> String {
    f.format()
        .call1(&JsValue::NULL, &n.into())
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_default()
}

/// `formatCents(cents)`: two decimals, minus sign as U+2212.
pub fn cents(cents: i64) -> String {
    cents_in(cents, "USD")
}

/// `formatCents(cents, { currency })`.
pub fn cents_in(cents: i64, currency: &str) -> String {
    let abs = run(
        &formatter(currency, Some(2), 2),
        cents.unsigned_abs() as f64 / 100.0,
    );
    if cents < 0 {
        format!("\u{2212}{abs}")
    } else {
        abs
    }
}

/// `formatCents` of a figure that may have fractions of a cent (a monthly
/// amount scaled to a week): `Intl` rounds it.
pub fn cents_f64(cents: f64) -> String {
    let abs = run(&formatter("USD", Some(2), 2), cents.abs() / 100.0);
    if cents < 0.0 {
        format!("\u{2212}{abs}")
    } else {
        abs
    }
}

/// `formatCents(cents, { signed: true })`.
pub fn cents_signed(cents: i64) -> String {
    let abs = run(
        &formatter("USD", Some(2), 2),
        cents.unsigned_abs() as f64 / 100.0,
    );
    format!("{}{abs}", if cents < 0 { '\u{2212}' } else { '+' })
}

/// `formatCentsWhole(cents)`: whole dollars, rounded like `Math.round`.
pub fn cents_whole(cents: i64) -> String {
    cents_whole_f64(cents as f64)
}

/// `formatCentsWhole` for figures that are JS doubles (the debt planner's
/// totals can run far past `i64`).
pub fn cents_whole_f64(cents: f64) -> String {
    let dollars = (cents.abs() / 100.0 + 0.5).floor();
    let abs = run(&formatter("USD", None, 0), dollars);
    if cents < 0.0 {
        format!("\u{2212}{abs}")
    } else {
        abs
    }
}

/// `date.toLocaleDateString(undefined, opts)`.
fn date_format(date: &Date, opts: &[(&str, &str)]) -> String {
    let o = Object::new();
    for (k, v) in opts {
        let _ = Reflect::set(&o, &(*k).into(), &(*v).into());
    }
    DateTimeFormat::new(&Array::new(), &o)
        .format()
        .call1(&JsValue::NULL, date)
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_default()
}

/// `new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {…, timeZone: "UTC"})`.
fn utc_date(year: i32, month: u32, day: u32, opts: &[(&str, &str)]) -> String {
    let ms = Date::utc(year as f64, month as f64 - 1.0) + (day as f64 - 1.0) * 86_400_000.0;
    let opts: Vec<(&str, &str)> = opts.iter().copied().chain([("timeZone", "UTC")]).collect();
    date_format(&Date::new(&JsValue::from_f64(ms)), &opts)
}

/// `dueDateShort` on the bills page: "Dec 1" (the raw text if it isn't a date).
pub fn day_short(iso: &str) -> String {
    match parse_iso(iso) {
        Some((y, m, d)) => utc_date(y, m, d, &[("month", "short"), ("day", "numeric")]),
        None => iso.to_string(),
    }
}

/// `monthLabel("2027-09")` on the goals page: "Sep 2027".
pub fn month_short_year(month: &str) -> String {
    let mut parts = month.split('-').map(|p| p.parse::<i32>().unwrap_or(0));
    let (y, m) = (parts.next().unwrap_or(0), parts.next().unwrap_or(1));
    utc_date(
        y,
        m.max(0) as u32,
        1,
        &[("month", "short"), ("year", "numeric")],
    )
}

/// The date picker's month heading: "November 2026".
pub fn month_long_year(m: Month) -> String {
    utc_date(
        m.year,
        m.month,
        1,
        &[("month", "long"), ("year", "numeric")],
    )
}

/// The date picker's trigger text: "Nov 24, 2026" (the raw text if it
/// isn't a date).
pub fn long_date(iso: &str) -> String {
    match parse_iso(iso) {
        Some((y, m, d)) => utc_date(
            y,
            m,
            d,
            &[("day", "numeric"), ("month", "short"), ("year", "numeric")],
        ),
        None => iso.to_string(),
    }
}

/// `new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined,
/// { month: "short", year: "2-digit", timeZone: "UTC" })`, e.g. "Nov 26".
pub fn month_label(year: i32, month: u32) -> String {
    utc_date(year, month, 1, &[("month", "short"), ("year", "2-digit")])
}

/// `"2026-11"` → `"Nov"` (Cash Flow bars): `toLocaleDateString(undefined,
/// { month: "short", timeZone: "UTC" })` of the first of that month.
pub fn month_short(month: &str) -> String {
    let mut parts = month.split('-').map(|p| p.parse::<i32>().unwrap_or(0));
    let (y, m) = (parts.next().unwrap_or(0), parts.next().unwrap_or(1));
    utc_date(y, m.max(0) as u32, 1, &[("month", "short")])
}

/// Today plus `months` (JS `setMonth` overflow rules), in local time, as
/// "Mar 2028": the debt planner's `payoffDate`.
pub fn month_year_from_now(months: u32) -> String {
    let d = Date::new_0();
    d.set_month(d.get_month() + months);
    date_format(&d, &[("month", "short"), ("year", "numeric")])
}

/// `{ weekday: "short", month: "short", day: "numeric" }`: "Tue, Nov 24".
pub fn weekday_date(iso: &str) -> String {
    match parse_iso(iso.get(..10).unwrap_or(iso)) {
        Some((y, m, d)) => utc_date(
            y,
            m,
            d,
            &[("weekday", "short"), ("month", "short"), ("day", "numeric")],
        ),
        None => iso.to_string(),
    }
}

/// `{ weekday: "short" }`: "Tue".
pub fn weekday_short(iso: &str) -> String {
    match parse_iso(iso.get(..10).unwrap_or(iso)) {
        Some((y, m, d)) => utc_date(y, m, d, &[("weekday", "short")]),
        None => iso.to_string(),
    }
}

/// `periodLabel(period, start)` (lib/reviewPrefs.ts): "November 2026" or
/// "Week of Nov 16 – 22, 2026" (`end` is the week's last day).
pub fn period_label(week: bool, start: &str, end: &str) -> String {
    let (Some((y, m, d)), Some((ly, lm, ld))) = (parse_iso(start), parse_iso(end)) else {
        return start.to_string();
    };
    if !week {
        return month_long_year(Month { year: y, month: m });
    }
    let first = utc_date(y, m, d, &[("month", "short"), ("day", "numeric")]);
    let last = if lm == m {
        utc_date(ly, lm, ld, &[("day", "numeric"), ("year", "numeric")])
    } else {
        utc_date(
            ly,
            lm,
            ld,
            &[("month", "short"), ("day", "numeric"), ("year", "numeric")],
        )
    };
    format!("Week of {first} – {last}")
}

/// Today in UTC, "YYYY-MM-DD" (`new Date().toISOString().slice(0, 10)`).
pub fn today_utc() -> String {
    let d = Date::new_0();
    vault_core::dates::to_iso(
        d.get_utc_full_year() as i32,
        d.get_utc_month() + 1,
        d.get_utc_date(),
    )
}

/// `new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short",
/// day: "numeric", timeZone: "UTC" })`, e.g. "Dec 3" (Subscriptions).
pub fn short_date(iso: &str) -> String {
    day_short(iso)
}

/// `n.toLocaleString()` for a whole number ("1,234").
pub fn count(n: i64) -> String {
    let f = NumberFormat::new(&Array::new(), &Object::new());
    run(&f, n as f64)
}

/// Today's local date, as `new Date()`'s getters read it.
pub fn today_local() -> (i32, u32, u32) {
    let d = Date::new_0();
    (d.get_full_year() as i32, d.get_month() + 1, d.get_date())
}

/// `new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { weekday:
/// "short", month: "short", day: "numeric", year? })` (local time), e.g.
/// "Mon, Nov 2".
pub fn weekday_month_day(ymd: &str, with_year: bool) -> String {
    let Some((y, m, d)) = parse_iso(ymd) else {
        return "Invalid Date".into();
    };
    let date = Date::new_with_year_month_day_hr(y as u32, m as i32 - 1, d as i32, 12);
    let mut opts = vec![("weekday", "short"), ("month", "short"), ("day", "numeric")];
    if with_year {
        opts.push(("year", "numeric"));
    }
    date_format(&date, &opts)
}
