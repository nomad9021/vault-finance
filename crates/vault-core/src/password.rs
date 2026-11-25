//! Mirrors packages/shared/src/schemas/password.ts: the rules for every new
//! password (setup, change, member, invite).

use std::collections::HashSet;

use crate::serde_util::js_len;

pub const MIN_PASSWORD_LENGTH: usize = 12;

const COMMON: &[&str] = &[
    "password1234",
    "password12345",
    "password123456",
    "passwordpassword",
    "123456789012",
    "1234567890123",
    "12345678901234",
    "qwertyuiop12",
    "qwertyuiop123",
    "qwertyuiopasdf",
    "iloveyou1234",
    "abcdefghijkl",
    "abcdefgh1234",
    "abc123abc123",
    "letmein12345",
    "welcome12345",
    "changeme1234",
    "administrator",
    "trustno1trustno1",
    "monkey123456",
    "football1234",
    "baseball1234",
    "superman1234",
    "princess1234",
    "sunshine1234",
    "password!234",
    "p@ssword1234",
    "p@ssw0rd1234",
    "passw0rd1234",
    "vaultfinance",
    "vaultfinance1",
    "vaultfinance123",
    "correcthorsebatterystaple",
];

/// Why `pw` is too weak, or `None` when it's fine.
pub fn password_problem(pw: &str) -> Option<String> {
    if js_len(pw) < MIN_PASSWORD_LENGTH {
        return Some(format!("Use at least {MIN_PASSWORD_LENGTH} characters."));
    }
    // JS `toLowerCase().replace(/[\s_-]/g, "")`.
    let folded: String = pw
        .to_lowercase()
        .chars()
        .filter(|c| !(c.is_whitespace() || *c == '\u{feff}' || *c == '_' || *c == '-'))
        .collect();
    if COMMON.contains(&folded.as_str()) {
        return Some("That password is too common. A few random words work well.".into());
    }
    // `new Set(pw)` iterates code points.
    if pw.chars().collect::<HashSet<_>>().len() < 5 {
        return Some("Use more different characters.".into());
    }
    if pw.chars().all(|c| c.is_ascii_digit()) {
        return Some("Don't use only numbers.".into());
    }
    None
}

/// The whole `NewPassword` schema: at most 200 characters, then the rules.
pub fn new_password_problem(pw: &str) -> Option<String> {
    if js_len(pw) > 200 {
        return Some("String must contain at most 200 character(s)".into());
    }
    password_problem(pw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explains_weak_passwords() {
        assert_eq!(
            password_problem("short").unwrap(),
            "Use at least 12 characters."
        );
        assert_eq!(
            password_problem("Password 1234").unwrap(),
            "That password is too common. A few random words work well."
        );
        assert_eq!(
            password_problem("vault_finance").unwrap(),
            "That password is too common. A few random words work well."
        );
        assert_eq!(
            password_problem("abababababab").unwrap(),
            "Use more different characters."
        );
        assert_eq!(
            password_problem("918273645091").unwrap(),
            "Don't use only numbers."
        );
        assert_eq!(password_problem("maple otter canyon"), None);
        assert!(new_password_problem(&"x1y2z3w4v5".repeat(21)).is_some());
    }
}
