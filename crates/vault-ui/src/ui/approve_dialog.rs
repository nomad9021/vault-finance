//! `ApproveDialog` and `describeRequest` from
//! apps/desktop/src/screens/shell/DeviceApprovalPrompt.tsx: type the code the
//! new device shows (number matching), then Allow or Deny.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::auth::PendingApproval;
use wasm_bindgen::JsValue;

use super::{Button, Dialog, Field, Spinner};
use crate::fmt;
use crate::host::use_host;

/// `describeRequest(p)`.
pub fn describe_request(p: &PendingApproval) -> String {
    vault_core::settings::describe_request(p, &fmt::hour_minute(&p.requested_at))
}

/// What closed the dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApproveOutcome {
    Approved,
    Denied,
    Dismissed,
}

/// Drawn while `request` is set.
#[component]
pub fn ApproveDialog(
    #[prop(into)] request: Signal<Option<PendingApproval>>,
    #[prop(into)] on_done: Callback<ApproveOutcome>,
) -> impl IntoView {
    let host = use_host();
    let code = RwSignal::new(String::new());
    // "approve" | "deny" while a request is out.
    let busy = RwSignal::new(None::<&'static str>);
    let error = RwSignal::new(None::<String>);

    Effect::new(move || {
        request.with(|r| r.as_ref().map(|r| r.id.clone()));
        code.set(String::new());
        error.set(None);
    });

    let digits = move || vault_core::settings::digits_only(&code.get());
    let approve = {
        let host = host.clone();
        Callback::new(move |()| {
            let Some(req) = request.get_untracked() else {
                return;
            };
            let d = vault_core::settings::digits_only(&code.get_untracked());
            if d.len() != 6 || busy.get_untracked().is_some() {
                return;
            }
            busy.set(Some("approve"));
            error.set(None);
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<IgnoredAny>(
                        "approveDevice",
                        &[JsValue::from_str(&req.id), JsValue::from_str(&d)],
                    )
                    .await
                {
                    Ok(_) => on_done.run(ApproveOutcome::Approved),
                    Err(e) => {
                        let api = e.is_api_request();
                        let _ = error.try_set(Some(if api {
                            e.message.clone()
                        } else {
                            "Couldn't reach the server.".into()
                        }));
                        if api && e.status == Some(404) {
                            on_done.run(ApproveOutcome::Dismissed);
                        }
                    }
                }
                let _ = busy.try_set(None);
            });
        })
    };
    let deny = {
        let host = host.clone();
        move || {
            let Some(req) = request.get_untracked() else {
                return;
            };
            busy.set(Some("deny"));
            let host = host.clone();
            spawn_local(async move {
                let _ = host
                    .call::<IgnoredAny>("denyDevice", &[JsValue::from_str(&req.id)])
                    .await;
                let _ = busy.try_set(None);
                on_done.run(ApproveOutcome::Denied);
            });
        }
    };

    move || {
        let req = request.get()?;
        let text = describe_request(&req);
        let deny = deny.clone();
        Some(view! {
            <Dialog title="New sign-in waiting for approval" on_close=move |()| on_done.run(ApproveOutcome::Dismissed)
                actions=ToChildren::to_children(move || {
                    let deny = deny.clone();
                    view! {
                        <Button variant="ghost" on_click=move || on_done.run(ApproveOutcome::Dismissed)
                            disabled=Signal::derive(move || busy.get().is_some())>"Later"</Button>
                        <Button variant="secondary" on_click=deny.clone() disabled=Signal::derive(move || busy.get().is_some())>
                            {move || if busy.get() == Some("deny") { view! { <Spinner label="Denying" /> }.into_any() } else { "Deny".into_any() }}
                        </Button>
                        <Button variant="primary" on_click=move || approve.run(())
                            disabled=Signal::derive(move || busy.get().is_some() || digits().len() != 6)>
                            {move || if busy.get() == Some("approve") { view! { <Spinner label="Approving" /> }.into_any() } else { "Allow".into_any() }}
                        </Button>
                    }.into_any()
                })>
                <p style="margin: 0px 0px 10px; line-height: 1.6">{text.clone()}</p>
                <p style="margin: 0px 0px 12px; line-height: 1.6; font-size: var(--text-sm); color: var(--content-secondary)">
                    "Only allow it if you know who this is. Type the 6-digit code shown on that device — if there's no code in front of you, it isn't you: choose "<strong>"Deny"</strong>"."
                </p>
                <form on:submit=move |e| { e.prevent_default(); approve.run(()); }>
                    <Field label="Code shown on the new device" value=code input_mode="numeric"
                        autocomplete="one-time-code" placeholder="123 456" autofocus=true
                        error=Signal::derive(move || error.get()) />
                </form>
            </Dialog>
        })
    }
}
