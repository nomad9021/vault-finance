//! Mirrors the parsing half of packages/shared/src/money.ts. Display
//! formatting goes through the browser's `Intl` in vault-ui (`fmt.rs`).

/// Largest integer a JS number holds exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// `parseAmountToCents`: a user-entered amount ("1,234.56", "$12", "-3.5")
/// into cents, or `None` for anything that isn't a clean number.
pub fn parse_amount_to_cents(input: &str) -> Option<i64> {
    // `.replace(/[$,\s]/g, "")`: JS `\s` is Unicode whitespace.
    let cleaned: String = input
        .chars()
        .filter(|c| *c != '$' && *c != ',' && !is_js_space(*c))
        .collect();
    // `.replace(/^−/, "-")`
    let cleaned = match cleaned.strip_prefix('\u{2212}') {
        Some(rest) => format!("-{rest}"),
        None => cleaned,
    };
    // /^(-?)(?:(\d+)(?:\.(\d{0,2}))?|\.(\d{1,2}))$/
    let (negative, body) = match cleaned.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, cleaned.as_str()),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let (whole, fraction) = match body.split_once('.') {
        None => (body, ""),
        Some((w, f)) => (w, f),
    };
    let has_dot = body.contains('.');
    if !digits(whole) || !digits(fraction) {
        return None;
    }
    if whole.is_empty() {
        // `\.(\d{1,2})`
        if !has_dot || fraction.is_empty() || fraction.len() > 2 {
            return None;
        }
    } else if fraction.len() > 2 {
        return None;
    }
    // `Number(match[2] ?? 0)`: a huge digit string becomes an inexact float
    // there and fails the safe-integer check; failing to parse is the same.
    let dollars: i64 = if whole.is_empty() {
        0
    } else {
        whole.parse().ok()?
    };
    let fraction: i64 = format!("{fraction:0<2}").parse().ok()?;
    let cents = dollars.checked_mul(100)?.checked_add(fraction)?;
    if cents > MAX_SAFE_INTEGER {
        return None;
    }
    Some(if negative && cents != 0 {
        -cents
    } else {
        cents
    })
}

/// What JS regex `\s` matches.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `Math.round(x)`: halves round toward +∞ (so −2.5 → −2).
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `(cents / 100).toFixed(0)`: whole dollars, halves away from zero, and a
/// small negative keeps its sign ("-0") like JS.
pub fn cents_to_fixed0(cents: i64) -> String {
    let whole = (cents.unsigned_abs() + 50) / 100;
    if cents < 0 {
        format!("-{whole}")
    } else {
        whole.to_string()
    }
}

/// `x.toFixed(digits)` for the finite values SVG paths use: like `{:.N}` but an exact tie rounds away from zero (JS picks
/// the larger n) where Rust would round to even.
pub fn to_fixed(x: f64, digits: usize) -> String {
    let exact = format!("{:.*}", digits + 30, x.abs());
    let (keep, rest) = exact.split_at(exact.len() - 30);
    let tie = rest.starts_with('5') && rest[1..].bytes().all(|b| b == b'0');
    let s = if tie {
        let step = 10f64.powi(-(digits as i32));
        let base: f64 = keep.parse().unwrap_or(0.0);
        format!("{:.*}", digits, base + step)
    } else {
        format!("{:.*}", digits, x.abs())
    };
    // JS keeps the sign of any negative input, even when it rounds to zero.
    if x < 0.0 {
        format!("-{s}")
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // packages/shared/src/money.test.ts, describe("parseAmountToCents").
    #[test]
    fn parses_plain_and_decimal_amounts() {
        assert_eq!(parse_amount_to_cents("12"), Some(1200));
        assert_eq!(parse_amount_to_cents("12.34"), Some(1234));
        assert_eq!(parse_amount_to_cents("0.05"), Some(5));
    }

    #[test]
    fn strips_currency_symbols_commas_and_spaces() {
        assert_eq!(parse_amount_to_cents("$1,234.56"), Some(123456));
        assert_eq!(parse_amount_to_cents(" 1 234 "), Some(123400));
    }

    #[test]
    fn handles_negatives_including_unicode_minus() {
        assert_eq!(parse_amount_to_cents("-3.50"), Some(-350));
        assert_eq!(parse_amount_to_cents("\u{2212}3.50"), Some(-350));
    }

    #[test]
    fn rejects_anything_that_isnt_a_clean_number() {
        assert_eq!(parse_amount_to_cents(""), None);
        assert_eq!(parse_amount_to_cents("abc"), None);
        assert_eq!(parse_amount_to_cents("1.2.3"), None);
        assert_eq!(parse_amount_to_cents("1.234"), None);
    }

    #[test]
    fn does_not_lose_a_cent_to_float_error() {
        assert_eq!(parse_amount_to_cents("11.10"), Some(1110));
        assert_eq!(parse_amount_to_cents("1.15"), Some(115));
        assert_eq!(parse_amount_to_cents("8.87"), Some(887));
    }

    #[test]
    fn reads_every_cent_value_exactly() {
        for cents in 0..10_000i64 {
            let text = format!("{}.{:02}", cents / 100, cents % 100);
            assert_eq!(parse_amount_to_cents(&text), Some(cents), "{text}");
        }
    }

    #[test]
    fn stays_exact_on_large_amounts() {
        assert_eq!(parse_amount_to_cents("1234567.89"), Some(123_456_789));
        assert_eq!(
            parse_amount_to_cents("4503599627370.49"),
            Some(450_359_962_737_049)
        );
    }

    #[test]
    fn accepts_half_typed_forms() {
        assert_eq!(parse_amount_to_cents(".5"), Some(50));
        assert_eq!(parse_amount_to_cents(".05"), Some(5));
        assert_eq!(parse_amount_to_cents("12."), Some(1200));
        assert_eq!(parse_amount_to_cents("12.5"), Some(1250));
        assert_eq!(parse_amount_to_cents("-.5"), Some(-50));
        assert_eq!(parse_amount_to_cents("."), None);
        assert_eq!(parse_amount_to_cents("-"), None);
    }

    #[test]
    fn refuses_an_amount_too_large_to_hold_exactly() {
        assert_eq!(parse_amount_to_cents("999999999999999999.99"), None);
    }

    #[test]
    fn rejects_other_shapes_the_regex_rejects() {
        assert_eq!(parse_amount_to_cents("--5"), None);
        assert_eq!(parse_amount_to_cents("5-"), None);
        assert_eq!(parse_amount_to_cents(".123"), None);
        assert_eq!(parse_amount_to_cents("+5"), None);
        assert_eq!(parse_amount_to_cents("-0"), Some(0));
    }

    #[test]
    fn to_fixed_matches_js() {
        assert_eq!(to_fixed(12.25, 1), "12.3"); // JS: (12.25).toFixed(1)
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(190.0, 1), "190.0");
        assert_eq!(to_fixed(97.5, 1), "97.5");
        assert_eq!(to_fixed(1.05, 1), "1.1"); // 1.05000000000000004 in binary: not a tie
        assert_eq!(to_fixed(33.333333, 1), "33.3");
        assert_eq!(to_fixed(-2.25, 1), "-2.3");
    }

    #[test]
    fn js_round_and_to_fixed() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(1.4999), 1.0);
        assert_eq!(cents_to_fixed0(1250), "13");
        assert_eq!(cents_to_fixed0(1249), "12");
        assert_eq!(cents_to_fixed0(100_000), "1000");
        assert_eq!(cents_to_fixed0(-1250), "-13");
        assert_eq!(cents_to_fixed0(-40), "-0");
        assert_eq!(cents_to_fixed0(0), "0");
    }
}
