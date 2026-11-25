//! The assistant on every page: port of
//! apps/desktop/src/screens/shell/AssistantBubble.tsx. A bubble in the
//! corner (or Ctrl/Cmd+J) opens the same conversation as the Assistant page.
//! On a phone the bubble simply opens the Assistant page. The shell mounts it
//! (`RustPage page="assistant-bubble"`), outside the page body.

use std::sync::Arc;

use leptos::prelude::*;
use vault_core::ai::AiStatus;
use vault_core::nav::NavFilter;
use wasm_bindgen::JsCast;

use super::assistant::{use_data, LevelSegmented};
use super::chat_view::{ChatComposer, ChatMessages};
use crate::host::use_host;
use crate::ui::{on_window, use_narrow, Button, Icon};

#[component]
pub fn AssistantBubble() -> impl IntoView {
    let host = use_host();
    let phone = use_narrow();
    let open = RwSignal::new(false);
    let app = host.app_state();
    let chat = host.chat();
    let busy = Memo::new(move |_| chat.with(|c| c.busy));

    let (status, load) =
        use_data::<AiStatus>(&host, move || open.get_untracked().then_some("aiStatus"));
    {
        let version = host.data_version;
        let load = Arc::clone(&load);
        Effect::new(move |_| {
            open.track();
            version.track();
            load();
        });
    }
    let offline = Memo::new(move |_| status.with(|s| s.as_ref().is_some_and(AiStatus::offline)));

    let open_page = {
        let host = host.clone();
        move || host.navigate("assistant", &NavFilter::default())
    };

    {
        let open_page = open_page.clone();
        on_window("keydown", false, move |e| {
            let Some(e) = e.dyn_ref::<web_sys::KeyboardEvent>() else {
                return;
            };
            if (e.ctrl_key() || e.meta_key())
                && !e.shift_key()
                && !e.alt_key()
                && e.key().to_lowercase() == "j"
            {
                e.prevent_default();
                if phone.get_untracked() {
                    open_page();
                } else {
                    open.update(|o| *o = !*o);
                }
            }
            if e.key() == "Escape" {
                open.set(false);
            }
        });
    }

    let new_chat = {
        let host = host.clone();
        move || host.chat_fire("newChat", Vec::new())
    };

    move || {
        if !open.get() {
            let open_page = open_page.clone();
            let p = phone.get();
            return view! {
                <button
                    on:click=move |_| if p { open_page() } else { open.set(true) }
                    title="Ask the assistant (Ctrl+J)"
                    aria-label="Open the assistant"
                    class=if p { "ai-bubble glass" } else { "glass" }
                    style=(!p).then_some("position: fixed; right: 20px; bottom: 20px; z-index: var(--z-rail); width: 52px; height: 52px; border-radius: 50%; cursor: pointer; color: var(--content-primary); display: grid; place-items: center; font-size: 22px")>
                    // Blinks only while the assistant is actually working.
                    <span style=move || if busy.get() { "animation: blink 1s infinite; display: grid" } else { "display: grid" }>
                        <Icon name="sparkle" size=22 />
                    </span>
                </button>
            }
            .into_any();
        }
        let open_page = open_page.clone();
        let new_chat = new_chat.clone();
        view! {
            <div role="dialog" aria-label="Assistant"
                style="position: fixed; right: 20px; bottom: 20px; z-index: var(--z-rail); width: min(420px, calc(100vw - 40px)); height: min(600px, calc(100vh - 40px)); display: flex; flex-direction: column; background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); overflow: hidden; animation: fadeUp .2s both">
                <div style="display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--color-divider)">
                    <strong style="flex: 1; font-size: var(--text-sm)">"✦ Assistant"</strong>
                    <LevelSegmented app />
                    <Button variant="ghost" size="sm" icon="plus" aria_label="New chat" title="New chat"
                        on_click=new_chat disabled=busy />
                    <Button variant="ghost" size="sm" icon="expand" aria_label="Open full page" title="Open full page"
                        on_click=move || {
                            open.set(false);
                            open_page();
                        } />
                    <Button variant="ghost" size="sm" aria_label="Close" title="Close (Esc)" on_click=move || open.set(false)>
                        <Icon name="close" size=16 />
                    </Button>
                </div>
                <ChatMessages chat compact=true empty=move || view! {
                    <div class="card-meta" style="line-height: 1.6">
                        "Ask about anything on this page — or tell it what to change. Ctrl+J opens and closes this."
                        {move || offline.get().then(|| view! {
                            <div style="color: var(--color-negative); margin-top: 8px">"The AI isn't reachable right now; check Settings → AI."</div>
                        })}
                    </div>
                } />
                <ChatComposer chat compact=true autofocus=true disabled=offline />
            </div>
        }
        .into_any()
    }
}
