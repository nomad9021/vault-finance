//! Money formatting through the browser's `Intl.NumberFormat`, so Rust pages
//! print exactly what `formatCents` / `formatCentsWhole` in
//! packages/shared/src/money.ts print (same locale, same symbols).

use js_sys::{
    Array, Date,
    Intl::{DateTimeFormat, NumberFormat},
    Object, Reflect,
};
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

/// `new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined,
/// { month: "short", year: "2-digit", timeZone: "UTC" })`, e.g. "Nov 26".
pub fn month_label(year: i32, month: u32) -> String {
    let opts = Object::new();
    for (k, v) in [("month", "short"), ("year", "2-digit"), ("timeZone", "UTC")] {
        let _ = Reflect::set(&opts, &k.into(), &v.into());
    }
    let f = DateTimeFormat::new(&Array::new(), &opts);
    let ms = js_sys::Date::utc(year as f64, month as f64 - 1.0);
    let date = js_sys::Date::new(&JsValue::from(ms));
    f.format()
        .call1(&JsValue::NULL, &date)
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_default()
}

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

/// `"2026-11"` → `"Nov"`:`toLocaleDateString(undefined, { month: "short",
/// timeZone: "UTC" })` of the first of that month.
pub fn month_short(month: &str) -> String {
    let mut parts = month
        .split('-')
        .map(|p| p.parse::<f64>().unwrap_or(f64::NAN));
    let (y, m) = (
        parts.next().unwrap_or(f64::NAN),
        parts.next().unwrap_or(f64::NAN),
    );
    let ms = Date::utc(y, m - 1.0);
    date_format(
        &Date::new(&ms.into()),
        &[("month", "short"), ("timeZone", "UTC")],
    )
}

/// Today plus `months` (JS `setMonth` overflow rules) as "Mar 2028".
pub fn month_year_from_now(months: u32) -> String {
    let d = Date::new_0();
    d.set_month(d.get_month() + months);
    date_format(&d, &[("month", "short"), ("year", "numeric")])
}
