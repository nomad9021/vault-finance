//! `<TailscaleControl>` from apps/desktop/src/screens/TailscaleControl.tsx:
//! Tailscale on/off from inside the app. `compact` is the connect screen's
//! one-line strip; otherwise the full Settings control with "Turn off".

use leptos::prelude::*;
use leptos::task::spawn_local;
use vault_core::platform::PrivateNetworkId;
use vault_core::settings::{tailscale_describe, TailscaleActionResult};
use vault_core::startup_checks::TAILSCALE_DOWNLOAD_URL;

use super::{Button, Spinner};
use crate::host::use_host;
use crate::storage;

#[component]
pub fn TailscaleControl(#[prop(optional)] compact: bool) -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let busy = RwSignal::new(false);
    let message = RwSignal::new(None::<String>);

    let network =
        PrivateNetworkId::from_saved(storage::get(PrivateNetworkId::STORAGE_KEY).as_deref());
    let label = network.label();
    let supported = move || app.with(|s| s.tailscale_supported) && network.uses_tailscale_client();

    {
        let host = host.clone();
        if supported() {
            host.store_fire("refreshTailscale", &[]);
        }
    }

    // While waiting on a browser sign-in, keep polling until it connects.
    {
        let host = host.clone();
        Effect::new(move || {
            let waiting = app.with(|s| {
                s.tailscale
                    .as_ref()
                    .is_some_and(|t| t.state == "NeedsLogin" || t.state == "Starting")
            });
            if !waiting {
                return;
            }
            let host = host.clone();
            if let Ok(h) = set_interval_with_handle(
                move || host.store_fire("refreshTailscale", &[]),
                std::time::Duration::from_millis(3_000),
            ) {
                on_cleanup(move || h.clear());
            }
        });
    }

    let act = {
        let host = host.clone();
        move |action: &'static str| {
            let host = host.clone();
            busy.set(true);
            message.set(None);
            spawn_local(async move {
                match host
                    .store::<Option<TailscaleActionResult>>(action, &[])
                    .await
                {
                    Ok(Some(r)) if !r.ok => {
                        let _ = message.try_set(Some(
                            r.message.unwrap_or_else(|| "That didn't work.".into()),
                        ));
                    }
                    Ok(Some(r)) if r.status.auth_url.is_some() => {
                        let _ = message.try_set(Some(format!(
                            "Finish signing in to {label} in your browser."
                        )));
                    }
                    Ok(_) => {}
                    Err(e) => {
                        let _ = message.try_set(Some(e.message));
                    }
                }
                let _ = busy.try_set(false);
            });
        }
    };

    move || {
        let status = app.with(|s| s.tailscale.clone());
        let status = status.filter(|_| supported())?;
        if compact && (status.state == "Running" || status.state == "NotInstalled") {
            return None;
        }
        let (text, color) = tailscale_describe(&status, label);
        let running = status.state == "Running";
        let host = host.clone();
        let act = act.clone();
        let button = if status.state == "NotInstalled" {
            view! {
                <Button variant="secondary" on_click=move || host.open_external(TAILSCALE_DOWNLOAD_URL)>
                    "Get Tailscale"
                </Button>
            }
            .into_any()
        } else if running {
            (!compact)
                .then(|| view! {
                    <Button variant="ghost" on_click=move || act("turnOffTailscale") disabled=busy>
                        {move || if busy.get() { view! { <Spinner label="Turning off" /> }.into_any() } else { "Turn off".into_any() }}
                    </Button>
                })
                .into_any()
        } else if let Some(url) = status
            .auth_url
            .clone()
            .filter(|_| status.state == "NeedsLogin")
        {
            view! {
                <Button variant="primary" on_click=move || host.open_external(&url) disabled=busy>
                    "Open sign-in page"
                </Button>
            }
            .into_any()
        } else {
            let down = status.state == "DaemonDown";
            let word = if status.state == "NeedsLogin" {
                "Sign in"
            } else {
                "Turn on"
            };
            view! {
                <Button variant="primary" on_click=move || act("turnOnTailscale")
                    disabled=Signal::derive(move || busy.get() || down)>
                    {move || if busy.get() { view! { <Spinner label="Turning on" /> }.into_any() } else { word.into_any() }}
                </Button>
            }
            .into_any()
        };
        let outer = if compact {
            "display: grid; gap: 8px; margin-top: 16px; padding: 10px 12px; border-radius: var(--radius-md); border: 1px solid var(--color-divider); background: var(--color-bg)"
        } else {
            "display: grid; gap: 8px"
        };
        Some(view! {
            <div style=outer>
                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
                    <span aria-hidden="true" style=format!("width: 8px; height: 8px; border-radius: 50%; background: {color}; flex: none")></span>
                    <span style="font-size: var(--text-sm)">
                        <strong>{label}</strong>" — "{text}
                    </span>
                    <span style="margin-left: auto; display: flex; gap: 8px">{button}</span>
                </div>
                {status.dns_name.clone().filter(|d| !compact && running && !d.is_empty()).map(|d| view! {
                    <div class="card-meta">"This computer is "{d}" on your tailnet."</div>
                })}
                {status.health.first().filter(|h| !h.is_empty()).cloned().map(|h| view! { <div class="card-meta">{h}</div> })}
                {status.error.clone().filter(|e| status.state == "DaemonDown" && !e.is_empty()).map(|e| view! {
                    <div class="card-meta">{e}</div>
                })}
                {move || message.get().map(|m| view! {
                    <div role="status" style="font-size: var(--text-sm); color: var(--content-secondary)">{m}</div>
                })}
                {compact.then(|| view! {
                    <div class="card-meta" style="font-size: var(--text-xs)">
                        "Only needed if you're away from home and your server is on "{label}"."
                    </div>
                })}
            </div>
        })
    }
}
