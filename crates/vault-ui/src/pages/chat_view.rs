//! The chat itself: port of apps/desktop/src/screens/shell/ChatView.tsx —
//! messages, change cards and the input with Send/Stop — shared by the
//! Assistant page and the chat bubble. The conversation stays in JS
//! (state/chat.ts, shared with the React shell); this draws `host.chat()` and
//! runs its actions through `host.chat_do`.

use leptos::html;
use leptos::prelude::*;
use vault_core::ai::{ChatMessage, MessageRole};
use vault_core::ai_actions::{AiActionRecord, AiActionStatus};
use wasm_bindgen::JsValue;

use super::budgets::SPREADSHEET_ACCEPT;
use crate::host::{use_host, ChatState, HostCtx};
use crate::ui::{Button, Icon, Spinner, Tag};

const DIM: &str =
    "font-size: var(--text-sm); color: var(--content-tertiary); animation: blink 1.6s infinite";

/// The messages, scrolled to the newest. `empty` shows while there are none.
#[component]
pub fn ChatMessages(
    chat: ReadSignal<ChatState>,
    #[prop(optional)] compact: bool,
    #[prop(into)] empty: ViewFn,
) -> impl IntoView {
    let messages = Memo::new(move |_| chat.with(|c| c.messages.clone()));
    let count = Memo::new(move |_| messages.with(Vec::len));
    let scroll = NodeRef::<html::Div>::new();

    Effect::new(move |_| {
        messages.track();
        // After the DOM has the new message (React's useEffect after commit).
        request_animation_frame(move || {
            if let Some(el) = scroll.get_untracked() {
                el.set_scroll_top(el.scroll_height());
            }
        });
    });

    let style = if compact {
        "flex: 1; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; min-height: 0"
    } else {
        "flex: 1; overflow: auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; min-height: 0"
    };
    view! {
        <div node_ref=scroll style=style>
            {move || (count.get() == 0).then(|| empty.run())}
            // Keyed by position, like React's `key={i}`.
            <For each=move || 0..count.get() key=|i| *i let:i>
                <MessageRow messages i compact />
            </For>
            {move || chat.with(|c| c.error.clone()).map(|e| view! {
                <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
            })}
        </div>
    }
}

#[component]
fn MessageRow(messages: Memo<Vec<ChatMessage>>, i: usize, compact: bool) -> impl IntoView {
    let m = Memo::new(move |_| messages.with(|ms| ms.get(i).cloned()));
    let role = Memo::new(move |_| m.with(|m| m.as_ref().map(|m| m.role)));
    move || match role.get() {
        None => ().into_any(),
        Some(MessageRole::User) => view! { <UserMessage m compact /> }.into_any(),
        Some(MessageRole::Assistant) => view! { <AssistantMessage m i compact /> }.into_any(),
    }
}

#[component]
fn UserMessage(m: Memo<Option<ChatMessage>>, compact: bool) -> impl IntoView {
    let style = format!(
        "align-self: flex-end; max-width: {}; background: var(--color-accent-800); color: var(--color-accent-100); padding: 9px 14px; border-radius: 16px 16px 4px 16px; font-size: var(--text-base); line-height: 1.5",
        if compact { "85%" } else { "72%" }
    );
    view! {
        <div style=style>
            {move || m.with(|m| {
                let Some(m) = m else { return Vec::new() };
                let chip = if m.text.is_empty() { "margin-bottom: 0px" } else { "margin-bottom: 6px" };
                m.files.iter().map(|f| view! {
                    <div class="chat-file-chip" style=chip>
                        <Icon name="report" size=14 />" "{f.clone()}
                    </div>
                }).collect::<Vec<_>>()
            })}
            {move || m.with(|m| m.as_ref().map(|m| m.text.clone()).unwrap_or_default())}
        </div>
    }
}

#[component]
fn AssistantMessage(m: Memo<Option<ChatMessage>>, i: usize, compact: bool) -> impl IntoView {
    let host = use_host();
    // ApproveAll's `working`, kept while the count changes under it.
    let working = RwSignal::new(false);
    let pending =
        Memo::new(move |_| m.with(|m| m.as_ref().map_or(0, ChatMessage::pending_actions)));
    let action_ids = Memo::new(move |_| {
        m.with(|m| {
            m.as_ref()
                .map(|m| m.actions.iter().map(|a| a.id.clone()).collect::<Vec<_>>())
                .unwrap_or_default()
        })
    });
    let style = format!(
        "align-self: flex-start; max-width: {}; display: flex; flex-direction: column; gap: 7px",
        if compact { "95%" } else { "82%" }
    );
    let body = move || {
        m.with(|m| {
            let m = m.as_ref()?;
            let shown = m.shown_text();
            Some(if m.pending && shown.is_empty() {
                if let Some(s) = &m.status {
                    view! { <div style=DIM>{s.clone()}</div> }.into_any()
                } else if m.thinking {
                    view! { <div style=DIM>"Thinking it through…"</div> }.into_any()
                } else {
                    view! {
                        <div style="font-size: var(--text-xl); letter-spacing: 3px; color: var(--content-tertiary); animation: blink 1s infinite">"···"</div>
                    }
                    .into_any()
                }
            } else {
                let status = m.status.clone().filter(|_| m.pending);
                view! {
                    <div style="font-size: var(--text-base); line-height: 1.6; white-space: pre-line">
                        {shown}
                        {status.map(|s| view! { <div style=format!("{DIM}; margin-top: 6px")>{s}</div> })}
                    </div>
                }
                .into_any()
            })
        })
    };
    let approve_all = move || {
        (pending.get() > 1).then(|| {
            let host = host.clone();
            view! {
                <Button variant="primary" size="sm" icon="check" disabled=working
                    style="align-self: flex-start"
                    on_click=move || {
                        working.set(true);
                        let host = host.clone();
                        wasm_bindgen_futures::spawn_local(async move {
                            host.chat_do("approveAll", &[JsValue::from(i as u32)]).await;
                            working.set(false);
                        });
                    }>
                    {move || if working.get() { "Applying…".to_string() } else { format!("Approve all {}", pending.get()) }}
                </Button>
            }
        })
    };
    view! {
        <div style=style>
            <Tag variant="accent" style="align-self: flex-start; font-size: var(--text-3xs)">"✦ AI advisor"</Tag>
            {body}
            {move || m.with(|m| m.as_ref().is_some_and(|m| m.stopped)).then(|| view! {
                <div style="font-size: var(--text-xs); color: var(--content-tertiary)">"Stopped."</div>
            })}
            {approve_all}
            <For each=move || action_ids.get() key=|id| id.clone() let:id>
                <ActionCard record=Memo::new({
                    let id = id.clone();
                    move |_| m.with(|m| m.as_ref().and_then(|m| m.actions.iter().find(|a| a.id == id).cloned()))
                }) />
            </For>
            {move || m.with(|m| m.as_ref().map(|m| m.remembered.clone()).unwrap_or_default()).into_iter().map(|note| view! {
                <div style="font-size: var(--text-xs); color: var(--content-tertiary)">"✦ Saved to memory: "{note}</div>
            }).collect::<Vec<_>>()}
        </div>
    }
}

/// One proposed change: what it is, and Approve / Decline while it's pending.
#[component]
fn ActionCard(record: Memo<Option<AiActionRecord>>) -> impl IntoView {
    let host = use_host();
    let working = RwSignal::new(false);
    let decide = move |approve: bool| {
        working.set(true);
        if let Some(id) = record.with_untracked(|r| r.as_ref().map(|r| r.id.clone())) {
            host.chat_fire("decide", vec![id.into(), approve.into()]);
        }
    };
    move || {
        record.get().map(|a| {
            let tone = match a.status {
                AiActionStatus::Applied => "var(--color-positive)",
                AiActionStatus::Failed => "var(--color-negative)",
                _ => "var(--content-tertiary)",
            };
            let mark = match a.status {
                AiActionStatus::Applied => "✓ ",
                AiActionStatus::Failed => "✕ ",
                _ => "",
            };
            let decide = decide.clone();
            view! {
                <div style="border: 1px solid var(--color-divider); border-radius: var(--radius-md); background: var(--color-surface); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: var(--text-sm)">
                    <div style="display: flex; gap: 8px; align-items: baseline; justify-content: space-between">
                        <span style="font-weight: 600">{a.summary.clone()}</span>
                        <span style=format!("color: {tone}; font-weight: 600; font-size: var(--text-xs); white-space: nowrap")>
                            {mark}{a.status.label()}
                        </span>
                    </div>
                    {a.error.clone().map(|e| view! {
                        <div style="color: var(--color-negative); font-size: var(--text-xs)">{e}</div>
                    })}
                    {(a.status == AiActionStatus::Pending).then(|| {
                        let d2 = decide.clone();
                        view! {
                            <div style="display: flex; gap: 8px">
                                <Button variant="primary" size="sm" disabled=working on_click=move || decide(true)>"Approve"</Button>
                                <Button variant="ghost" size="sm" disabled=working on_click=move || d2(false)>"Decline"</Button>
                            </div>
                        }
                    })}
                </div>
            }
        })
    }
}

/// Input with Send, which turns into Stop while a reply is coming in, and a
/// paperclip for attaching a spreadsheet (CSV or Excel).
#[component]
pub fn ChatComposer(
    chat: ReadSignal<ChatState>,
    #[prop(into)] disabled: Signal<bool>,
    #[prop(optional)] compact: bool,
    #[prop(optional)] autofocus: bool,
) -> impl IntoView {
    let host = use_host();
    let input = RwSignal::new(String::new());
    let busy = Memo::new(move |_| chat.with(|c| c.busy));
    let attachment = Memo::new(move |_| chat.with(|c| c.attachment.clone()));
    let file_ref = NodeRef::<html::Input>::new();
    let text_ref = NodeRef::<html::Input>::new();

    if autofocus {
        Effect::new(move |_| {
            if let Some(el) = text_ref.get() {
                let _ = el.focus();
            }
        });
    }

    let pick = {
        let host = host.clone();
        move |file: web_sys::File| {
            let host = host.clone();
            wasm_bindgen_futures::spawn_local(async move {
                match host.read_spreadsheet(&file).await {
                    Ok(sheet) => {
                        host.chat_do("attach", &[HostCtx::arg(&sheet)]).await;
                        host.chat_do("setError", &[JsValue::NULL]).await;
                    }
                    Err(msg) => host.chat_do("setError", &[msg.into()]).await,
                }
            });
        }
    };
    let submit = {
        let host = host.clone();
        move |e: leptos::ev::SubmitEvent| {
            e.prevent_default();
            if busy.get_untracked() {
                return;
            }
            let text = input.get_untracked();
            input.set(String::new());
            host.chat_fire("send", vec![text.into()]);
        }
    };
    let remove = {
        let host = host.clone();
        move |_| host.chat_fire("attach", vec![JsValue::NULL])
    };
    let stop = {
        let host = host.clone();
        move || host.chat_fire("stop", Vec::new())
    };
    let style = if compact {
        "flex: none; border-top: 1px solid var(--color-divider); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px"
    } else {
        "flex: none; border-top: 1px solid var(--color-divider); padding: 12px 24px; display: flex; flex-direction: column; gap: 8px"
    };

    view! {
        <form on:submit=submit class="chat-composer" style=style>
            {move || attachment.get().map(|name| {
                let remove = remove.clone();
                view! {
                    <div class="chat-file-chip chat-file-chip-pending">
                        <Icon name="report" size=14 />
                        <span class="truncate" style="min-width: 0">{name}</span>
                        <button type="button" aria-label="Remove the attached file" on:click=remove>"×"</button>
                    </div>
                }
            })}
            <div style="display: flex; gap: 10px">
                <input node_ref=file_ref type="file" accept=SPREADSHEET_ACCEPT style="display: none"
                    on:change=move |e| {
                        let el: web_sys::HtmlInputElement = event_target(&e);
                        if let Some(file) = el.files().and_then(|f| f.get(0)) {
                            pick(file);
                        }
                        el.set_value("");
                    } />
                <Button variant="ghost" icon="upload" aria_label="Attach a spreadsheet"
                    title="Attach a spreadsheet (CSV or Excel) — like a budget to import"
                    disabled=Signal::derive(move || disabled.get() || busy.get())
                    on_click=move || {
                        if let Some(el) = file_ref.get_untracked() {
                            el.click();
                        }
                    } />
                <input node_ref=text_ref class="input" style="flex: 1; border-radius: var(--radius-md); min-width: 0"
                    placeholder=move || if attachment.with(Option::is_some) {
                        "What should I do with it? (or just Send to import the budget)"
                    } else {
                        "Ask about your money…"
                    }
                    prop:value=move || input.get()
                    on:input=move |e| input.set(event_target_value(&e))
                    disabled=move || disabled.get()
                    aria-label="Ask about your money" enterkeyhint="send" />
                {move || if busy.get() {
                    let stop = stop.clone();
                    view! {
                        <Button variant="secondary" style="white-space: nowrap" aria_label="Stop the reply" on_click=stop>
                            <Spinner label="Thinking" />" Stop"
                        </Button>
                    }.into_any()
                } else {
                    view! {
                        <Button variant="primary" submit=true style="white-space: nowrap"
                            disabled=Signal::derive(move || disabled.get() || (input.with(|t| t.trim().is_empty()) && attachment.with(Option::is_none)))
                            on_click=|| ()>
                            "Send"
                        </Button>
                    }.into_any()
                }}
            </div>
        </form>
    }
}
