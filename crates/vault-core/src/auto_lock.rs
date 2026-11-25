//! The pure parts of apps/desktop/src/lib/autoLock.ts (when to lock) and
//! the saved-setting readers it relies on from apps/desktop/src/state/store.ts.

/// A tick this much later than expected means the computer was asleep.
pub const SLEEP_GAP_MS: f64 = 30_000.0;
/// How often the lock timer ticks.
pub const TICK_MS: f64 = 5_000.0;
/// `AUTO_LOCK_DEFAULT`: minutes.
pub const AUTO_LOCK_DEFAULT: f64 = 5.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockReason {
    /// The clock jumped: the computer slept or the lid closed.
    Sleep,
    /// No activity for the chosen minutes.
    Idle,
}

/// The decision for one tick (all times in ms).
pub fn should_lock(
    now: f64,
    last_tick: f64,
    last_activity: f64,
    auto_lock_minutes: f64,
) -> Option<LockReason> {
    if now - last_tick > TICK_MS + SLEEP_GAP_MS {
        return Some(LockReason::Sleep);
    }
    if auto_lock_minutes > 0.0 && now - last_activity >= auto_lock_minutes * 60_000.0 {
        return Some(LockReason::Idle);
    }
    None
}

/// JS `Number(s)` for a stored setting.
pub fn js_number(s: &str) -> f64 {
    let t = crate::serde_util::js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r| {
        t.get(..2)
            .filter(|h| h.eq_ignore_ascii_case(p))
            .map(|_| i64::from_str_radix(&t[2..], r).map_or(f64::NAN, |n| n as f64))
    };
    if let Some(n) = radix("0x", 16)
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0b", 2))
    {
        return n;
    }
    match t.trim_start_matches(['+', '-']) {
        "Infinity" => {
            return if t.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            }
        }
        // Rust also reads "inf"/"nan", JS doesn't.
        x if x
            .bytes()
            .any(|b| b.is_ascii_alphabetic() && b != b'e' && b != b'E') =>
        {
            return f64::NAN
        }
        _ => {}
    }
    t.parse().unwrap_or(f64::NAN)
}

/// `parseAutoLock`: the saved minutes (0–240), or the default.
pub fn parse_auto_lock(raw: Option<&str>) -> f64 {
    let n = raw.map_or(AUTO_LOCK_DEFAULT, js_number);
    if n.is_finite() && (0.0..=240.0).contains(&n) {
        n
    } else {
        AUTO_LOCK_DEFAULT
    }
}

/// `parseStringList`: the strings in a saved JSON array; anything else is `[]`.
pub fn parse_string_list(raw: Option<&str>) -> Vec<String> {
    match serde_json::from_str::<serde_json::Value>(raw.unwrap_or("[]")) {
        Ok(serde_json::Value::Array(items)) => items
            .into_iter()
            .filter_map(|v| match v {
                serde_json::Value::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // apps/desktop/src/lib/autoLock.test.ts
    const T0: f64 = 1_000_000_000.0;

    #[test]
    fn locks_after_the_computer_slept() {
        assert_eq!(should_lock(T0 + 5_000.0, T0, T0, 0.0), None);
        assert_eq!(
            should_lock(T0 + 3.0 * 60_000.0, T0, T0 + 1_000.0, 0.0),
            Some(LockReason::Sleep)
        );
    }

    #[test]
    fn locks_after_the_idle_minutes_never_when_set_to_0() {
        let m = 60_000.0;
        assert_eq!(
            should_lock(T0 + 5.0 * m, T0 + 5.0 * m - 5_000.0, T0, 5.0),
            Some(LockReason::Idle)
        );
        assert_eq!(
            should_lock(T0 + 4.0 * m, T0 + 4.0 * m - 5_000.0, T0, 5.0),
            None
        );
        assert_eq!(
            should_lock(T0 + 99.0 * m, T0 + 99.0 * m - 5_000.0, T0, 0.0),
            None
        );
    }

    #[test]
    fn reads_the_saved_setting_safely() {
        assert_eq!(parse_auto_lock(None), 5.0);
        assert_eq!(parse_auto_lock(Some("15")), 15.0);
        assert_eq!(parse_auto_lock(Some("0")), 0.0);
        assert_eq!(parse_auto_lock(Some("banana")), 5.0);
        assert_eq!(parse_auto_lock(Some("inf")), 5.0);
        assert_eq!(parse_auto_lock(Some("241")), 5.0);
        assert_eq!(parse_auto_lock(Some("0x10")), 16.0);
    }

    #[test]
    fn reads_folded_sidebar_groups_safely() {
        assert_eq!(parse_string_list(None), Vec::<String>::new());
        assert_eq!(
            parse_string_list(Some(r#"["plan","grow"]"#)),
            ["plan", "grow"]
        );
        assert_eq!(parse_string_list(Some(r#"["plan",3,null]"#)), ["plan"]);
        assert_eq!(parse_string_list(Some("not json")), Vec::<String>::new());
    }
}
