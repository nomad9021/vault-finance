//! Available vs actual balances: the pure half of
//! apps/desktop/src/lib/balanceView.ts (the per-device toggle that picks
//! between them lives in vault-ui/src/balance_view.rs).
//!
//! Money set aside for a bill, a gift fund or a savings bucket is still in
//! the bank, but it isn't free to spend, so accounts show what's left after
//! those set-asides unless the user flips to the bank's number.

use crate::accounts::Account;

/// `availableCents`: what's free to use, the balance minus money set aside
/// in it.
pub fn available_cents(account: &Account) -> i64 {
    account.balance_cents - account.set_aside_cents.unwrap_or(0)
}

/// `shownBalance`: the balance to show, given the current view.
pub fn shown_balance(account: &Account, show_actual: bool) -> i64 {
    if show_actual {
        account.balance_cents
    } else {
        available_cents(account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{tests::SAMPLE, AccountListResponse};

    fn sample() -> Vec<Account> {
        serde_json::from_str::<AccountListResponse>(SAMPLE)
            .unwrap()
            .accounts
    }

    #[test]
    fn available_subtracts_set_asides() {
        let a = sample();
        assert_eq!(available_cents(&a[0]), 482150 - 60000);
        // No setAsideCents (older server) counts as nothing set aside.
        assert_eq!(available_cents(&a[1]), 1250000);
        assert_eq!(available_cents(&a[2]), -184033);
    }

    #[test]
    fn shown_follows_the_view() {
        let a = sample();
        assert_eq!(shown_balance(&a[0], true), 482150);
        assert_eq!(shown_balance(&a[0], false), 422150);
        assert_eq!(shown_balance(&a[1], false), 1250000);
        assert_eq!(shown_balance(&a[2], true), -184033);
    }

    #[test]
    fn set_aside_can_exceed_the_balance() {
        let mut a = sample()[0].clone();
        a.balance_cents = 100;
        a.set_aside_cents = Some(250);
        assert_eq!(shown_balance(&a, false), -150);
        assert_eq!(shown_balance(&a, true), 100);
    }
}
