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
    let abs = run(
        &formatter("USD", Some(2), 2),
        cents.unsigned_abs() as f64 / 100.0,
    );
    if cents < 0 {
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
    let dollars = (cents.unsigned_abs() as f64 / 100.0 + 0.5).floor();
    let abs = run(&formatter("USD", None, 0), dollars);
    if cents < 0 {
        format!("\u{2212}{abs}")
    } else {
        abs
    }
}

/// `new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {…, timeZone: "UTC"})`.
fn utc_date(year: i32, month: u32, day: u32, opts: &[(&str, &str)]) -> String {
    let o = Object::new();
    for (k, v) in opts.iter().chain([("timeZone", "UTC")].iter()) {
        let _ = Reflect::set(&o, &(*k).into(), &(*v).into());
    }
    let ms = Date::utc(year as f64, month as f64 - 1.0) + (day as f64 - 1.0) * 86_400_000.0;
    let date = Date::new(&JsValue::from_f64(ms));
    DateTimeFormat::new(&Array::new(), &o)
        .format()
        .call1(&JsValue::NULL, &date)
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_default()
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
