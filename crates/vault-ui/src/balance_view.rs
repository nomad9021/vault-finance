//! The per-device "show actual balances" toggle from
//! apps/desktop/src/lib/balanceView.ts (the maths is in
//! `vault_core::balance_view`). Same storage key and window event as the
//! React hook, so a Rust page and a React widget stay in step.

use leptos::prelude::*;

use crate::storage;
use crate::ui::on_window;

const KEY: &str = "vault.balances.show-actual";
const EVENT: &str = "vault:balances-view";

fn load() -> bool {
    storage::get(KEY).as_deref() == Some("on")
}

/// `useShowActualBalances()`: the current view, and a setter that stores it
/// and tells every other listener.
pub fn use_show_actual_balances() -> (ReadSignal<bool>, Callback<bool>) {
    let (on, set_on) = signal(load());
    on_window(EVENT, false, move |_| set_on.set(load()));
    let set = Callback::new(move |next: bool| {
        storage::set(KEY, if next { "on" } else { "off" });
        set_on.set(next);
        if let Some(w) = web_sys::window() {
            if let Ok(e) = web_sys::Event::new(EVENT) {
                let _ = w.dispatch_event(&e);
            }
        }
    });
    (on, set)
}
