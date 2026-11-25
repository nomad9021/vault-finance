//! `HouseholdSection`: the household's own name. Everyone on this server
//! already shares one household; this names it. Members see it, only the
//! owner can change it.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::Deserialize;

use crate::host::use_host;
use crate::ui::{Card, Field, Spinner};

#[derive(Deserialize)]
struct Household {
    name: String,
}

#[component]
pub fn HouseholdSection() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let household_name = Memo::new(move |_| app.with(|a| a.household_name.clone()));
    let owner = Memo::new(move |_| app.with(|a| a.is_owner()));
    let draft = RwSignal::new(household_name.get_untracked().unwrap_or_default());
    Effect::new(move || draft.set(household_name.get().unwrap_or_default()));
    let busy = RwSignal::new(false);
    let saved = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let dirty = Memo::new(move |_| {
        let d = draft.get();
        let t = d.trim();
        t != household_name.get().unwrap_or_default() && !t.is_empty()
    });

    let save = move || {
        let host = host.clone();
        busy.set(true);
        error.set(None);
        saved.set(false);
        let name = draft.get_untracked().trim().to_string();
        spawn_local(async move {
            match host
                .try_call::<Household>("renameHousehold", &[name.into()])
                .await
            {
                Ok(h) => {
                    host.set_household_name(&h.name);
                    saved.try_set(true);
                }
                Err(e) => {
                    error.try_set(Some(e.message_or("Couldn't save the name.")));
                }
            }
            busy.try_set(false);
        });
    };

    let save = StoredValue::new_local(save);
    view! {
        <Card kicker="Household" title=Signal::derive(move || household_name.get().unwrap_or_else(|| "Your household".into()))>
            <p class="card-body">
                "Everyone who signs in to this server is part of the same household and shares its accounts. Its name appears on the sign-in screen and in the sidebar"
                {move || if owner.get() { "" } else { " — the household owner can change it" }}
                "."
            </p>
            {move || owner.get().then(|| view! {
                <form style="display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; max-width: 460px"
                    on:submit=move |e| {
                        e.prevent_default();
                        if dirty.get_untracked() && !busy.get_untracked() {
                            save.with_value(|f| f());
                        }
                    }>
                    <div style="flex: 1; min-width: 220px">
                        <Field label="Household name" value=draft max_length=60 placeholder="e.g. The Carters"
                            on_input=Callback::new(move |_| saved.set(false)) />
                    </div>
                    <button type="submit" class="btn btn-primary" disabled=move || !dirty.get() || busy.get()>
                        {move || if busy.get() {
                            view! { <Spinner label="Saving" /> }.into_any()
                        } else {
                            "Save".into_any()
                        }}
                    </button>
                </form>
            })}
            {move || (saved.get() && !dirty.get()).then(|| view! {
                <p class="card-meta" style="color: var(--color-positive)">"Saved."</p>
            })}
            {move || error.get().map(|e| view! {
                <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative); margin-top: 8px">{e}</div>
            })}
        </Card>
    }
}
