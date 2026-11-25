//! `AdminLaunchRow`: discreet, owner-only entry point to the hosting admin
//! console. Opens a separate OS window (see screens/admin) — nothing
//! admin-related renders in the normal shell. Hidden unless the platform
//! exposes an admin console at all.

use leptos::prelude::*;

use crate::host::use_host;

#[component]
pub fn AdminLaunchRow() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let shown = Memo::new(move |_| app.with(|a| a.is_owner() && a.admin_console));
    move || {
        shown.get().then(|| {
            let host = host.clone();
            view! {
                <div style="margin-top: 24px; text-align: center">
                    <button on:click=move |_| host.open_admin_console()
                        style="background: none; border: 0px; color: var(--content-tertiary); font: inherit; font-size: var(--text-xs); cursor: pointer; text-decoration: underline">
                        "Server administration…"
                    </button>
                </div>
            }
        })
    }
}
