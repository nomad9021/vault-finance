//! Assistant: port of apps/desktop/src/screens/shell/AssistantPage.tsx and
//! the AiHostBar.tsx it shows above the chat. The chat itself is
//! `chat_view`; the conversation stays in JS (state/chat.ts).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use leptos::prelude::*;
use serde::de::DeserializeOwned;
use vault_core::ai::{AiHostPower, AiHostStatus, AiLevel, AiStatus, ConversationListResponse};
use vault_core::nav::NavFilter;
use wasm_bindgen::JsValue;

use super::chat_view::{ChatComposer, ChatMessages};
use crate::host::{use_host, AppState, ChatState, HostCtx};
use crate::ui::{use_narrow, Banner, Button, Dialog, Segmented, Spinner};

/// The design's "Try asking" chip rail — each maps to the AI feature list.
const CHIPS: [&str; 10] = [
    "Organize my finances and set up my Sankey",
    "Explain my spending habits this month",
    "How am I doing against my budgets?",
    "Summarize my cash flow",
    "Where could I save money?",
    "What were my biggest expenses recently?",
    "Compare my spending to last month",
    "How is my net worth looking?",
    "Suggest a cleaner category tree for me",
    "Set up budgets based on last month",
];

const LEVELS: &[(&str, &str)] = &[("low", "Low"), ("medium", "Medium"), ("high", "High")];
const CHANGES: &[(&str, &str)] = &[("ask", "Ask me first"), ("auto", "Auto")];

fn parse_level(s: &str) -> AiLevel {
    AiLevel::ALL
        .into_iter()
        .find(|l| l.as_str() == s)
        .unwrap_or_default()
}

/// lib/useData.ts: fetch into a signal, keep the last data while reloading,
/// refetch quietly when the assistant changes data. Errors leave it as is.
pub(crate) fn use_data<T>(
    host: &HostCtx,
    fetch: impl Fn() -> Option<&'static str> + Send + Sync + 'static,
) -> (RwSignal<Option<T>>, Arc<dyn Fn() + Send + Sync>)
where
    T: DeserializeOwned + Send + Sync + 'static,
{
    let data = RwSignal::new(None::<T>);
    let generation = Arc::new(AtomicU32::new(0));
    let load: Arc<dyn Fn() + Send + Sync> = {
        let host = host.clone();
        let generation = Arc::clone(&generation);
        Arc::new(move || {
            let gen = generation.fetch_add(1, Ordering::Relaxed) + 1;
            let Some(method) = fetch() else {
                data.set(None);
                return;
            };
            let host = host.clone();
            let generation = Arc::clone(&generation);
            wasm_bindgen_futures::spawn_local(async move {
                let result = host.call::<T>(method, &[]).await;
                if generation.load(Ordering::Relaxed) == gen {
                    if let Ok(r) = result {
                        data.set(Some(r));
                    }
                }
            });
        })
    };
    on_cleanup(move || {
        generation.fetch_add(1, Ordering::Relaxed);
    });
    (data, load)
}

/// Load now and on every data change from the assistant.
fn load_with_data_changes(host: &HostCtx, load: Arc<dyn Fn() + Send + Sync>) {
    let version = host.data_version;
    Effect::new(move |_| {
        version.track();
        load();
    });
}

#[component]
pub fn AssistantPage() -> impl IntoView {
    let host = use_host();
    let phone = use_narrow();
    let side_open = RwSignal::new(false);
    let app = host.app_state();
    let chat = host.chat();

    let (status, reload_status) = use_data::<AiStatus>(&host, || Some("aiStatus"));
    load_with_data_changes(&host, Arc::clone(&reload_status));

    // The AI server's power state. When it comes on, re-check AI status so
    // the input unlocks without leaving the page.
    let host_power = RwSignal::new(None::<AiHostPower>);
    let on_host_change = Callback::new(move |h: AiHostStatus| {
        let power = h.applies.then_some(h.power);
        let prev = host_power.get_untracked();
        if power == Some(AiHostPower::On) && prev.is_some() && prev != Some(AiHostPower::On) {
            reload_status();
        }
        host_power.set(power);
    });

    let (convos, reload_convos) =
        use_data::<ConversationListResponse>(&host, || Some("conversations"));
    load_with_data_changes(&host, Arc::clone(&reload_convos));
    // Saved chats reload whenever the shared conversation changes them.
    let list_version = Memo::new(move |_| chat.with(|c| c.list_version));
    Effect::new(move |_| {
        if list_version.get() != 0 {
            reload_convos();
        }
    });

    let deleting = RwSignal::new(None::<(String, String)>);
    let confirm_delete = {
        let host = host.clone();
        move || {
            let Some((id, _)) = deleting.get_untracked() else {
                return;
            };
            let host = host.clone();
            wasm_bindgen_futures::spawn_local(async move {
                match host
                    .try_call::<serde::de::IgnoredAny>("deleteConversation", &[id.clone().into()])
                    .await
                {
                    Ok(_) => host.chat_do("forget", &[id.into()]).await,
                    Err(e) => {
                        let msg = if e.is_api_request() {
                            e.message
                        } else {
                            "Couldn't delete that chat.".into()
                        };
                        host.chat_do("setError", &[msg.into()]).await;
                    }
                }
                deleting.set(None);
            });
        }
    };

    let ai_offline = Memo::new(move |_| status.with(|s| s.as_ref().is_some_and(AiStatus::offline)));

    let banner = {
        let host = host.clone();
        move || {
            let s = status.get()?;
            let power = host_power.get();
            let asleep = s.enabled && s.configured && power.is_some_and(|p| p != AiHostPower::On);
            // The bar above already says the AI server is asleep or starting.
            if !s.offline() || asleep {
                return None;
            }
            let text = if !s.enabled {
                "The AI assistant is turned off in Settings.".to_string()
            } else if !s.configured {
                "The AI assistant isn't fully configured — finish setup in Settings.".to_string()
            } else {
                format!(
                    "{} isn't reachable right now. Everything else keeps working.",
                    s.provider.label()
                )
            };
            let host = host.clone();
            Some(view! {
                <Banner tone="warning" action=Box::new(move || view! {
                    <Button variant="ghost" on_click={
                        let host = host.clone();
                        move || host.navigate("settings", &NavFilter { tab: Some("ai".into()), ..Default::default() })
                    }>"Open AI settings"</Button>
                }.into_any())>
                    {text}
                </Banner>
            })
        }
    };

    let side = move || {
        view! { <SideContent app chat convos ai_offline deleting /> }
    };

    view! {
        <div class=move || phone.get().then_some("assistant-phone")
            style=move || (!phone.get()).then_some("display: flex; height: 100%; min-height: 0; animation: fadeUp .3s both; margin: -24px")>
            <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0">
                // Phone: the side column (level, approvals, saved chats) lives in a sheet.
                {move || phone.get().then(|| view! {
                    <div class="row-between" style="margin-bottom: var(--space-2)">
                        <span></span>
                        <Button variant="secondary" size="sm" icon="more" on_click=move || side_open.set(true)>
                            "Chats and settings"
                        </Button>
                    </div>
                })}
                <AiHostBar on_change=on_host_change />
                {banner}
                <ChatMessages chat empty=move || view! {
                    <div class="text-muted" style="font-size: var(--text-base); max-width: 480px; line-height: 1.7">
                        "Ask anything about your money — spending, budgets, cash flow, taxes, forecasts. It can also reorganise your categories, set budgets, bills and goals, and change settings — it asks first unless you switch on Auto."
                        {move || if phone.get() { "" } else { " Press Ctrl+J on any page for the chat bubble." }}
                    </div>
                } />
                <ChatComposer chat disabled=ai_offline />
            </div>

            {move || if phone.get() {
                side_open.get().then(|| view! {
                    <Dialog title="Chats and settings" on_close=move || side_open.set(false)>
                        <div>{side()}</div>
                    </Dialog>
                }).into_any()
            } else {
                view! {
                    <div style="width: 280px; flex: none; border-left: 1px solid var(--color-divider); padding: 18px; overflow: auto">
                        {side()}
                    </div>
                }.into_any()
            }}

            {move || deleting.get().map(|(_, title)| {
                let confirm = confirm_delete.clone();
                view! {
                    <Dialog title="Delete this chat?" on_close=move || deleting.set(None)
                        actions=std::sync::Arc::new(move || {
                            let confirm = confirm.clone();
                            view! {
                                <Button variant="ghost" on_click=move || deleting.set(None)>"Cancel"</Button>
                                <Button variant="danger" on_click=confirm>"Delete chat"</Button>
                            }.into_any()
                        })>
                        {format!("\"{title}\" will be removed for good. What the assistant has remembered about you is kept — memory is never deleted.")}
                    </Dialog>
                }
            })}
        </div>
    }
}

/// The side column: AI level, approvals, saved chats and "Try asking".
#[component]
fn SideContent(
    app: ReadSignal<AppState>,
    chat: ReadSignal<ChatState>,
    convos: RwSignal<Option<ConversationListResponse>>,
    ai_offline: Memo<bool>,
    deleting: RwSignal<Option<(String, String)>>,
) -> impl IntoView {
    let host = use_host();
    let busy = Memo::new(move |_| chat.with(|c| c.busy));
    let active = Memo::new(move |_| chat.with(|c| c.conversation_id.clone()));
    let auto_apply = Memo::new(move |_| app.with(|a| a.ai_auto_apply));

    let changes = RwSignal::new(if auto_apply.get_untracked() {
        "auto"
    } else {
        "ask"
    });
    Effect::new(move |_| changes.set(if auto_apply.get() { "auto" } else { "ask" }));
    {
        let host = host.clone();
        Effect::new(move |_| {
            let on = changes.get() == "auto";
            if on != auto_apply.get_untracked() {
                host.set_ai_auto_apply(on);
            }
        });
    }

    let new_chat = {
        let host = host.clone();
        move || host.chat_fire("newChat", Vec::new())
    };

    let list = {
        let host = host.clone();
        move || {
            let list = convos.with(|c| {
                c.as_ref()
                    .map(|c| c.conversations.clone())
                    .unwrap_or_default()
            });
            if list.is_empty() {
                return view! { <div class="card-meta">"Saved chats appear here."</div> }
                    .into_any();
            }
            list.into_iter()
                .map(|c| {
                    let title = c.title.clone().unwrap_or_else(|| "Untitled chat".into());
                    let id = c.id.clone();
                    let is_active = {
                        let id = id.clone();
                        move || active.with(|a| a.as_deref() == Some(id.as_str()))
                    };
                    let open = {
                        let host = host.clone();
                        let id = id.clone();
                        move |_| host.chat_fire("open", vec![JsValue::from(id.clone())])
                    };
                    let del_title = title.clone();
                    view! {
                        <div style=move || format!(
                            "display: flex; align-items: center; gap: 4px; border-radius: var(--radius-md); background: {}",
                            if is_active() { "color-mix(in srgb, var(--color-accent) 12%, transparent)" } else { "none" }
                        )>
                            <button on:click=open disabled=move || busy.get() title=title.clone()
                                style="flex: 1; min-width: 0; text-align: left; border: 0px; background: none; color: inherit; font: inherit; font-size: var(--text-sm); padding: 6px 8px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                                {title.clone()}
                            </button>
                            <Button variant="ghost" size="sm" icon="trash"
                                aria_label=format!("Delete chat {}", c.title.clone().unwrap_or_default())
                                on_click=move || deleting.set(Some((id.clone(), del_title.clone()))) />
                        </div>
                    }
                })
                .collect_view()
                .into_any()
        }
    };

    view! {
        <SideHeading>"AI level"</SideHeading>
        <LevelSegmented app />
        <p class="card-meta" style="margin: 6px 0px 18px">{move || app.with(|a| a.ai_level.hint())}</p>

        <SideHeading>"Changes"</SideHeading>
        <Segmented aria_label="When the assistant wants to change something" options=CHANGES value=changes />
        <p class="card-meta" style="margin: 6px 0px 18px">
            {move || if auto_apply.get() {
                "Changes it suggests are made straight away. Each still shows in the chat."
            } else {
                "You approve each change before it's made."
            }}
        </p>

        <div style="display: flex; align-items: center; justify-content: space-between">
            <SideHeading>"Chats"</SideHeading>
            <Button variant="ghost" size="sm" icon="plus" on_click=new_chat disabled=busy>"New"</Button>
        </div>
        <div style="display: flex; flex-direction: column; gap: 2px; margin-bottom: 18px; max-height: 260px; overflow: auto">
            {list}
        </div>

        <SideHeading>"Try asking"</SideHeading>
        <div style="display: flex; flex-direction: column; gap: 7px">
            {CHIPS.into_iter().map(|chip| {
                let host = host.clone();
                view! {
                    <Button variant="secondary"
                        style="justify-content: flex-start; text-align: left; font-weight: 500; font-size: var(--text-sm); border-radius: var(--radius-md)"
                        disabled=Signal::derive(move || busy.get() || ai_offline.get())
                        on_click=move || host.chat_fire("send", vec![JsValue::from(chip)])>
                        {chip}
                    </Button>
                }
            }).collect_view()}
        </div>
    }
}

/// The AI level control, kept in step with the app store (`aiLevel`).
#[component]
pub(crate) fn LevelSegmented(app: ReadSignal<AppState>) -> impl IntoView {
    let host = use_host();
    let stored = Memo::new(move |_| app.with(|a| a.ai_level));
    let value = RwSignal::new(stored.get_untracked().as_str());
    Effect::new(move |_| value.set(stored.get().as_str()));
    Effect::new(move |_| {
        let level = parse_level(value.get());
        if level != stored.get_untracked() {
            host.set_ai_level(level);
        }
    });
    view! { <Segmented aria_label="AI level" options=LEVELS value /> }
}

#[component]
fn SideHeading(children: Children) -> impl IntoView {
    view! {
        <div style="font-size: var(--text-2xs); letter-spacing: .05em; text-transform: uppercase; color: var(--content-tertiary); font-weight: 600; margin-bottom: 8px">
            {children()}
        </div>
    }
}

/// Poll fast while the AI server boots, slowly otherwise.
const POLL_STARTING_MS: i32 = 3_000;
const POLL_IDLE_MS: i32 = 20_000;

async fn sleep(ms: i32) {
    let p = js_sys::Promise::new(&mut |resolve, _| {
        let _ = window().set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms);
    });
    let _ = wasm_bindgen_futures::JsFuture::from(p).await;
}

/// One line above the chat saying whether the separate AI server is on,
/// asleep or starting, with a Start button when Vault can switch it on.
/// Hidden when AI runs in the cloud or is turned off.
#[component]
fn AiHostBar(on_change: Callback<AiHostStatus>) -> impl IntoView {
    let host = use_host();
    let status = RwSignal::new(None::<AiHostStatus>);
    let starting = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let generation = Arc::new(AtomicU32::new(0));

    {
        let host = host.clone();
        let generation = Arc::clone(&generation);
        // `starting` restarts the loop right after Start so it polls fast at once.
        Effect::new(move |_| {
            starting.track();
            let gen = generation.fetch_add(1, Ordering::Relaxed) + 1;
            let host = host.clone();
            let generation = Arc::clone(&generation);
            wasm_bindgen_futures::spawn_local(async move {
                loop {
                    // A failed poll keeps the last status; the next one retries.
                    let next = host.call::<AiHostStatus>("aiHost", &[]).await.ok();
                    if generation.load(Ordering::Relaxed) != gen {
                        return;
                    }
                    if let Some(next) = &next {
                        status.set(Some(next.clone()));
                        on_change.run(next.clone());
                    }
                    let fast = next.is_some_and(|n| n.power == AiHostPower::Starting);
                    sleep(if fast { POLL_STARTING_MS } else { POLL_IDLE_MS }).await;
                    if generation.load(Ordering::Relaxed) != gen {
                        return;
                    }
                }
            });
        });
    }
    on_cleanup(move || {
        generation.fetch_add(1, Ordering::Relaxed);
    });

    let start = move || {
        let host = host.clone();
        error.set(None);
        starting.set(true);
        wasm_bindgen_futures::spawn_local(async move {
            match host.try_call::<AiHostStatus>("startAiHost", &[]).await {
                Ok(next) => {
                    status.set(Some(next.clone()));
                    on_change.run(next);
                }
                Err(e) => error.set(Some(if e.is_api_request() {
                    e.message
                } else {
                    "Couldn't reach the Vault server to start the AI server.".into()
                })),
            }
            starting.set(false);
        });
    };

    move || {
        let s = status.get().filter(|s| s.applies)?;
        let dot = match s.power {
            AiHostPower::On => "var(--color-positive)",
            AiHostPower::Starting => "var(--color-warning)",
            AiHostPower::Off => "var(--content-tertiary)",
            AiHostPower::Unknown => "var(--color-negative)",
        };
        let text = s.bar_text();
        let can_start = s.can_start && matches!(s.power, AiHostPower::Off | AiHostPower::Unknown);
        let start = start.clone();
        Some(view! {
            <div role="status" style="flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 24px; border-bottom: 1px solid var(--color-divider); font-size: var(--text-sm); min-height: 44px">
                {if s.power == AiHostPower::Starting {
                    view! { <Spinner label="Starting" /> }.into_any()
                } else {
                    view! {
                        <span aria-hidden="true" style=format!("width: 8px; height: 8px; border-radius: 50%; background: {dot}; flex: none")></span>
                    }.into_any()
                }}
                <span style="flex: 1; min-width: 0" class=(s.power == AiHostPower::Unknown).then_some("neg")>
                    {move || error.get().unwrap_or_else(|| text.clone())}
                </span>
                {can_start.then(|| view! {
                    <Button variant="primary" on_click=start disabled=starting>
                        {move || if starting.get() {
                            view! { <Spinner label="Starting" /> }.into_any()
                        } else {
                            "Start".into_any()
                        }}
                    </Button>
                })}
            </div>
        })
    }
}
