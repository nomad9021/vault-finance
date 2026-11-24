//! Mirrors the parsing half of packages/shared/src/money.ts. Formatting goes
//! through the browser's `Intl` (vault-ui/src/fmt.rs); parsing and the
//! amount-field text are pure and live here.

/// `parseAmountToCents(input)`: a user-entered amount ("1,234.56", "$12",
/// "-3.5", "−3.50") in cents, or `None` for anything that isn't a clean
/// number. Whole-number arithmetic on the digits, so no float can shift a cent.
pub fn parse_amount_to_cents(input: &str) -> Option<i64> {
    // input.replace(/[$,\s]/g, "") — JS \s is Unicode whitespace plus BOM.
    let cleaned: String = input
        .chars()
        .filter(|&c| !(c == '$' || c == ',' || c.is_whitespace() || c == '\u{feff}'))
        .collect();
    // .replace(/^−/, "-")
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
        Some(("", f)) => {
            if f.is_empty() || f.len() > 2 || !digits(f) {
                return None;
            }
            ("", f)
        }
        Some((w, f)) => {
            if !digits(w) || f.len() > 2 || !digits(f) {
                return None;
            }
            (w, f)
        }
        None => {
            if body.is_empty() || !digits(body) {
                return None;
            }
            (body, "")
        }
    };
    // Number(digits) then a safe-integer check: beyond 2^53 JS can't hold the
    // cents exactly, and returns null.
    const MAX_SAFE: i128 = (1 << 53) - 1;
    let whole = whole.trim_start_matches('0');
    if whole.len() > 20 {
        return None;
    }
    let dollars: i128 = if whole.is_empty() {
        0
    } else {
        whole.parse().ok()?
    };
    let fraction: i128 = format!("{fraction:0<2}").parse().ok()?;
    let cents = dollars * 100 + fraction;
    if cents > MAX_SAFE {
        return None;
    }
    let cents = cents as i64;
    Some(if negative && cents != 0 {
        -cents
    } else {
        cents
    })
}

/// `(cents / 100).toFixed(2)`: the text an amount field starts with.
pub fn cents_to_fixed2(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

/// `(cents / 100).toFixed(0)`: whole dollars, halves rounded away from zero
/// (a value like 12.5 is exact in binary, and toFixed rounds it up).
pub fn cents_to_fixed0(cents: i64) -> String {
    let abs = cents.unsigned_abs();
    let dollars = (abs + 50) / 100;
    if cents < 0 && dollars != 0 {
        format!("-{dollars}")
    } else if cents < 0 {
        "-0".into()
    } else {
        dollars.to_string()
    }
}

/// JS `Math.round` for display percentages: halves go up, and the result is
/// an integer so −0 can't print as "-0".
pub fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    // The cases from packages/shared/src/money.test.ts.
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
        for bad in [
            "",
            "abc",
            "1.2.3",
            "1.234",
            "-",
            ".",
            "--1",
            "1e3",
            "+1",
            "1-",
            "\u{2212}\u{2212}1",
        ] {
            assert_eq!(parse_amount_to_cents(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn regex_edge_cases_match_the_typescript() {
        assert_eq!(parse_amount_to_cents("12."), Some(1200));
        assert_eq!(parse_amount_to_cents(".5"), Some(50));
        assert_eq!(parse_amount_to_cents("-.05"), Some(-5));
        assert_eq!(parse_amount_to_cents("-0"), Some(0));
        assert_eq!(parse_amount_to_cents("007.10"), Some(710));
        assert_eq!(parse_amount_to_cents("1,,000"), Some(100000));
        assert_eq!(parse_amount_to_cents("$-5"), Some(-500));
        // Only a leading unicode minus is translated.
        assert_eq!(parse_amount_to_cents("5\u{2212}"), None);
    }

    #[test]
    fn does_not_lose_a_cent_to_float_error() {
        assert_eq!(parse_amount_to_cents("11.10"), Some(1110));
        assert_eq!(parse_amount_to_cents("1.15"), Some(115));
        assert_eq!(parse_amount_to_cents("8.87"), Some(887));
    }

    #[test]
    fn reads_every_cent_value_exactly() {
        for cents in 0..10_000 {
            let text = format!("{}.{:02}", cents / 100, cents % 100);
            assert_eq!(parse_amount_to_cents(&text), Some(cents));
        }
    }

    #[test]
    fn stays_exact_on_large_amounts_and_rejects_unsafe_ones() {
        assert_eq!(parse_amount_to_cents("1234567.89"), Some(123_456_789));
        assert_eq!(
            parse_amount_to_cents("4503599627370.49"),
            Some(450_359_962_737_049)
        );
        assert_eq!(
            parse_amount_to_cents("90071992547409.91"),
            Some(9_007_199_254_740_991)
        );
        assert_eq!(parse_amount_to_cents("90071992547409.92"), None);
        assert_eq!(parse_amount_to_cents("99999999999999999999999"), None);
    }

    #[test]
    fn fixed_text_matches_to_fixed() {
        assert_eq!(cents_to_fixed2(1_500_000), "15000.00");
        assert_eq!(cents_to_fixed2(5), "0.05");
        assert_eq!(cents_to_fixed2(-350), "-3.50");
        assert_eq!(cents_to_fixed2(0), "0.00");
        assert_eq!(cents_to_fixed0(500_000), "5000");
        assert_eq!(cents_to_fixed0(150_050), "1501");
        assert_eq!(cents_to_fixed0(150_049), "1500");
    }

    #[test]
    fn js_round_rounds_halves_up() {
        assert_eq!(js_round(12.5), 13);
        assert_eq!(js_round(-0.4), 0);
        assert_eq!(js_round(-0.5), 0);
        assert_eq!(js_round(99.6), 100);
    }
}
