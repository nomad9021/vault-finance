//! `UpdatesSection` (the desktop app's own updates) and
//! `ServerUpdateSection` (server version and in-app server updating).

use leptos::prelude::*;
use leptos::task::spawn_local;
use vault_core::updates::{AppUpdateState, SelfUpdateState, UpdateStatusResponse};

use wasm_bindgen::JsCast;

use crate::host::use_host;
use crate::ui::{Button, Card, Dialog, Spinner, Tag};

#[component]
pub fn UpdatesSection() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    // Same state as the header's update button — checking in one updates both.
    let state = Memo::new(move |_| app.with(|a| a.app_update.clone()));
    let tauri = Memo::new(move |_| app.with(|a| a.platform == "tauri"));
    let version = app.with_untracked(|a| a.app_version.clone());

    move || {
        // Browser dev mode has no updater — hide the card entirely.
        if !tauri.get() {
            return None;
        }
        let host = host.clone();
        let body = move || match state.get() {
            AppUpdateState::Available { version } => {
                let host = host.clone();
                view! {
                    <div style="display: flex; align-items: center; gap: 10px">
                        <Tag variant="accent">{format!("v{version} available")}</Tag>
                        <Button variant="primary" on_click=move || host.install_app_update()>
                            "Install & restart"
                        </Button>
                    </div>
                }
                .into_any()
            }
            AppUpdateState::Installing { progress, .. } => view! {
                <div style="display: flex; align-items: center; gap: 10px">
                    <Spinner label="Installing update" />
                    <span style="font-size: var(--text-sm)">
                        {format!("Downloading… {}%", vault_core::money::js_round(progress * 100.0))}
                    </span>
                </div>
            }
            .into_any(),
            other => {
                let host = host.clone();
                let checking = other == AppUpdateState::Checking;
                view! {
                    <div style="display: flex; align-items: center; gap: 10px">
                        <Button variant="secondary" disabled=checking on_click=move || host.check_app_update()>
                            {if checking {
                                view! { <Spinner label="Checking" /> }.into_any()
                            } else {
                                "Check for updates".into_any()
                            }}
                        </Button>
                        {match other {
                            AppUpdateState::None => Some(view! {
                                <span style="font-size: var(--text-sm); color: var(--content-tertiary)">
                                    "You're on the latest version."
                                </span>
                            }.into_any()),
                            AppUpdateState::Error { message, .. } => Some(view! {
                                <span role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">
                                    {message}
                                </span>
                            }.into_any()),
                            _ => None,
                        }}
                    </div>
                }
                .into_any()
            }
        };
        Some(view! {
            <Card kicker="Application" title=format!("Updates — v{version}")>
                <p class="card-body">
                    "Updates are downloaded from the project's GitHub releases and signature-checked before install — the only network request this app ever makes outside your own server. You can also update from the download button next to your avatar."
                </p>
                {body}
            </Card>
        })
    }
}

const CODE_STYLE: &str = "font-family: ui-monospace, monospace; background: var(--color-neutral-900); padding: 1px 6px; border-radius: 6px";

/// `new Date(iso).toLocaleString()`.
fn locale_date_time(iso: &str) -> String {
    let d = js_sys::Date::new(&iso.into());
    js_sys::Reflect::get(&d, &"toLocaleString".into())
        .ok()
        .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
        .and_then(|f| f.call0(&d).ok())
        .and_then(|s| s.as_string())
        .unwrap_or_default()
}

#[derive(Clone, Copy, PartialEq)]
enum Busy {
    Check,
    Start,
}

/// The owner can check now and, when the host has the update agent
/// (installers/server/enable-app-updates.sh), update the server from here;
/// we then poll until it comes back on the new version. Members only see
/// the card when an update is out.
#[component]
pub fn ServerUpdateSection() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let is_owner = Memo::new(move |_| app.with(|a| a.is_owner()));
    let status = RwSignal::new(None::<UpdateStatusResponse>);
    let busy = RwSignal::new(None::<Busy>);
    let error = RwSignal::new(None::<String>);
    let confirming = RwSignal::new(false);
    // Set while the server is down mid-update (requests fail until it's back).
    let restarting = RwSignal::new(false);
    let updated_to = RwSignal::new(None::<String>);
    let started_from = RwSignal::new(None::<String>);

    let load = {
        let host = host.clone();
        move || {
            let host = host.clone();
            spawn_local(async move {
                match host.call::<UpdateStatusResponse>("updateStatus", &[]).await {
                    Ok(next) => {
                        let from = started_from.try_get_untracked().flatten();
                        let finished = next.self_update.as_ref().is_some_and(|s| {
                            matches!(
                                s.state,
                                SelfUpdateState::Failed | SelfUpdateState::Succeeded
                            )
                        });
                        restarting.try_set(false);
                        if from.as_ref().is_some_and(|f| *f != next.current_version) {
                            updated_to.try_set(Some(next.current_version.clone()));
                            started_from.try_set(None);
                        } else if finished {
                            // Finished without a version change: show the agent's message.
                            started_from.try_set(None);
                        }
                        status.try_set(Some(next));
                    }
                    Err(_) => {
                        if started_from.try_get_untracked().flatten().is_some() {
                            restarting.try_set(true);
                        } else {
                            status.try_set(None);
                        }
                    }
                }
            });
        }
    };
    load();

    let self_update =
        Memo::new(move |_| status.with(|s| s.as_ref().and_then(|s| s.self_update.clone())));
    let in_progress = Memo::new(move |_| {
        restarting.get()
            || self_update.with(|s| {
                s.as_ref().is_some_and(|s| {
                    matches!(
                        s.state,
                        SelfUpdateState::Requested | SelfUpdateState::Running
                    )
                })
            })
            || started_from.with(|s| s.is_some())
    });

    // Poll every 3 s while an update is under way.
    let timer = StoredValue::new(None::<IntervalHandle>);
    Effect::new({
        let load = load.clone();
        move || {
            if let Some(t) = timer.get_value() {
                t.clear();
                timer.set_value(None);
            }
            if in_progress.get() {
                let load = load.clone();
                timer.set_value(
                    set_interval_with_handle(load, std::time::Duration::from_millis(3000)).ok(),
                );
            }
        }
    });
    on_cleanup(move || {
        if let Some(t) = timer.try_get_value().flatten() {
            t.clear();
        }
    });

    let check_now = {
        let host = host.clone();
        move || {
            let host = host.clone();
            busy.set(Some(Busy::Check));
            error.set(None);
            spawn_local(async move {
                match host
                    .try_call::<UpdateStatusResponse>("checkServerUpdate", &[])
                    .await
                {
                    Ok(s) => {
                        status.try_set(Some(s));
                    }
                    Err(e) => {
                        error.try_set(Some(if e.is_api_request() {
                            e.message
                        } else {
                            "Couldn't check for updates.".into()
                        }));
                    }
                }
                busy.try_set(None);
            });
        }
    };

    let start = {
        let host = host.clone();
        move || {
            let host = host.clone();
            confirming.set(false);
            busy.set(Some(Busy::Start));
            error.set(None);
            updated_to.set(None);
            let current = status.with_untracked(|s| s.as_ref().map(|s| s.current_version.clone()));
            spawn_local(async move {
                match host
                    .try_call::<UpdateStatusResponse>("startServerUpdate", &[])
                    .await
                {
                    Ok(s) => {
                        status.try_set(Some(s));
                        started_from.try_set(current);
                    }
                    Err(e) => {
                        error.try_set(Some(if e.is_api_request() {
                            e.message
                        } else {
                            "Couldn't start the update.".into()
                        }));
                    }
                }
                busy.try_set(None);
            });
        }
    };

    move || {
        let s = status.get()?;
        let owner = is_owner.get();
        if !owner && !s.update_available {
            return None;
        }
        let latest = s.latest_version.clone().unwrap_or_default();
        let current = s.current_version.clone();

        let summary = {
            let (latest, current) = (latest.clone(), current.clone());
            let checked_at = s.checked_at.clone();
            let available = s.update_available;
            move || {
                if let Some(v) = updated_to.get() {
                    view! {
                        <p class="card-body">
                            <Tag variant="positive">"Updated"</Tag>" Your server is now on "<strong>{format!("v{v}")}</strong>"."
                        </p>
                    }
                    .into_any()
                } else if available {
                    view! {
                        <p class="card-body">
                            <strong>{format!("v{latest}")}</strong>" has been released. Your server is running "
                            <strong>{format!("v{current}")}</strong>"."
                        </p>
                    }
                    .into_any()
                } else {
                    let checked = checked_at
                        .as_deref()
                        .filter(|c| !c.is_empty())
                        .map(|c| format!(" (checked {})", locale_date_time(c)))
                        .unwrap_or_default();
                    view! {
                        <p class="card-body">{format!("Your server is on the latest version{checked}.")}</p>
                    }
                    .into_any()
                }
            }
        };

        let controls = {
            let latest = latest.clone();
            let check_now = check_now.clone();
            let available = s.update_available;
            let operator_managed = s.operator_managed;
            move || {
                if in_progress.get() {
                    let progress_text = if restarting.get() {
                        "The server is restarting on the new version…".to_string()
                    } else {
                        self_update.with(|su| match su {
                            Some(su) if su.state == SelfUpdateState::Requested => {
                                "Waiting for the server to start the update…".to_string()
                            }
                            Some(su) => su.message.clone().unwrap_or_else(|| "Updating…".into()),
                            None => "Updating…".into(),
                        })
                    };
                    return view! {
                        <div style="display: flex; align-items: center; gap: 10px">
                            <Spinner label="Updating server" />
                            <span style="font-size: var(--text-sm)">{progress_text}</span>
                        </div>
                    }
                    .into_any();
                }
                if operator_managed {
                    return view! {
                        <p class="card-body">"This server is managed by an administrator — they'll roll out the update."</p>
                    }
                    .into_any();
                }
                if !owner {
                    return view! {
                        <p class="card-body">"The household owner can install it from their Settings."</p>
                    }
                    .into_any();
                }
                let su = self_update.get();
                let failed_message = su
                    .as_ref()
                    .filter(|s| s.state == SelfUpdateState::Failed)
                    .and_then(|s| s.message.clone())
                    .filter(|m| !m.is_empty());
                let failed = su
                    .as_ref()
                    .is_some_and(|s| s.state == SelfUpdateState::Failed);
                let has_agent = su.is_some();
                let latest = latest.clone();
                let check_now = check_now.clone();
                let disabled = Signal::derive(move || busy.get().is_some());
                view! {
                    {failed_message.map(|m| view! {
                        <p role="alert" class="card-body" style="color: var(--color-negative)">{m}</p>
                    })}
                    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
                        {(available && has_agent).then(|| {
                            let latest = latest.clone();
                            view! {
                                <Button variant="primary" disabled=disabled on_click=move || confirming.set(true)>
                                    {move || if busy.get() == Some(Busy::Start) {
                                        view! { <Spinner label="Starting" /> }.into_any()
                                    } else if failed {
                                        "Try again".into_any()
                                    } else {
                                        format!("Update server to v{latest}").into_any()
                                    }}
                                </Button>
                            }
                        })}
                        <Button variant="secondary" disabled=disabled on_click=check_now>
                            {move || if busy.get() == Some(Busy::Check) {
                                view! { <Spinner label="Checking" /> }.into_any()
                            } else {
                                "Check now".into_any()
                            }}
                        </Button>
                    </div>
                    {(available && !has_agent).then(|| view! {
                        <p class="card-body">
                            "To update, run "<code style=CODE_STYLE>"vault-update"</code>
                            " on the machine hosting your server. To update from here instead, run "
                            <code style=CODE_STYLE>"installers/server/enable-app-updates.sh"</code>" there once."
                        </p>
                    })}
                }
                .into_any()
            }
        };

        let notes = s
            .notes_url
            .clone()
            .filter(|n| !n.is_empty() && s.update_available)
            .map(|n| {
                view! {
                    <p class="card-meta">"Release notes: "<span style="user-select: all">{n}</span></p>
                }
            });
        let start = start.clone();
        let confirm_title = format!("Update the server to v{latest}?");
        Some(view! {
            <Card kicker="Server" title=format!("Server update — v{current}")>
                {summary}
                {controls}
                {move || error.get().map(|e| view! {
                    <p role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</p>
                })}
                {notes}
                {move || confirming.get().then(|| {
                    let start = start.clone();
                    view! {
                        <Dialog title=confirm_title.clone() on_close=move || confirming.set(false)
                            actions=ToChildren::to_children(move || {
                                let start = start.clone();
                                view! {
                                    <Button variant="secondary" on_click=move || confirming.set(false)>"Cancel"</Button>
                                    <Button variant="primary" on_click=move || start()>"Update server"</Button>
                                }
                            })>
                            "The server downloads the new version and restarts, which usually takes a minute or two. Everyone using Vault Finance is disconnected briefly and reconnects on their own. Your data isn't touched."
                        </Dialog>
                    }
                })}
            </Card>
        })
    }
}
