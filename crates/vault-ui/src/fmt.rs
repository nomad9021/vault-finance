//! Money formatting through the browser's `Intl.NumberFormat`, so Rust pages
//! print exactly what `formatCents` / `formatCentsWhole` in
//! packages/shared/src/money.ts print (same locale, same symbols).

use js_sys::{
    Array,
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
    let dollars = (cents.unsigned_abs() as f64 / 100.0 + 0.5).floor();
    let abs = run(&formatter("USD", None, 0), dollars);
    if cents < 0 {
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

/// `new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short",
/// day: "numeric", timeZone: "UTC" })`, e.g. "Dec 3".
pub fn short_date(iso: &str) -> String {
    let opts = Object::new();
    for (k, v) in [("month", "short"), ("day", "numeric"), ("timeZone", "UTC")] {
        let _ = Reflect::set(&opts, &k.into(), &v.into());
    }
    let date = js_sys::Date::new(&JsValue::from_str(&format!("{iso}T00:00:00Z")));
    DateTimeFormat::new(&Array::new(), &opts)
        .format()
        .call1(&JsValue::NULL, &date)
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_default()
}
