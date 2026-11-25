//! Settings, part B: port of the sections of
//! apps/desktop/src/screens/shell/SettingsPage.tsx from `AiSection` to
//! `ServerSection`. The security and connection sections are in
//! [`security`]; the page frame (tabs, the other sections) is part A.

use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::ai::{
    AiLevel, AiProvider, AiQuality, AiStatus, AiTestRequest, AiTestResponse,
    UpdateAiSettingsRequest,
};
use vault_core::ai_actions::AiMemoryResponse;
use vault_core::bank::{
    BankLinkStartRequest, BankLinkStartResponse, BankLinkStatus, BankProvider, BankStatus,
    BankSyncResponse, PlaidEnv, UpdateBankSettingsRequest,
};
use vault_core::platform::PrivateNetworkId;
use vault_core::reports::{ReviewPeriod, ReviewPrefs};
use vault_core::serde_util::{js_trim, OrderedMap};
use vault_core::settings::{self as logic, THEMES};
use vault_core::startup_checks::{CheckAction, UiCheck};
use wasm_bindgen::JsValue;

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::storage;
use crate::ui::{
    use_id, Button, Card, Field, Segmented, Select, SelectOption, Spinner, StatusList, Tag,
    TailscaleControl,
};

mod security;
pub use security::{
    AlternateAddressControl, AutoLockSection, BiometricSection, PasswordSection, ServerSection,
    SessionsSection, TrustedDevicesSection, TwoFactorSection,
};

type Fetch<T> = Rc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<T, String>>>>>;

/// `useData`: fetched on mount, refetched by `reload()` and whenever the
/// assistant changes data. Keeps the last result while refetching.
pub(super) struct Data<T: Send + Sync + 'static> {
    pub data: RwSignal<Option<T>>,
    pub loading: RwSignal<bool>,
    generation: StoredValue<u32>,
    fetch: StoredValue<Fetch<T>, LocalStorage>,
}

impl<T: Send + Sync + 'static> Clone for Data<T> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<T: Send + Sync + 'static> Copy for Data<T> {}

impl<T: Send + Sync + 'static> Data<T> {
    pub fn new<F, Fut>(f: F) -> Self
    where
        F: Fn() -> Fut + 'static,
        Fut: Future<Output = Result<T, String>> + 'static,
    {
        let fetch: Fetch<T> = Rc::new(move || Box::pin(f()));
        let this = Data {
            data: RwSignal::new(None),
            loading: RwSignal::new(true),
            generation: StoredValue::new(0),
            fetch: StoredValue::new_local(fetch),
        };
        let version = use_host().data_version;
        Effect::new(move |prev: Option<u32>| {
            let v = version.get();
            if prev.is_some_and(|p| p != v) {
                this.reload();
            }
            v
        });
        this.reload();
        this
    }

    pub fn reload(self) {
        spawn_local(self.load());
    }

    /// `await reload()`.
    pub async fn load(self) {
        let Some(gen) = self.generation.try_update_value(|g| {
            *g += 1;
            *g
        }) else {
            return;
        };
        let _ = self.loading.try_set(true);
        let Some(fetch) = self.fetch.try_get_value() else {
            return;
        };
        let result = fetch().await;
        if self.generation.try_get_value() != Some(gen) {
            return;
        }
        if let Ok(v) = result {
            let _ = self.data.try_set(Some(v));
        }
        let _ = self.loading.try_set(false);
    }
}

/// A `Segmented` bound to a store value: shows what the store has and runs
/// `set` when the person picks another option.
fn bound_seg(
    current: impl Fn() -> &'static str + Send + Sync + 'static,
    set: impl Fn(&'static str) + 'static,
) -> RwSignal<&'static str> {
    let current = Signal::derive(current);
    let sig = RwSignal::new(current.get_untracked());
    Effect::new(move || sig.set(current.get()));
    Effect::new(move |prev: Option<()>| {
        let v = sig.get();
        if prev.is_some() && v != current.get_untracked() {
            set(v);
        }
    });
    sig
}

fn spinner_or(busy: Signal<bool>, label: &'static str, text: &'static str) -> impl IntoView {
    move || {
        if busy.get() {
            view! { <Spinner label=label /> }.into_any()
        } else {
            text.into_any()
        }
    }
}

fn alert(msg: Signal<Option<String>>, style: &'static str) -> impl IntoView {
    move || {
        msg.get()
            .map(|m| view! { <div role="alert" style=style>{m}</div> })
    }
}

const ALERT: &str = "font-size: var(--text-sm); color: var(--color-negative)";
const ALERT_MT8: &str = "font-size: var(--text-sm); color: var(--color-negative); margin-top: 8px";
const DOT: &str = "width: 8px; height: 8px; border-radius: 50%; background: ";

pub(super) fn dot(color: &str) -> impl IntoView {
    view! { <span aria-hidden="true" style=format!("{DOT}{color}")></span> }
}

fn provider_of(s: &str) -> AiProvider {
    AiProvider::ALL
        .into_iter()
        .find(|p| p.as_str() == s)
        .unwrap_or(AiProvider::Ollama)
}

const SAVED_KEY: &str = "•••••••• (saved — leave blank to keep)";

#[component]
pub fn AiSection() -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let status = {
        let host = host.clone();
        Data::new(move || {
            let host = host.clone();
            async move { host.call::<AiStatus>("aiStatus", &[]).await }
        })
    };

    let provider = RwSignal::new("ollama".to_string());
    let model = RwSignal::new(String::new());
    let api_key = RwSignal::new(String::new());
    let base_url = RwSignal::new(String::new());
    let enabled = RwSignal::new(false);
    let quality_models = RwSignal::new(OrderedMap::<String>::default());
    let show_model_names = RwSignal::new(false);
    let installed = RwSignal::new(Vec::<String>::new());
    let refreshing = RwSignal::new(false);
    let dirty = RwSignal::new(false);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let test = RwSignal::new(None::<AiTestResponse>);

    // Seed the form from server state until the user starts editing.
    Effect::new(move || {
        let Some(s) = status.data.get() else { return };
        if dirty.get() {
            return;
        }
        provider.set(s.provider.as_str().to_string());
        model.set(s.model.clone());
        base_url.set(s.base_url.clone());
        enabled.set(s.enabled);
        quality_models.set(s.quality_models.clone());
        show_model_names.set(s.show_model_names);
        installed.set(s.available_models.clone());
        api_key.set(String::new());
    });

    let prov = Signal::derive(move || provider_of(&provider.get()));
    let is_cloud = move || prov.get().is_cloud();
    let is_local = move || prov.get().is_local();
    let touch = move || dirty.set(true);

    let test_connection = {
        let host = host.clone();
        move || {
            refreshing.set(true);
            error.set(None);
            test.set(None);
            let key = js_trim(&api_key.get_untracked()).to_string();
            let body = AiTestRequest {
                provider: prov.get_untracked(),
                base_url: Some(js_trim(&base_url.get_untracked()).to_string()),
                api_key: (!key.is_empty()).then_some(key),
            };
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<AiTestResponse>("testAiConnection", &[HostCtx::arg(&body)])
                    .await
                {
                    Ok(r) => {
                        if r.ok {
                            let _ = installed.try_set(r.models.clone());
                            if r.models.is_empty() {
                                let _ = error.try_set(Some(if body.provider == AiProvider::Ollama {
                                    "Connected, but no models are installed. On the AI machine run e.g. “ollama pull llama3.2:3b”.".into()
                                } else {
                                    "Connected, but the server has no model loaded yet.".into()
                                }));
                            }
                        }
                        let _ = test.try_set(Some(r));
                    }
                    Err(e) => {
                        let _ =
                            error.try_set(Some(e.message_or("Couldn't run the connection test.")));
                    }
                }
                let _ = refreshing.try_set(false);
            });
        }
    };

    let save = {
        let host = host.clone();
        move || {
            if busy.get_untracked() {
                return;
            }
            busy.set(true);
            error.set(None);
            let p = prov.get_untracked();
            let qm = quality_models.get_untracked();
            let resolved = logic::resolved_model(
                p,
                &model.get_untracked(),
                qm.get("normal").map(String::as_str),
                &installed.get_untracked(),
            );
            let key = js_trim(&api_key.get_untracked()).to_string();
            let body = UpdateAiSettingsRequest {
                enabled: enabled.get_untracked(),
                provider: p,
                model: js_trim(&resolved).to_string(),
                api_key: (!key.is_empty()).then_some(key),
                base_url: Some(js_trim(&base_url.get_untracked()).to_string()),
                quality_models: p.is_local().then_some(qm),
                show_model_names: Some(show_model_names.get_untracked()),
            };
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<IgnoredAny>("updateAiSettings", &[HostCtx::arg(&body)])
                    .await
                {
                    Ok(_) => {
                        let _ = api_key.try_set(String::new());
                        let _ = dirty.try_set(false);
                        status.reload();
                        let _ = host.store::<IgnoredAny>("refreshAiEnabled", &[]).await;
                    }
                    Err(e) => {
                        let _ = error.try_set(Some(e.message_or("Couldn't save AI settings.")));
                    }
                }
                let _ = busy.try_set(false);
            });
        }
    };

    let clear_key = {
        let host = host.clone();
        move || {
            busy.set(true);
            let body = UpdateAiSettingsRequest {
                enabled: enabled.get_untracked(),
                provider: prov.get_untracked(),
                model: js_trim(&model.get_untracked()).to_string(),
                api_key: Some(String::new()),
                base_url: Some(js_trim(&base_url.get_untracked()).to_string()),
                quality_models: None,
                show_model_names: None,
            };
            let host = host.clone();
            spawn_local(async move {
                if host
                    .call::<IgnoredAny>("updateAiSettings", &[HostCtx::arg(&body)])
                    .await
                    .is_ok()
                {
                    let _ = api_key.try_set(String::new());
                    let _ = dirty.try_set(false);
                    status.reload();
                    let _ = host.store::<IgnoredAny>("refreshAiEnabled", &[]).await;
                }
                let _ = busy.try_set(false);
            });
        }
    };

    let provider_options: Vec<SelectOption> = AiProvider::ALL
        .iter()
        .map(|p| SelectOption::new(p.as_str(), p.label()))
        .collect();
    let on_provider = Callback::new(move |v: String| {
        let next = provider_of(&v);
        model.set(
            next.model_suggestions()
                .first()
                .copied()
                .unwrap_or("")
                .to_string(),
        );
        if let Some(ex) = logic::base_url_after_switch(next, &base_url.get_untracked()) {
            base_url.set(ex.to_string());
        }
        api_key.set(String::new());
        test.set(None);
        dirty.set(true);
    });

    // "saved — leave blank to keep" while the saved key belongs to this provider.
    let key_saved = move || {
        status.data.with(|s| {
            s.as_ref()
                .is_some_and(|s| s.has_api_key && s.provider == prov.get())
        })
    };

    let quality_grid = move || {
        AiQuality::LEVELS
            .into_iter()
            .map(|level| {
                let key = level.as_str();
                let val = RwSignal::new(String::new());
                Effect::new(move || {
                    val.set(quality_models.with(|m| m.get(key).cloned().unwrap_or_default()))
                });
                let missing = move || {
                    let v = val.get();
                    !v.is_empty() && !installed.with(|i| i.contains(&v))
                };
                let options = Signal::derive(move || {
                    let v = val.get();
                    let mut o = vec![SelectOption::new("", "Not set")];
                    o.extend(installed.get().into_iter().map(|m| SelectOption::new(m.clone(), m)));
                    if missing() {
                        o.push(SelectOption::new(v.clone(), format!("{v} (not installed)")));
                    }
                    o
                });
                let label = Signal::derive(move || {
                    let v = val.get();
                    if show_model_names.get() && !v.is_empty() {
                        format!("{} ({v})", level.label())
                    } else {
                        level.label().to_string()
                    }
                });
                let on_change = Callback::new(move |m: String| {
                    quality_models.update(|map| {
                        match map.0.iter_mut().find(|(k, _)| k == key) {
                            Some((_, v)) => *v = m,
                            None => map.0.push((key.to_string(), m)),
                        }
                    });
                    dirty.set(true);
                });
                view! {
                    <div>
                        <Select label=label value=val options=options on_change=on_change />
                        {move || missing().then(|| view! {
                            <div style="font-size: var(--text-xs); color: var(--color-negative); margin-top: 3px">
                                "Not installed — pull it or pick another."
                            </div>
                        })}
                    </div>
                }
            })
            .collect_view()
    };

    let key_id = use_id();
    let body = move || {
        let s = status.data.get()?;
        let is_owner = app.with(|a| a.is_owner());
        let show_check = s.enabled && s.configured;
        let failure = (s.enabled && s.configured && !s.reachable)
            .then(|| s.error.clone())
            .flatten()
            .filter(|e| !e.is_empty())
            .map(|e| {
                view! {
                    <div class="card-meta" style="line-height: 1.5">
                        <strong>{e}</strong>" "{s.hint.clone().unwrap_or_default()}
                    </div>
                }
            });
        let owner_form = {
            let test_connection = test_connection.clone();
            let test_connection2 = test_connection.clone();
            let save = save.clone();
            let clear_key = clear_key.clone();
            let provider_options = provider_options.clone();
            let key_id = key_id.clone();
            move || {
                let test_connection = test_connection.clone();
                let test_connection2 = test_connection2.clone();
                let save = save.clone();
                let clear_key = clear_key.clone();
                let key_id = key_id.clone();
                view! {
                    <div style="display: flex; gap: 10px; flex-wrap: wrap">
                        <div style="flex: 1; min-width: 160px">
                            <Select label="Provider" value=provider options=provider_options.clone() on_change=on_provider />
                        </div>
                        {move || is_cloud().then(|| view! {
                            <div style="flex: 1; min-width: 160px">
                                <Field label="Model" value=model list="ai-model-suggestions"
                                    on_input=Callback::new(move |_| touch())
                                    placeholder=Signal::derive(move || prov.get().model_suggestions().first().copied().unwrap_or("")) />
                                <datalist id="ai-model-suggestions">
                                    {move || prov.get().model_suggestions().iter().map(|m| view! { <option value=*m></option> }).collect_view()}
                                </datalist>
                            </div>
                        })}
                    </div>
                    {move || if is_local() {
                        let test_connection = test_connection.clone();
                        view! {
                            <Field label=Signal::derive(move || if prov.get() == AiProvider::Ollama { "Ollama address".to_string() } else { "AI server address".to_string() })
                                value=base_url no_spellcheck=true
                                on_input=Callback::new(move |_| { test.set(None); touch(); })
                                placeholder=Signal::derive(move || prov.get().base_url_example().unwrap_or(""))
                                hint=Signal::derive(move || if prov.get() == AiProvider::Ollama {
                                    "“http://ollama:11434” is the Ollama bundled with your server. For Ollama on another computer (e.g. a PC with a GPU), use its LAN or Tailscale address, like http://192.168.1.50:11434 — and on that computer set OLLAMA_HOST=0.0.0.0 so it accepts connections from the network.".to_string()
                                } else {
                                    "LM Studio, llama.cpp (llama-server), vLLM, LocalAI, Jan and similar. The address usually ends in /v1, like http://192.168.1.50:1234/v1. Make sure the server listens on the network, not only on localhost.".to_string()
                                }) />
                            <Field label="Access token (optional)" input_type="password" value=api_key
                                on_input=Callback::new(move |_| touch())
                                placeholder=Signal::derive(move || if key_saved() { SAVED_KEY } else { "Only if your AI server asks for one" })
                                hint="For an AI server behind a login or reverse proxy. Stored on your Vault server only.".to_string() />
                            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
                                <Button variant="secondary" on_click=test_connection.clone()
                                    disabled=Signal::derive(move || refreshing.get() || js_trim(&base_url.get()).is_empty())>
                                    {spinner_or(refreshing.into(), "Testing", "Test connection")}
                                </Button>
                                {move || test.get().filter(|t| t.ok).map(|t| view! {
                                    <span style="font-size: var(--text-sm); color: var(--color-positive)">
                                        {logic::ai_test_summary(t.models.len(), t.latency_ms)}
                                    </span>
                                })}
                            </div>
                            {move || test.get().filter(|t| !t.ok).map(|t| view! {
                                <div role="alert" style="font-size: var(--text-sm); line-height: 1.55; padding: 10px 12px; border-radius: var(--radius-md); background: var(--color-negative-soft)">
                                    <strong>{t.error.clone().unwrap_or_default()}</strong>
                                    {t.hint.clone().filter(|h| !h.is_empty()).map(|h| view! { <div style="margin-top: 4px">{h}</div> })}
                                </div>
                            })}
                        }.into_any()
                    } else {
                        let clear_key = clear_key.clone();
                        let key_id = key_id.clone();
                        view! {
                            <div class="field">
                                <label for=key_id.clone()>{move || format!("{} API key", prov.get().label())}</label>
                                <input id=key_id.clone() class="input" type="password"
                                    placeholder=move || if key_saved() { SAVED_KEY } else { "sk-…" }
                                    prop:value=move || api_key.get()
                                    on:input=move |e| { api_key.set(event_target_value(&e)); touch(); } />
                                <div class="field-hint">
                                    {move || if key_saved() {
                                        let clear_key = clear_key.clone();
                                        view! {
                                            "A key is saved. "
                                            <button type="button" on:click=move |_| clear_key()
                                                style="background: none; border: 0px; padding: 0px; color: var(--color-accent); cursor: pointer; font: inherit">
                                                "Remove it"
                                            </button>
                                            "."
                                        }.into_any()
                                    } else {
                                        "Stored on your server, never on this device.".into_any()
                                    }}
                                </div>
                            </div>
                        }.into_any()
                    }}

                    {move || is_local().then(|| {
                        let test_connection2 = test_connection2.clone();
                        view! {
                            <div style="margin-top: 4px">
                                <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px">
                                    <span style="font-size: var(--text-sm); font-weight: 600">"Model quality levels"</span>
                                    <Button variant="ghost" on_click=test_connection2
                                        disabled=Signal::derive(move || refreshing.get() || js_trim(&base_url.get()).is_empty())>
                                        {move || if refreshing.get() { "Refreshing…" } else { "Refresh installed models" }}
                                    </Button>
                                </div>
                                <p class="card-meta" style="margin-top: 2px">
                                    "Assign an installed model to each quality tier — the app requests a tier and you decide which model runs it. The assistant's AI level picker uses Low, Medium and High; categorizing uses Medium and monthly report summaries use High."
                                </p>
                                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 8px">
                                    {quality_grid()}
                                </div>
                                <label class="radio" style="font-size: var(--text-sm); margin-top: 10px">
                                    <input type="checkbox" prop:checked=move || show_model_names.get()
                                        on:change=move |e| { show_model_names.set(event_target_checked(&e)); touch(); } />
                                    <span class="dot" style="border-radius: var(--radius-sm)"></span>
                                    "Show technical model names"
                                </label>
                            </div>
                        }
                    })}

                    {move || is_cloud().then(|| {
                        let label = prov.get().label();
                        view! {
                            <div role="note" style="font-size: var(--text-sm); line-height: 1.6; padding: 10px 12px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-negative) 10%, transparent); border: 1px solid color-mix(in srgb, var(--color-negative) 35%, transparent)">
                                <strong>"Heads up:"</strong>" "{label}" is a cloud service. When you ask a question, a summary of your accounts, spending, and budgets is sent to "{label}" under your API key. Choose Ollama to keep everything on your own hardware."
                            </div>
                        }
                    })}

                    <label class="radio" style="font-size: var(--text-sm)">
                        <input type="checkbox" prop:checked=move || enabled.get()
                            on:change=move |e| { enabled.set(event_target_checked(&e)); touch(); } />
                        <span class="dot" style="border-radius: var(--radius-sm)"></span>
                        "Enable the AI assistant"
                    </label>

                    {alert(error.into(), ALERT)}
                    <div>
                        <Button variant="primary" on_click=save.clone()
                            disabled=Signal::derive(move || !dirty.get() || busy.get())>
                            {spinner_or(busy.into(), "Saving", "Save & test")}
                        </Button>
                    </div>
                }
            }
        };
        Some(view! {
            <p class="card-body">
                "Off by default. Turn it on and connect a provider to get spending explanations, forecasts, and monthly summaries. The server talks to the provider — the desktop app never holds your key."
            </p>
            <div style="display: flex; align-items: center; gap: 8px">
                {dot(logic::ai_status_color(&s))}
                <span style="font-size: var(--text-sm)">{logic::ai_status_line(&s)}</span>
                {show_check.then(|| view! {
                    <Button variant="ghost" on_click=move || status.reload() style="margin-left: auto">"Check again"</Button>
                })}
            </div>
            {failure}
            {if is_owner {
                owner_form().into_any()
            } else {
                view! { <p class="card-meta">"Only the owner can change AI settings."</p> }.into_any()
            }}
        })
    };

    view! {
        <Card kicker="AI assistant" title="AI assistant (optional)">
            {move || if status.data.with(Option::is_none) {
                view! { <Spinner label="Checking AI status" /> }.into_any()
            } else {
                body.clone()().into_any()
            }}
        </Card>
    }
}

/// An open Plaid sign-in: the app polls until the person finishes.
#[derive(Debug, Clone, PartialEq)]
struct Linking {
    session_id: String,
    url: String,
    reconnect: bool,
}

/// Optional bank linking (ADR-0007). Off by default.
#[component]
pub fn BankSection() -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let status = {
        let host = host.clone();
        Data::new(move || {
            let host = host.clone();
            async move { host.call::<BankStatus>("bankStatus", &[]).await }
        })
    };
    let enabled = RwSignal::new(false);
    let provider = RwSignal::new("mock".to_string());
    let plaid_env = RwSignal::new("sandbox".to_string());
    let linking = RwSignal::new(None::<Linking>);
    let client_id = RwSignal::new(String::new());
    let secret = RwSignal::new(String::new());
    let dirty = RwSignal::new(false);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let message = RwSignal::new(None::<String>);

    Effect::new(move || {
        let Some(s) = status.data.get() else { return };
        if dirty.get() {
            return;
        }
        enabled.set(s.enabled);
        provider.set(
            if s.provider == BankProvider::Plaid {
                "plaid"
            } else {
                "mock"
            }
            .into(),
        );
        plaid_env.set(
            if s.plaid_env == PlaidEnv::Production {
                "production"
            } else {
                "sandbox"
            }
            .into(),
        );
        client_id.set(String::new());
        secret.set(String::new());
    });

    let is_plaid = move || provider.get() == "plaid";
    let touch = move || dirty.set(true);
    let start = move || {
        busy.set(true);
        error.set(None);
        message.set(None);
    };

    let save = {
        let host = host.clone();
        move || {
            if busy.get_untracked() {
                return;
            }
            start();
            let plaid = provider.get_untracked() == "plaid";
            let id = js_trim(&client_id.get_untracked()).to_string();
            let sec = js_trim(&secret.get_untracked()).to_string();
            let body = UpdateBankSettingsRequest {
                enabled: enabled.get_untracked(),
                provider: if plaid {
                    BankProvider::Plaid
                } else {
                    BankProvider::Mock
                },
                plaid_env: plaid.then(|| {
                    if plaid_env.get_untracked() == "production" {
                        PlaidEnv::Production
                    } else {
                        PlaidEnv::Sandbox
                    }
                }),
                plaid_client_id: (!id.is_empty()).then_some(id),
                plaid_secret: (!sec.is_empty()).then_some(sec),
            };
            let host = host.clone();
            spawn_local(async move {
                match host
                    .call::<IgnoredAny>("updateBankSettings", &[HostCtx::arg(&body)])
                    .await
                {
                    Ok(_) => {
                        let _ = secret.try_set(String::new());
                        let _ = dirty.try_set(false);
                        status.load().await;
                        let _ = message.try_set(Some("Saved.".into()));
                    }
                    Err(_) => {
                        let _ = error.try_set(Some("Couldn't save bank settings.".into()));
                    }
                }
                let _ = busy.try_set(false);
            });
        }
    };

    let link_bank = {
        let host = host.clone();
        Callback::new(move |connection_id: Option<String>| {
            start();
            let host = host.clone();
            spawn_local(async move {
                let body = BankLinkStartRequest {
                    connection_id: connection_id.clone(),
                };
                match host
                    .try_call::<BankLinkStartResponse>("bankLinkStart", &[HostCtx::arg(&body)])
                    .await
                {
                    Ok(r) => {
                        let _ = linking.try_set(Some(Linking {
                            session_id: r.session_id,
                            url: r.url.clone(),
                            reconnect: connection_id.is_some(),
                        }));
                        host.open_external(&r.url);
                    }
                    Err(e) => {
                        let _ = error.try_set(Some(if e.is_api_request() {
                            e.message
                        } else {
                            "Couldn't start Plaid. Check your Plaid keys and environment.".into()
                        }));
                    }
                }
                let _ = busy.try_set(false);
            });
        })
    };

    // Poll an open Plaid sign-in every 3 s (5 s after a failed poll).
    {
        let host = host.clone();
        Effect::new(move || {
            let Some(l) = linking.get() else { return };
            let stopped = StoredValue::new(false);
            on_cleanup(move || stopped.set_value(true));
            let host = host.clone();
            spawn_local(async move {
                let mut delay = 3_000;
                loop {
                    gloo_sleep(delay).await;
                    if stopped.try_get_value() != Some(false) {
                        return;
                    }
                    let r = host
                        .call::<BankLinkStatus>(
                            "bankLinkStatus",
                            &[JsValue::from_str(&l.session_id)],
                        )
                        .await;
                    if stopped.try_get_value() != Some(false) {
                        return;
                    }
                    let Ok(r) = r else {
                        delay = 5_000;
                        continue;
                    };
                    let Some(outcome) = logic::bank_link_outcome(&r) else {
                        delay = 3_000;
                        continue;
                    };
                    let _ = linking.try_set(None);
                    match outcome {
                        Ok(m) => {
                            let _ = message.try_set(Some(m));
                            status.load().await;
                        }
                        Err(e) => {
                            let _ = error.try_set(Some(e));
                        }
                    }
                    return;
                }
            });
        });
    }

    let connect = {
        let host = host.clone();
        move || {
            start();
            let host = host.clone();
            spawn_local(async move {
                match host.call::<BankSyncResponse>("bankConnect", &[]).await {
                    Ok(r) => {
                        let _ = message.try_set(Some(format!(
                            "Connected {}: {} accounts, {} transactions imported.",
                            r.institution_name, r.accounts_linked, r.imported
                        )));
                        status.load().await;
                    }
                    Err(_) => {
                        let _ = error.try_set(Some(
                            "Connect failed — make sure the provider is enabled and configured."
                                .into(),
                        ));
                    }
                }
                let _ = busy.try_set(false);
            });
        }
    };

    let sync = {
        let host = host.clone();
        Callback::new(move |id: String| {
            start();
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<BankSyncResponse>("bankSync", &[JsValue::from_str(&id)])
                    .await
                {
                    Ok(r) => {
                        let _ = message.try_set(Some(format!(
                            "Synced: {} new, {} already imported.",
                            r.imported, r.skipped_duplicates
                        )));
                        status.load().await;
                    }
                    Err(e) => {
                        let _ = error.try_set(Some(if e.is_api_request() {
                            e.message
                        } else {
                            "Sync failed.".into()
                        }));
                        status.load().await;
                    }
                }
                let _ = busy.try_set(false);
            });
        })
    };

    let disconnect = {
        let host = host.clone();
        Callback::new(move |id: String| {
            start();
            let host = host.clone();
            spawn_local(async move {
                match host
                    .call::<IgnoredAny>("bankDisconnect", &[JsValue::from_str(&id)])
                    .await
                {
                    Ok(_) => {
                        status.load().await;
                        let _ = message.try_set(Some(
                            "Disconnected. The imported accounts and history were kept.".into(),
                        ));
                    }
                    Err(_) => {
                        let _ = error.try_set(Some("Disconnect failed.".into()));
                    }
                }
                let _ = busy.try_set(false);
            });
        })
    };

    let has_creds = move || {
        status
            .data
            .with(|s| s.as_ref().is_some_and(|s| s.has_plaid_credentials))
    };
    let provider_options = vec![
        SelectOption::new("mock", BankProvider::Mock.label()),
        SelectOption::new("plaid", BankProvider::Plaid.label()),
    ];
    let env_options = vec![
        SelectOption::new("sandbox", "Sandbox: Plaid's test banks"),
        SelectOption::new("production", "Production: your real banks"),
    ];

    let owner = move || {
        let save = save.clone();
        let connect = connect.clone();
        let host = host.clone();
        view! {
            <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end">
                <div style="flex: 1; min-width: 200px">
                    <Select label="Provider" value=provider options=provider_options.clone()
                        on_change=Callback::new(move |_| touch()) />
                </div>
            </div>
            {move || is_plaid().then(|| view! {
                <div role="note" style="margin-top: 12px; padding: 10px 12px; border-radius: var(--radius-md); font-size: var(--text-sm); line-height: 1.5; background: color-mix(in srgb, var(--color-negative) 10%, var(--color-surface)); border: 1px solid color-mix(in srgb, var(--color-negative) 30%, transparent)">
                    <strong>"Heads up — this sends data off your server."</strong>" With Plaid, your bank login and transactions flow through Plaid's cloud under your own API keys. That breaks the app's otherwise-local guarantee. The Sandbox provider keeps everything on your machine."
                </div>
            })}
            {let env_options = env_options.clone(); move || is_plaid().then(|| view! {
                <div style="margin-top: 12px; max-width: 360px">
                    <Select label="Plaid environment" value=plaid_env options=env_options.clone()
                        on_change=Callback::new(move |_| touch()) />
                    <p class="card-meta" style="margin-top: 6px">
                        {move || if plaid_env.get() == "sandbox" {
                            "Use your Sandbox keys. At the bank sign-in, use user_good / pass_good."
                        } else {
                            "Use your Production keys. Plaid must have approved your account for Production."
                        }}
                    </p>
                </div>
            })}
            {move || is_plaid().then(|| view! {
                <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px">
                    <div style="flex: 1; min-width: 180px">
                        <Field label="Plaid client ID" value=client_id on_input=Callback::new(move |_| touch())
                            placeholder=Signal::derive(move || if has_creds() { "•••• (saved)" } else { "client_id" }) />
                    </div>
                    <div style="flex: 1; min-width: 180px">
                        <Field label="Plaid secret" input_type="password" value=secret on_input=Callback::new(move |_| touch())
                            placeholder=Signal::derive(move || if has_creds() { "•••• (saved — blank keeps it)" } else { "secret" }) />
                    </div>
                </div>
            })}
            <label style="display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: var(--text-base); cursor: pointer">
                <input type="checkbox" prop:checked=move || enabled.get()
                    on:change=move |e| { enabled.set(event_target_checked(&e)); touch(); } />
                "Enable bank linking"
            </label>
            <div style="display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap">
                <Button variant="primary" on_click=save.clone() disabled=Signal::derive(move || busy.get() || !dirty.get())>"Save"</Button>
                {move || {
                    let s = status.data.get()?;
                    if !(s.enabled && s.configured && !dirty.get()) {
                        return None;
                    }
                    let connect = connect.clone();
                    Some(if s.provider == BankProvider::Plaid {
                        view! {
                            <Button variant="secondary" on_click=move || link_bank.run(None)
                                disabled=Signal::derive(move || busy.get() || linking.with(Option::is_some))>"Link a bank"</Button>
                        }.into_any()
                    } else {
                        view! {
                            <Button variant="secondary" on_click=connect disabled=busy>"Connect a sandbox bank"</Button>
                        }.into_any()
                    })
                }}
            </div>
            {move || linking.get().map(|l| {
                let host = host.clone();
                let url = l.url.clone();
                view! {
                    <div role="status" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; padding: 10px 12px; border-radius: var(--radius-md); border: 1px solid var(--color-divider); font-size: var(--text-sm)">
                        <Spinner label="Waiting for Plaid" />
                        <span style="flex: 1; min-width: 200px">
                            {if l.reconnect { "Sign in to your bank again" } else { "Finish connecting your bank" }}
                            " in the browser window that opened. This updates on its own when you're done."
                        </span>
                        <Button variant="ghost" on_click=move || host.open_external(&url)>"Open again"</Button>
                        <Button variant="ghost" on_click=move || linking.set(None)>"Cancel"</Button>
                    </div>
                }
            })}
            {move || message.get().map(|m| view! {
                <div role="status" style="font-size: var(--text-sm); color: var(--content-secondary); margin-top: 8px">{m}</div>
            })}
            {alert(error.into(), ALERT_MT8)}
            {move || {
                let s = status.data.get()?;
                (!s.connections.is_empty()).then(|| view! {
                    <div style="margin-top: 14px">
                        {s.connections.into_iter().map(|c| {
                            let id = c.id.clone();
                            let id2 = c.id.clone();
                            let id3 = c.id.clone();
                            let synced = c.last_synced_at.as_deref()
                                .map(|t| format!("synced {}", fmt::locale_string(t)))
                                .unwrap_or_else(|| "never synced".into());
                            view! {
                                <div style="display: flex; align-items: center; gap: 10px; padding: 8px 0px; border-top: 1px solid var(--color-divider)">
                                    <div>
                                        <div style="font-weight: 600; font-size: var(--text-sm)">{c.institution_name.clone()}</div>
                                        {c.needs_reconnect.then(|| view! {
                                            <div class="warn" style="font-size: var(--text-xs); font-weight: 600">"Needs you to sign in to the bank again"</div>
                                        })}
                                        <div style="font-size: var(--text-xs); color: var(--content-tertiary)">
                                            {logic::accounts_label(c.account_count)}" · "{synced}
                                        </div>
                                    </div>
                                    <div style="margin-left: auto; display: flex; gap: 8px">
                                        {if c.needs_reconnect {
                                            view! {
                                                <Button variant="primary" on_click=move || link_bank.run(Some(id.clone()))
                                                    disabled=Signal::derive(move || busy.get() || linking.with(Option::is_some))>"Reconnect"</Button>
                                            }.into_any()
                                        } else {
                                            view! {
                                                <Button variant="secondary" on_click=move || sync.run(id2.clone()) disabled=busy>"Sync"</Button>
                                            }.into_any()
                                        }}
                                        <Button variant="ghost" on_click=move || disconnect.run(id3.clone()) disabled=busy>"Disconnect"</Button>
                                    </div>
                                </div>
                            }
                        }).collect_view()}
                    </div>
                })
            }}
        }
    };

    view! {
        <Card kicker="Bank linking" title="Connected banks (optional)">
            <p class="card-body">
                "Off by default. Pull accounts and transactions automatically instead of importing CSVs. Imported transactions run through your local categorization rules."
            </p>
            {move || if app.with(|a| a.is_owner()) {
                owner.clone()().into_any()
            } else {
                view! { <p class="card-meta">"Only the owner can change bank settings."</p> }.into_any()
            }}
        </Card>
    }
}

/// `await new Promise((r) => setTimeout(r, ms))`.
pub(super) async fn gloo_sleep(ms: i32) {
    let p = js_sys::Promise::new(&mut |resolve, _| {
        let _ = window().set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms);
    });
    let _ = wasm_bindgen_futures::JsFuture::from(p).await;
}

/// Settings → System status: the startup checks, on demand.
#[component]
pub fn SystemStatusSection() -> impl IntoView {
    let host = use_host();
    let checks = RwSignal::new(Vec::<UiCheck>::new());
    let running = RwSignal::new(false);
    let checked_at = RwSignal::new(None::<f64>);
    let busy_action = RwSignal::new(None::<CheckAction>);
    let message = RwSignal::new(None::<String>);
    let alive = StoredValue::new(true);
    on_cleanup(move || alive.set_value(false));

    let run = {
        let host = host.clone();
        Callback::new(move |()| {
            let host = host.clone();
            if host.settings_now().server_address.is_none() {
                return;
            }
            let _ = running.try_set(true);
            spawn_local(async move {
                let out = host
                    .run_checks(move |list| {
                        let _ = checks.try_set(list);
                    })
                    .await;
                if let Some(list) = out {
                    let _ = checks.try_set(list);
                    let _ = checked_at.try_set(Some(js_sys::Date::now()));
                }
                let _ = running.try_set(false);
            });
        })
    };
    run.run(());

    let on_action = {
        let host = host.clone();
        Callback::new(move |a: CheckAction| {
            let host = host.clone();
            busy_action.set(Some(a));
            let name = serde_wasm_bindgen::to_value(&a)
                .ok()
                .and_then(|v| v.as_string())
                .unwrap_or_default();
            spawn_local(async move {
                host.run_check_action(
                    &name,
                    move |m| {
                        let _ = message.try_set(m);
                    },
                    move || run.run(()),
                    move || alive.try_get_value() != Some(true),
                )
                .await;
                let _ = busy_action.try_set(None);
            });
        })
    };

    view! {
        <Card kicker="Health" title="System status">
            <p class="card-body">{move || logic::checks_summary(running.get(), &checks.get())}</p>
            <StatusList checks=checks on_action=on_action busy_action=busy_action
                hide_actions=&[CheckAction::ChangeServer] />
            {move || message.get().map(|m| view! {
                <div role="status" style="font-size: var(--text-sm); color: var(--content-secondary); margin-top: 8px">{m}</div>
            })}
            <div style="display: flex; align-items: center; gap: 10px; margin-top: 10px">
                <Button variant="secondary" on_click=move || run.run(()) disabled=running>
                    {spinner_or(running.into(), "Checking", "Run checks again")}
                </Button>
                {move || checked_at.get().map(|t| view! {
                    <span class="card-meta">"Last checked "{fmt::locale_time_ms(t)}</span>
                })}
            </div>
        </Card>
    }
}

/// Settings → Network: which private network this computer uses to reach
/// the server from anywhere.
#[component]
pub fn NetworkSection() -> impl IntoView {
    let host = use_host();
    let saved =
        PrivateNetworkId::from_saved(storage::get(PrivateNetworkId::STORAGE_KEY).as_deref());
    let network = RwSignal::new(saved.as_str().to_string());
    let id = move || PrivateNetworkId::from_saved(Some(&network.get()));
    let options: Vec<SelectOption> = PrivateNetworkId::ALL
        .iter()
        .map(|n| SelectOption::new(n.as_str(), n.label()))
        .collect();
    let choose = {
        let host = host.clone();
        Callback::new(move |v: String| {
            storage::set(PrivateNetworkId::STORAGE_KEY, &v);
            host.store_fire("refreshTailscale", &[]);
        })
    };

    view! {
        <Card kicker="Network" title="Private network">
            <p class="card-body">
                "A private network lets this computer reach your Vault server securely when you're away from home, without opening ports to the internet. It's fine for it to be off at home."
            </p>
            <div style="display: grid; gap: 10px; max-width: 360px; margin-bottom: 12px">
                <Select label="What do you use?" value=network options=options on_change=choose />
            </div>
            {move || (id() == PrivateNetworkId::Headscale).then(|| view! {
                <p class="card-body">
                    "Headscale uses the Tailscale app. Join your server once in a terminal with "
                    <code>"tailscale up --login-server=https://your-headscale-address"</code>", then control it here."
                </p>
            })}
            {move || {
                let n = id();
                let host = host.clone();
                if n.uses_tailscale_client() {
                    // `key={network}`: a fresh control for each choice.
                    return view! { <TailscaleControl /> }.into_any();
                }
                view! {
                    {(n != PrivateNetworkId::None).then(|| view! {
                        <p class="card-body">
                            "Turn it on from "
                            {if n == PrivateNetworkId::Other { "your VPN's".to_string() } else { format!("the {}", n.label()) }}
                            " app when you're away from home, then connect using the server's address on that network (Settings → Connection)."
                        </p>
                    })}
                    {n.url().map(|url| view! {
                        <Button variant="ghost" on_click=move || host.open_external(url)>"Get "{n.label()}</Button>
                    })}
                }.into_any()
            }}
        </Card>
    }
}

/// What Home shows on this device.
#[component]
pub fn HomeScreenSection() -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let seg = bound_seg(
        move || {
            if app.with(|a| a.show_sankey) {
                "show"
            } else {
                "hide"
            }
        },
        move |v| host.store_fire("setShowSankey", &[JsValue::from_bool(v == "show")]),
    );
    view! {
        <Card kicker="Home screen" title="Cash-flow diagram">
            <p class="card-body">
                "The diagram of where your income goes, with its month and view controls. Hiding it only affects this device."
            </p>
            <Segmented aria_label="Cash-flow diagram on Home" options=&[("show", "Show"), ("hide", "Hide")] value=seg />
        </Card>
    }
}

#[component]
pub fn AppearanceSection() -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let seg = bound_seg(
        move || {
            let t = app.with(|a| a.theme.clone());
            THEMES.iter().find(|(v, _)| *v == t).map_or("", |(v, _)| v)
        },
        move |v| host.store_fire("setTheme", &[JsValue::from_str(v)]),
    );
    view! {
        <Card kicker="Appearance" title="Theme">
            <p class="card-body">"Automatic follows your system's light/dark preference."</p>
            <Segmented aria_label="Theme" options=&THEMES value=seg />
        </Card>
    }
}

const AI_LEVELS: [(&str, &str); 3] = [("low", "Low"), ("medium", "Medium"), ("high", "High")];

/// What the assistant may change on its own, and what it has remembered
/// (read-only: the memory file is never deleted).
#[component]
pub fn AiMemorySection() -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let ai_visible = Memo::new(move |_| app.with(|a| a.ai_visible));
    let memory = {
        let host = host.clone();
        Data::new(move || {
            let host = host.clone();
            let visible = ai_visible.get_untracked();
            async move {
                if visible {
                    host.call::<AiMemoryResponse>("aiMemory", &[])
                        .await
                        .map(Some)
                } else {
                    Ok(None)
                }
            }
        })
    };
    // useData's deps: [client, aiVisible].
    Effect::new(move |prev: Option<bool>| {
        let v = ai_visible.get();
        if prev.is_some_and(|p| p != v) {
            memory.reload();
        }
        v
    });

    let level = {
        let host = host.clone();
        bound_seg(
            move || {
                let l = app.with(|a| a.ai_level.clone());
                AI_LEVELS
                    .iter()
                    .find(|(v, _)| *v == l)
                    .map_or("medium", |(v, _)| v)
            },
            move |v| host.store_fire("setAiLevel", &[JsValue::from_str(v)]),
        )
    };
    let auto = {
        let host = host.clone();
        bound_seg(
            move || {
                if app.with(|a| a.ai_auto_apply) {
                    "auto"
                } else {
                    "ask"
                }
            },
            move |v| host.store_fire("setAiAutoApply", &[JsValue::from_bool(v == "auto")]),
        )
    };
    let hint = move || {
        AiLevel::ALL
            .into_iter()
            .find(|l| l.as_str() == level.get())
            .unwrap_or(AiLevel::Medium)
            .hint()
    };
    let notes = move || {
        memory
            .data
            .with(|d| d.as_ref().and_then(|d| d.as_ref()).map(|d| d.notes.clone()))
            .unwrap_or_default()
    };

    move || {
        ai_visible.get().then(|| view! {
            <Card kicker="AI assistant" title="Changes & memory">
                <p class="card-body">
                    "The assistant can reorganise categories, add auto-categorization rules, set budgets and planned income, rename the household, and change the theme and finance review settings. It can't touch security, members, bank links or AI settings."
                </p>
                <div class="field">
                    <label>"AI level on this device"</label>
                    <Segmented aria_label="AI level" options=&AI_LEVELS value=level />
                    <p class="card-meta" style="margin: 4px 0px 0px">{hint}</p>
                </div>
                <div class="field">
                    <label>"When it wants to change something"</label>
                    <Segmented aria_label="When the assistant wants to change something"
                        options=&[("ask", "Ask me first"), ("auto", "Auto — just do it")] value=auto />
                </div>
                <div style="font-size: var(--text-sm); font-weight: 600; margin-top: 6px">
                    "What it remembers about you "
                    {move || { let n = notes().len(); (n > 0).then(|| view! { <Tag>{n}</Tag> }) }}
                </div>
                <p class="card-meta" style="margin-top: 0px">
                    "Kept permanently in an encrypted file on your server (included in backups), even if you delete every chat."
                </p>
                {move || {
                    let n = notes();
                    if memory.loading.get() && memory.data.with(|d| d.as_ref().is_none_or(Option::is_none)) {
                        view! { <Spinner label="Loading memory" /> }.into_any()
                    } else if n.is_empty() {
                        view! { <p class="card-meta">"Nothing yet — it saves lasting facts and preferences as you chat."</p> }.into_any()
                    } else {
                        view! {
                            <div style="display: flex; flex-direction: column; max-height: 280px; overflow: auto">
                                {n.into_iter().rev().map(|note| view! {
                                    <div style="display: flex; gap: 10px; padding: 7px 2px; border-top: 1px solid color-mix(in srgb, var(--color-text) 7%, transparent); font-size: var(--text-sm)">
                                        <span style="flex: 1">{note.text.clone()}</span>
                                        <span style="color: var(--content-tertiary); font-size: var(--text-xs); white-space: nowrap">
                                            {fmt::locale_date(&note.at)}
                                        </span>
                                    </div>
                                }).collect_view()}
                            </div>
                        }.into_any()
                    }
                }}
            </Card>
        })
    }
}

/// `treeIconBtn` in SettingsPage.tsx.
const TREE_ICON_BTN: &str = "border: 0px; background: none; color: var(--content-tertiary); font: inherit; font-size: var(--text-md); line-height: 1; padding: 0px 2px";

/// Finance reviews: which slides the presenter shows, their order and how
/// it plays. Saved on this device.
#[component]
pub fn ReviewSection() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let prefs = Memo::new(move |_| app.with(|a| a.review_prefs.clone()));
    let update = {
        let host = host.clone();
        Callback::new(move |p: ReviewPrefs| host.store_fire("setReviewPrefs", &[HostCtx::arg(&p)]))
    };
    let patch = move |f: Box<dyn FnOnce(&mut ReviewPrefs)>| {
        let mut p = prefs.get_untracked();
        f(&mut p);
        update.run(p);
    };

    let period = bound_seg(
        move || {
            if prefs.with(|p| p.default_period == ReviewPeriod::Week) {
                "week"
            } else {
                "month"
            }
        },
        move |v| {
            patch(Box::new(move |p| {
                p.default_period = if v == "week" {
                    ReviewPeriod::Week
                } else {
                    ReviewPeriod::Month
                }
            }))
        },
    );
    let week = bound_seg(
        move || {
            if prefs.with(|p| p.week_starts_on == "sunday") {
                "sunday"
            } else {
                "monday"
            }
        },
        move |v| patch(Box::new(move |p| p.week_starts_on = v.to_string())),
    );
    let advance = RwSignal::new(String::new());
    Effect::new(move || advance.set(prefs.with(|p| p.auto_advance_seconds.to_string())));
    let advance_options = vec![
        SelectOption::new("0", "Off — I'll click through"),
        SelectOption::new("8", "Every 8 seconds"),
        SelectOption::new("15", "Every 15 seconds"),
        SelectOption::new("30", "Every 30 seconds"),
        SelectOption::new("60", "Every minute"),
    ];

    let slides = move || {
        let p = prefs.get();
        let last = p.slides.len().saturating_sub(1);
        p.slides
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let (title, hint) = s.id.label();
                let enabled = s.enabled;
                let toggle = move |_| {
                    patch(Box::new(move |p| {
                        if let Some(s) = p.slides.get_mut(i) {
                            s.enabled = !s.enabled;
                        }
                    }))
                };
                let mv = move |by: isize| {
                    let mut p = prefs.get_untracked();
                    if logic::move_item(&mut p.slides, i, by) {
                        update.run(p);
                    }
                };
                let btn = |off: bool| {
                    format!(
                        "{TREE_ICON_BTN}; opacity: {}; cursor: {}",
                        if off { "0.25" } else { "1" },
                        if off { "default" } else { "pointer" }
                    )
                };
                view! {
                    <div style=format!("display: flex; align-items: center; gap: 10px; padding: 7px 2px; border-top: 1px solid color-mix(in srgb, var(--color-text) 7%, transparent); opacity: {}", if enabled { "1" } else { "0.55" })>
                        <input type="checkbox" prop:checked=enabled on:change=toggle aria-label=format!("Show {title}") />
                        <div style="flex: 1; min-width: 0px">
                            <div style="font-size: var(--text-sm); font-weight: 500">{title}</div>
                            <div style="font-size: var(--text-xs); color: var(--content-tertiary)">{hint}</div>
                        </div>
                        <button title="Move up" disabled=i == 0 on:click=move |_| mv(-1) style=btn(i == 0)>"▲"</button>
                        <button title="Move down" disabled=i == last on:click=move |_| mv(1) style=btn(i == last)>"▼"</button>
                    </div>
                }
            })
            .collect_view()
    };

    view! {
        <Card kicker="Finance reviews" title="Weekly & monthly reviews">
            <p class="card-body">
                "Present a review from Reports. Pick what it shows and in what order — slides with nothing to show for a period (no budgets, no AI summary) are skipped."
            </p>
            <div style="display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-end">
                <div class="field">
                    <label>"Default review"</label>
                    <Segmented aria_label="Default review" options=&[("week", "Weekly"), ("month", "Monthly")] value=period />
                </div>
                <div class="field">
                    <label>"Weeks start on"</label>
                    <Segmented aria_label="Weeks start on" options=&[("monday", "Monday"), ("sunday", "Sunday")] value=week />
                </div>
                <Select label="Auto-advance" value=advance options=advance_options
                    on_change=Callback::new(move |v: String| {
                        let n = vault_core::auto_lock::js_number(&v);
                        patch(Box::new(move |p| p.auto_advance_seconds = n))
                    }) />
            </div>
            <label style="display: flex; gap: 8px; align-items: center; font-size: var(--text-sm)">
                <input type="checkbox" prop:checked=move || prefs.with(|p| p.compare)
                    on:change=move |e| { let c = event_target_checked(&e); patch(Box::new(move |p| p.compare = c)) } />
                "Compare with the previous week / month"
            </label>
            <label style="display: flex; gap: 8px; align-items: center; font-size: var(--text-sm)">
                <input type="checkbox" prop:checked=move || prefs.with(|p| p.start_fullscreen)
                    on:change=move |e| { let c = event_target_checked(&e); patch(Box::new(move |p| p.start_fullscreen = c)) } />
                "\"Present\" opens in full screen"
            </label>
            <div style="font-size: var(--text-sm); font-weight: 600; margin-top: 6px">"Slides"</div>
            <div style="display: flex; flex-direction: column">{slides}</div>
        </Card>
    }
}
