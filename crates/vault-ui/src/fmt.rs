//! Money formatting through the browser's `Intl.NumberFormat`, so Rust pages
//! print exactly what `formatCents` / `formatCentsWhole` in
//! packages/shared/src/money.ts print (same locale, same symbols).

use js_sys::{Array, Intl::NumberFormat, Object, Reflect};
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
