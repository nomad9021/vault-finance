//! Settings, part B: the Security tab (auto-lock, biometrics, password,
//! two-factor, approved devices, sessions) and the Connection tab's server
//! card with its second address.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::auth::{
    ChangePasswordRequest, DeviceApprovalSettings, DeviceKey, DeviceKeyListResponse, DeviceSession,
    PendingApproval, PendingApprovalListResponse, SessionListResponse, TotpSetupResponse,
    TotpStatusResponse, TrustedDevice, TrustedDeviceListResponse,
};
use vault_core::settings::{
    self as logic, BiometricResult, SaveAlternateResult, AUTO_LOCK_CHOICES,
};
use wasm_bindgen::JsValue;

use super::{alert, dot, spinner_or, Data, ALERT, ALERT_MT8};
use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{ApproveDialog, Button, Card, Dialog, Field, Select, SelectOption, Spinner, Tag};

fn platform_name(p: vault_core::common::Platform) -> &'static str {
    use vault_core::common::Platform::*;
    match p {
        Windows => "windows",
        Macos => "macos",
        Linux => "linux",
        Ios => "ios",
    }
}

/// When this device locks itself.
#[component]
pub fn AutoLockSection() -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let minutes = RwSignal::new(String::new());
    Effect::new(move || minutes.set(app.with(|a| a.auto_lock_minutes.to_string())));
    let mut options: Vec<SelectOption> = AUTO_LOCK_CHOICES
        .iter()
        .map(|m| {
            SelectOption::new(
                m.to_string(),
                format!("{m} minute{}", if *m > 1 { "s" } else { "" }),
            )
        })
        .collect();
    options.push(SelectOption::new(
        "0",
        "Never (still locks on sleep, screen lock and restart)",
    ));
    let set = {
        let host = host.clone();
        Callback::new(move |v: String| {
            host.store_fire(
                "setAutoLockMinutes",
                &[JsValue::from_f64(vault_core::auto_lock::js_number(&v))],
            )
        })
    };
    view! {
        <Card kicker="Security" title="Auto-lock">
            <p class="card-body">
                "Vault Finance locks every time it opens, when this computer sleeps or its screen locks, and after you've been away for the time below. Closing the window quits the app completely."
            </p>
            <Select label="Lock after I've been idle for" value=minutes options=options on_change=set />
            <div>
                <Button variant="secondary" icon="lock" on_click=move || host.store_fire("lock", &[])>
                    "Lock now (Ctrl+L)"
                </Button>
            </div>
        </Card>
    }
}

/// Windows Hello / Touch ID / fingerprint sign-in for this device.
#[component]
pub fn BiometricSection() -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let keys = RwSignal::new(None::<Vec<DeviceKey>>);
    let this_key = RwSignal::new(None::<String>);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let revoking = RwSignal::new(None::<DeviceKey>);

    let enrolled = Memo::new(move |_| app.with(|a| a.biometric_enrolled()));
    let label = Memo::new(move |_| app.with(|a| a.biometric_label()));

    let reload = {
        let host = host.clone();
        Callback::new(move |()| {
            let h = host.clone();
            spawn_local(async move {
                let k = h
                    .call::<DeviceKeyListResponse>("deviceKeys", &[])
                    .await
                    .map(|r| r.keys)
                    .unwrap_or_default();
                let _ = keys.try_set(Some(k));
            });
            let host = host.clone();
            let has = app
                .try_with_untracked(|a| a.server_address.is_some() && a.user_id.is_some())
                .unwrap_or(false);
            if has {
                spawn_local(async move {
                    let id = host.this_device_key_id().await;
                    let _ = this_key.try_set(id);
                });
            }
        })
    };
    // useEffect(reload, [reload, enrolled])
    Effect::new(move || {
        enrolled.track();
        reload.run(());
    });

    let turn_on = {
        let host = host.clone();
        move || {
            busy.set(true);
            error.set(None);
            let host = host.clone();
            spawn_local(async move {
                match host.store::<BiometricResult>("enableBiometric", &[]).await {
                    Ok(r) => {
                        if let Some(e) = r.error(&label.get_untracked()) {
                            let _ = error.try_set(Some(e));
                        }
                    }
                    Err(_) => {
                        let _ = error.try_set(Some("Couldn't reach the server.".into()));
                    }
                }
                let _ = busy.try_set(false);
                reload.run(());
            });
        }
    };
    let turn_off = {
        let host = host.clone();
        move || {
            busy.set(true);
            error.set(None);
            let host = host.clone();
            spawn_local(async move {
                let _ = host.store::<IgnoredAny>("disableBiometric", &[]).await;
                let _ = busy.try_set(false);
                reload.run(());
            });
        }
    };
    let revoke = {
        let host = host.clone();
        Callback::new(move |key: DeviceKey| {
            let host = host.clone();
            spawn_local(async move {
                if Some(&key.id) == this_key.get_untracked().as_ref() {
                    let _ = host.store::<IgnoredAny>("disableBiometric", &[]).await;
                } else {
                    let _ = host
                        .call::<IgnoredAny>("revokeDeviceKey", &[JsValue::from_str(&key.id)])
                        .await;
                }
                let _ = revoking.try_set(None);
                reload.run(());
            });
        })
    };

    let biometric = move || app.with(|a| a.biometric.clone());
    let others = move || {
        let mine = this_key.get();
        keys.get()
            .unwrap_or_default()
            .into_iter()
            .filter(|k| Some(&k.id) != mine.as_ref())
            .collect::<Vec<_>>()
    };

    let title = Signal::derive(move || format!("Sign in with {}", label.get()));
    let how = move || match label.get().as_str() {
        "Windows Hello" => "Windows Hello — your face, fingerprint or PIN",
        "Touch ID" => "Touch ID",
        _ => "your fingerprint reader",
    };

    view! {
        <Card kicker="Security" title=title>
            <p class="card-body">
                "Unlock Vault Finance on this computer with "{how}" instead of typing your password. The app asks for it every time it opens. Your biometric data never leaves this device — the server only sees a sign-in key it can revoke."
            </p>
            <div style="display: flex; align-items: center; gap: 10px">
                {move || dot(if enrolled.get() { "var(--color-positive)" } else { "var(--color-neutral-600)" })}
                <span style="font-size: var(--text-sm)">
                    {move || if enrolled.get() {
                        "On for this device"
                    } else if biometric().is_some_and(|b| !b.available) {
                        "Not available on this device"
                    } else {
                        "Off"
                    }}
                </span>
                <div style="margin-left: auto">
                    {move || {
                        let turn_on = turn_on.clone();
                        let turn_off = turn_off.clone();
                        if enrolled.get() {
                            view! { <Button variant="ghost" on_click=turn_off disabled=busy>"Turn off"</Button> }.into_any()
                        } else {
                            let icon = if label.get() == "Windows Hello" { "user" } else { "fingerprint" };
                            view! {
                                <Button variant="primary" icon=icon on_click=turn_on
                                    disabled=Signal::derive(move || busy.get() || !biometric().is_some_and(|b| b.available))>
                                    {spinner_or(busy.into(), "Waiting", "Turn on")}
                                </Button>
                            }.into_any()
                        }
                    }}
                </div>
            </div>
            {move || biometric().filter(|b| !b.available).and_then(|b| b.reason).filter(|r| !r.is_empty())
                .map(|r| view! { <p class="card-meta">{r}</p> })}
            {
                let host = host.clone();
                move || (busy.get() && label.get() == "Fingerprint").then(|| {
                    let host = host.clone();
                    view! {
                        <div class="row card-meta" style="gap: 8px">
                            "Touch the fingerprint reader…"
                            <Button variant="ghost" on_click=move || host.biometric_cancel()>"Cancel"</Button>
                        </div>
                    }
                })
            }
            {alert(error.into(), ALERT_MT8)}
            {move || {
                let list = others();
                (!list.is_empty()).then(|| view! {
                    <div class="eyebrow" style="margin-top: 16px; margin-bottom: 4px">
                        "Other devices that can sign in as you with biometrics"
                    </div>
                    <table class="table">
                        <tbody>
                            {list.into_iter().map(|k| {
                                let used = k.last_used_at.as_deref()
                                    .map(|t| format!("Last used {}", fmt::locale_date(t)))
                                    .unwrap_or_else(|| "Never used".into());
                                let name = k.device_name.clone();
                                let platform = platform_name(k.platform);
                                view! {
                                    <tr>
                                        <td>{name}</td>
                                        <td style="text-transform: capitalize">{platform}</td>
                                        <td>{used}</td>
                                        <td style="text-align: right">
                                            <Button variant="ghost" on_click=move || revoking.set(Some(k.clone()))>"Revoke"</Button>
                                        </td>
                                    </tr>
                                }
                            }).collect_view()}
                        </tbody>
                    </table>
                })
            }}
            {move || revoking.get().map(|k| {
                let name = k.device_name.clone();
                view! {
                    <Dialog title="Revoke biometric sign-in?" on_close=move |()| revoking.set(None)
                        actions=ToChildren::to_children(move || {
                            let k = k.clone();
                            view! {
                                <Button variant="secondary" on_click=move || revoking.set(None)>"Cancel"</Button>
                                <Button variant="primary" on_click=move || revoke.run(k.clone())>"Revoke"</Button>
                            }
                        })>
                        "“"{name.clone()}"” will need your password next time. It stays signed in until then — revoke its session below too if it's lost."
                    </Dialog>
                }
            })}
        </Card>
    }
}

#[component]
pub fn PasswordSection() -> impl IntoView {
    let host = use_host();
    let open = RwSignal::new(false);
    let current = RwSignal::new(String::new());
    let next = RwSignal::new(String::new());
    let confirm = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let done = RwSignal::new(false);

    let problem = Signal::derive(move || {
        let n = next.get();
        if n.is_empty() {
            None
        } else {
            vault_core::password::password_problem(&n)
        }
    });
    let mismatch = Signal::derive(move || {
        let c = confirm.get();
        (!c.is_empty() && c != next.get()).then(|| "The passwords don't match.".to_string())
    });
    let close = move || {
        open.set(false);
        current.set(String::new());
        next.set(String::new());
        confirm.set(String::new());
        error.set(None);
    };
    let save = move || {
        busy.set(true);
        error.set(None);
        let body = ChangePasswordRequest {
            current_password: current.get_untracked(),
            new_password: next.get_untracked(),
        };
        let host = host.clone();
        spawn_local(async move {
            match host
                .try_call::<IgnoredAny>("changePassword", &[HostCtx::arg(&body)])
                .await
            {
                Ok(_) => {
                    close();
                    let _ = done.try_set(true);
                }
                Err(e) => {
                    let _ = error.try_set(Some(
                        if e.is_api_request() && e.code.as_deref() == Some("INVALID_CREDENTIALS") {
                            "Your current password isn't right.".into()
                        } else if e.is_api_request() {
                            e.message
                        } else {
                            "Couldn't change your password. Is the server reachable?".into()
                        },
                    ));
                }
            }
            let _ = busy.try_set(false);
        });
    };

    view! {
        <Card kicker="Security" title="Password">
            <p class="card-body">
                "Changing your password signs out every other device and turns off their biometric sign-in, so anyone who knew the old one is locked out."
            </p>
            <div style="display: flex; align-items: center; gap: 10px">
                {move || done.get().then(|| view! {
                    <span role="status" style="font-size: var(--text-sm); color: var(--color-positive)">
                        "Password changed. Other devices were signed out."
                    </span>
                })}
                <div style="margin-left: auto">
                    <Button variant="secondary" on_click=move || { done.set(false); open.set(true); }>"Change password"</Button>
                </div>
            </div>
            {move || open.get().then(|| {
                let save = save.clone();
                view! {
                    <Dialog title="Change password" on_close=move |()| close()
                        actions=ToChildren::to_children(move || {
                            let save = save.clone();
                            view! {
                                <Button variant="secondary" on_click=close disabled=busy>"Cancel"</Button>
                                <Button variant="primary" on_click=save
                                    disabled=Signal::derive(move || busy.get() || current.get().is_empty() || next.get().is_empty()
                                        || problem.get().is_some() || confirm.get() != next.get())>
                                    {spinner_or(busy.into(), "Saving", "Change password")}
                                </Button>
                            }
                        })>
                        <div style="display: flex; flex-direction: column; gap: 12px">
                            <Field label="Current password" input_type="password" value=current
                                autocomplete="current-password" autofocus=true />
                            <Field label="New password" input_type="password" value=next
                                autocomplete="new-password" error=problem />
                            <Field label="Confirm new password" input_type="password" value=confirm
                                autocomplete="new-password" error=mismatch />
                            {alert(error.into(), ALERT)}
                        </div>
                    </Dialog>
                }
            })}
        </Card>
    }
}

#[component]
pub fn TwoFactorSection() -> impl IntoView {
    let host = use_host();
    let status = {
        let host = host.clone();
        Data::new(move || {
            let host = host.clone();
            async move { host.call::<TotpStatusResponse>("totpStatus", &[]).await }
        })
    };
    let enabled = move || status.data.with(|d| d.as_ref().is_some_and(|d| d.enabled));
    let setup = RwSignal::new(None::<TotpSetupResponse>);
    let code = RwSignal::new(String::new());
    let disabling = RwSignal::new(false);
    let password = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let start_setup = {
        let host = host.clone();
        move || {
            busy.set(true);
            error.set(None);
            code.set(String::new());
            let host = host.clone();
            spawn_local(async move {
                match host.call::<TotpSetupResponse>("totpSetup", &[]).await {
                    Ok(s) => {
                        let _ = setup.try_set(Some(s));
                    }
                    Err(_) => {
                        let _ = error.try_set(Some(
                            "Couldn't start setup. Is the server reachable?".into(),
                        ));
                    }
                }
                let _ = busy.try_set(false);
            });
        }
    };
    let confirm_enable = {
        let host = host.clone();
        move || {
            busy.set(true);
            error.set(None);
            let c = logic::strip_whitespace(&code.get_untracked());
            let host = host.clone();
            spawn_local(async move {
                match host
                    .call::<IgnoredAny>("totpEnable", &[JsValue::from_str(&c)])
                    .await
                {
                    Ok(_) => {
                        let _ = setup.try_set(None);
                        status.reload();
                    }
                    Err(_) => {
                        let _ = error.try_set(Some(
                            "That code isn't valid — enter the current one.".into(),
                        ));
                    }
                }
                let _ = busy.try_set(false);
            });
        }
    };
    let confirm_disable = {
        let host = host.clone();
        move || {
            busy.set(true);
            error.set(None);
            let p = password.get_untracked();
            let host = host.clone();
            spawn_local(async move {
                match host
                    .call::<IgnoredAny>("totpDisable", &[JsValue::from_str(&p)])
                    .await
                {
                    Ok(_) => {
                        let _ = disabling.try_set(false);
                        let _ = password.try_set(String::new());
                        status.reload();
                    }
                    Err(_) => {
                        let _ = error.try_set(Some("That password isn't right.".into()));
                    }
                }
                let _ = busy.try_set(false);
            });
        }
    };

    view! {
        <Card kicker="Security" title="Two-factor authentication">
            <p class="card-body">
                "Add a second step at sign-in: a rotating 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password…), on top of your password."
            </p>
            <div style="display: flex; align-items: center; gap: 10px">
                {move || dot(if enabled() { "var(--color-positive)" } else { "var(--color-neutral-600)" })}
                <span style="font-size: var(--text-sm)">{move || if enabled() { "On — a code is required to sign in" } else { "Off" }}</span>
                <div style="margin-left: auto">
                    {move || {
                        let start_setup = start_setup.clone();
                        if enabled() {
                            view! {
                                <Button variant="ghost" on_click=move || { disabling.set(true); error.set(None); password.set(String::new()); }>
                                    "Turn off"
                                </Button>
                            }.into_any()
                        } else {
                            view! {
                                <Button variant="primary" on_click=start_setup disabled=busy>
                                    {spinner_or(busy.into(), "Starting", "Set up")}
                                </Button>
                            }.into_any()
                        }
                    }}
                </div>
            </div>
            {alert(Signal::derive(move || error.get().filter(|_| setup.with(Option::is_none) && !disabling.get())), ALERT_MT8)}

            {move || setup.get().map(|s| {
                let confirm_enable = confirm_enable.clone();
                let grouped = logic::group_secret(&s.secret);
                view! {
                    <Dialog title="Set up two-factor authentication" on_close=move |()| setup.set(None)
                        actions=ToChildren::to_children(move || {
                            let confirm_enable = confirm_enable.clone();
                            view! {
                                <Button variant="secondary" on_click=move || setup.set(None) disabled=busy>"Cancel"</Button>
                                <Button variant="primary" on_click=confirm_enable
                                    disabled=Signal::derive(move || busy.get() || code.get().chars().count() < 6)>
                                    {spinner_or(busy.into(), "Enabling", "Turn on")}
                                </Button>
                            }
                        })>
                        <div style="display: flex; flex-direction: column; gap: 12px">
                            <p class="card-body" style="margin: 0px">
                                "In your authenticator app, add an account by entering this key manually (or paste the setup link), then type the current 6-digit code below."
                            </p>
                            <div>
                                <div class="eyebrow" style="margin-bottom: 4px">"Setup key"</div>
                                <div style="font-family: ui-monospace, monospace; font-size: var(--text-md); letter-spacing: 0.08em; padding: 10px 12px; border-radius: var(--radius-md); background: var(--color-neutral-900); border: 1px solid var(--color-divider); user-select: all; word-break: break-all">
                                    {grouped.clone()}
                                </div>
                            </div>
                            <details>
                                <summary style="font-size: var(--text-xs); color: var(--content-tertiary); cursor: pointer">
                                    "Setup link (for apps that accept a pasted otpauth URI)"
                                </summary>
                                <div style="font-family: ui-monospace, monospace; font-size: var(--text-2xs); word-break: break-all; margin-top: 6px; user-select: all; color: var(--content-tertiary)">
                                    {s.otpauth_uri.clone()}
                                </div>
                            </details>
                            <Field label="6-digit code" value=code filter=logic::digits_only input_mode="numeric"
                                max_length=7 autofocus=true placeholder="123456" />
                            {alert(error.into(), ALERT)}
                        </div>
                    </Dialog>
                }
            })}

            {move || disabling.get().then(|| {
                let confirm_disable = confirm_disable.clone();
                view! {
                    <Dialog title="Turn off two-factor?" on_close=move |()| disabling.set(false)
                        actions=ToChildren::to_children(move || {
                            let confirm_disable = confirm_disable.clone();
                            view! {
                                <Button variant="secondary" on_click=move || disabling.set(false) disabled=busy>"Cancel"</Button>
                                <Button variant="primary" on_click=confirm_disable
                                    disabled=Signal::derive(move || busy.get() || password.get().is_empty())
                                    style="background: var(--color-negative); border-color: var(--color-negative); color: #fff">
                                    {spinner_or(busy.into(), "Disabling", "Turn off")}
                                </Button>
                            }
                        })>
                        <div style="display: flex; flex-direction: column; gap: 12px">
                            <p class="card-body" style="margin: 0px">
                                "Enter your account password to disable two-factor authentication."
                            </p>
                            <Field label="Password" input_type="password" value=password autofocus=true />
                            {alert(error.into(), ALERT)}
                        </div>
                    </Dialog>
                }
            })}
        </Card>
    }
}

/// Settings → Approved devices (ADR-0009).
#[component]
pub fn TrustedDevicesSection() -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let is_owner = move || app.with(|a| a.is_owner());
    let devices = RwSignal::new(None::<Vec<TrustedDevice>>);
    let pending = RwSignal::new(Vec::<PendingApproval>::new());
    let methods = RwSignal::new(None::<DeviceApprovalSettings>);
    let reviewing = RwSignal::new(None::<PendingApproval>);
    let revoking = RwSignal::new(None::<TrustedDevice>);
    let error = RwSignal::new(None::<String>);

    let reload = {
        let host = host.clone();
        Callback::new(move |()| {
            let h = host.clone();
            spawn_local(async move {
                let d = h
                    .call::<TrustedDeviceListResponse>("trustedDevices", &[])
                    .await;
                let _ = devices.try_set(Some(d.map(|r| r.devices).unwrap_or_default()));
            });
            let h = host.clone();
            spawn_local(async move {
                let p = h
                    .call::<PendingApprovalListResponse>("pendingApprovals", &[])
                    .await;
                let _ = pending.try_set(p.map(|r| r.approvals).unwrap_or_default());
            });
            let h = host.clone();
            spawn_local(async move {
                let m = h
                    .call::<DeviceApprovalSettings>("deviceApprovalSettings", &[])
                    .await;
                let _ = methods.try_set(m.ok());
            });
        })
    };
    reload.run(());

    let save_methods = {
        let host = host.clone();
        Callback::new(move |next: DeviceApprovalSettings| {
            error.set(None);
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<DeviceApprovalSettings>(
                        "updateDeviceApprovalSettings",
                        &[HostCtx::arg(&next)],
                    )
                    .await
                {
                    Ok(m) => {
                        let _ = methods.try_set(Some(m));
                    }
                    Err(e) => {
                        let _ = error.try_set(Some(e.message_or("Couldn't save.")));
                    }
                }
            });
        })
    };

    let revoke = {
        let host = host.clone();
        Callback::new(move |d: TrustedDevice| {
            let host = host.clone();
            spawn_local(async move {
                let _ = host
                    .call::<IgnoredAny>("revokeTrustedDevice", &[JsValue::from_str(&d.id)])
                    .await;
                let _ = revoking.try_set(None);
                if d.current {
                    let _ = host.store::<IgnoredAny>("signOut", &[]).await;
                } else {
                    reload.run(());
                }
            });
        })
    };

    let device_ok = move || methods.with(|m| m.is_none_or(|m| m.trusted_device));

    view! {
        <Card kicker="Security" title="Approved devices">
            <p class="card-body">
                "A password alone isn't enough to sign in: each new device has to be approved first —"
                {move || logic::approval_methods_sentence(methods.get().as_ref())}
            </p>
            {move || {
                let list = pending.get();
                (!list.is_empty()).then(|| view! {
                    <div style="display: grid; gap: 6px; margin-bottom: 12px">
                        <div style="font-weight: 600; font-size: var(--text-sm)">"Waiting for approval"</div>
                        {list.into_iter().map(|p| {
                            let text = crate::ui::describe_request(&p);
                            view! {
                                <div style="display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius-md); background: var(--color-warning-soft)">
                                    <span style="font-size: var(--text-sm); flex: 1">{text}</span>
                                    {device_ok().then(|| view! {
                                        <Button variant="primary" on_click=move || reviewing.set(Some(p.clone()))>"Review"</Button>
                                    })}
                                </div>
                            }
                        }).collect_view()}
                    </div>
                })
            }}
            {move || match devices.get() {
                None => view! { <Spinner label="Loading devices" /> }.into_any(),
                Some(list) => {
                    let owner = is_owner();
                    view! {
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>"Device"</th>
                                    {owner.then(|| view! { <th>"Person"</th> })}
                                    <th>"Approved"</th>
                                    <th>"Last seen"</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {list.into_iter().map(|d| {
                                    let approved = d.approved_at.as_deref().map(fmt::locale_date).unwrap_or_else(|| "—".into());
                                    let seen = d.last_seen_at.as_deref().map(fmt::locale_string).unwrap_or_else(|| "—".into());
                                    let via = d.approved_via.map(|v| v.label());
                                    let name = d.device_name.clone();
                                    let person = d.user_display_name.clone();
                                    let current = d.current;
                                    view! {
                                        <tr>
                                            <td>
                                                {name}" "
                                                {current.then(|| view! { <Tag variant="accent" style="margin-left: 6px">"this device"</Tag> })}
                                            </td>
                                            {owner.then(|| view! { <td>{person}</td> })}
                                            <td title=via>{approved}</td>
                                            <td>{seen}</td>
                                            <td style="text-align: right">
                                                <Button variant="ghost" on_click=move || revoking.set(Some(d.clone()))>"Remove"</Button>
                                            </td>
                                        </tr>
                                    }
                                }).collect_view()}
                            </tbody>
                        </table>
                    }.into_any()
                }
            }}
            {move || {
                let m = methods.get().filter(|_| is_owner())?;
                Some(view! {
                    <div style="margin-top: 14px; display: grid; gap: 6px">
                        <div style="font-weight: 600; font-size: var(--text-sm)">"How new devices can be approved"</div>
                        <label class="radio" style="font-size: var(--text-sm)">
                            <input type="checkbox" prop:checked=m.trusted_device
                                on:change=move |e| save_methods.run(DeviceApprovalSettings { trusted_device: event_target_checked(&e), ..m }) />
                            <span class="dot" style="border-radius: var(--radius-sm)"></span>
                            "From a device that's already approved (type the code shown on the new device)"
                        </label>
                        <label class="radio" style="font-size: var(--text-sm)">
                            <input type="checkbox" prop:checked=m.server_console
                                on:change=move |e| save_methods.run(DeviceApprovalSettings { server_console: event_target_checked(&e), ..m }) />
                            <span class="dot" style="border-radius: var(--radius-sm)"></span>
                            "On the server console (docker compose exec server vault approve <code>)"
                        </label>
                        {alert(error.into(), ALERT)}
                    </div>
                })
            }}
            <ApproveDialog request=reviewing on_done=move |_| { reviewing.set(None); reload.run(()); } />
            {move || revoking.get().map(|d| {
                let title = if d.current { "Remove this device?" } else { "Remove this device's approval?" };
                let body = if d.current {
                    "You'll be signed out here, and this device will need to be approved again to sign back in.".to_string()
                } else {
                    format!("{} will be signed out and must be approved again before it can sign in.", d.device_name)
                };
                view! {
                    <Dialog title=title on_close=move |()| revoking.set(None)
                        actions=ToChildren::to_children(move || {
                            let d = d.clone();
                            view! {
                                <Button variant="secondary" on_click=move || revoking.set(None)>"Cancel"</Button>
                                <Button variant="primary" on_click=move || revoke.run(d.clone())>"Remove"</Button>
                            }
                        })>
                        {body.clone()}
                    </Dialog>
                }
            })}
        </Card>
    }
}

#[component]
pub fn SessionsSection() -> impl IntoView {
    let host = use_host();
    let sessions = RwSignal::new(None::<Vec<DeviceSession>>);
    let confirming = RwSignal::new(None::<DeviceSession>);
    let reload = {
        let host = host.clone();
        Callback::new(move |()| {
            let host = host.clone();
            spawn_local(async move {
                let s = host.call::<SessionListResponse>("sessions", &[]).await;
                let _ = sessions.try_set(Some(s.map(|r| r.sessions).unwrap_or_default()));
            });
        })
    };
    reload.run(());
    let revoke = Callback::new(move |s: DeviceSession| {
        let host = host.clone();
        spawn_local(async move {
            let _ = host
                .call::<IgnoredAny>("revokeSession", &[JsValue::from_str(&s.id)])
                .await;
            let _ = confirming.try_set(None);
            reload.run(());
        });
    });

    view! {
        <Card kicker="Security" title="Devices signed in to your account">
            {move || match sessions.get() {
                None => view! { <Spinner label="Loading sessions" /> }.into_any(),
                Some(list) => view! {
                    <table class="table">
                        <thead>
                            <tr><th>"Device"</th><th>"Platform"</th><th>"Last used"</th><th></th></tr>
                        </thead>
                        <tbody>
                            {list.into_iter().map(|s| {
                                let name = s.device_name.clone();
                                let used = fmt::locale_string(&s.last_used_at);
                                let current = s.is_current;
                                let platform = platform_name(s.platform);
                                view! {
                                    <tr>
                                        <td>
                                            {name}" "
                                            {current.then(|| view! { <Tag variant="accent" style="margin-left: 6px">"this device"</Tag> })}
                                        </td>
                                        <td style="text-transform: capitalize">{platform}</td>
                                        <td>{used}</td>
                                        <td style="text-align: right">
                                            {(!current).then(|| view! {
                                                <Button variant="ghost" on_click=move || confirming.set(Some(s.clone()))>"Revoke"</Button>
                                            })}
                                        </td>
                                    </tr>
                                }
                            }).collect_view()}
                        </tbody>
                    </table>
                }.into_any(),
            }}
            {move || confirming.get().map(|s| {
                let name = s.device_name.clone();
                view! {
                    <Dialog title="Revoke this device?" on_close=move |()| confirming.set(None)
                        actions=ToChildren::to_children(move || {
                            let s = s.clone();
                            view! {
                                <Button variant="secondary" on_click=move || confirming.set(None)>"Cancel"</Button>
                                <Button variant="primary" on_click=move || revoke.run(s.clone())>"Revoke access"</Button>
                            }
                        })>
                        "“"{name.clone()}"” will be signed out immediately and will need the account password to sign in again."
                    </Dialog>
                }
            })}
        </Card>
    }
}

/// The server's other address, so home and away both just work.
#[component]
pub fn AlternateAddressControl() -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let draft = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let confirm = RwSignal::new(None::<(String, String)>);

    let submit = {
        let host = host.clone();
        Callback::new(move |(raw, confirmed): (String, Option<String>)| {
            busy.set(true);
            error.set(None);
            confirm.set(None);
            let host = host.clone();
            spawn_local(async move {
                let mut args = vec![JsValue::from_str(&raw)];
                if let Some(c) = confirmed {
                    args.push(JsValue::from_str(&c));
                }
                match host
                    .store::<SaveAlternateResult>("saveAlternateAddress", &args)
                    .await
                {
                    Ok(SaveAlternateResult::Error { message }) => {
                        let _ = error.try_set(Some(message));
                    }
                    Ok(SaveAlternateResult::Confirm {
                        address,
                        fingerprint,
                    }) => {
                        let _ = confirm.try_set(Some((address, fingerprint)));
                    }
                    Ok(SaveAlternateResult::Saved) => {
                        let _ = draft.try_set(String::new());
                    }
                    Err(e) => {
                        let _ = error.try_set(Some(e.message_or("Couldn't save that address.")));
                    }
                }
                let _ = busy.try_set(false);
            });
        })
    };

    view! {
        <div style="display: grid; gap: 8px; margin-top: 16px">
            <div style="font-weight: 600; font-size: var(--text-sm)">"Second address"</div>
            <p class="card-meta" style="margin: 0px">
                "Add your server's other address, like its home address and its VPN address. The app uses whichever one answers, so it works at home and away without changing anything."
            </p>
            {move || match app.with(|a| a.alternate_address.clone()) {
                Some(alt) => {
                    let host = host.clone();
                    view! {
                        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                            <span style="font-family: ui-monospace, monospace; font-size: var(--text-sm)">{alt}</span>
                            <Button variant="ghost" on_click=move || host.store_fire("removeAlternateAddress", &[])>"Remove"</Button>
                        </div>
                        <p class="card-meta" style="margin: 0px">
                            "Connected through "{move || app.with(|a| a.active_address.clone().unwrap_or_default())}
                        </p>
                    }.into_any()
                }
                None => view! {
                    <div style="display: grid; gap: 8px; max-width: 360px">
                        <Field label="Other address" placeholder="https://100.64.0.5:8443" value=draft
                            no_spellcheck=true autocapitalize="off" />
                        <div>
                            <Button variant="secondary" on_click=move || submit.run((draft.get_untracked(), None))
                                disabled=Signal::derive(move || busy.get() || vault_core::serde_util::js_trim(&draft.get()).is_empty())>
                                {spinner_or(busy.into(), "Checking", "Add address")}
                            </Button>
                        </div>
                    </div>
                }.into_any(),
            }}
            {alert(error.into(), ALERT)}
            {move || confirm.get().map(|(address, fingerprint)| {
                let addr = address.clone();
                let fp = fingerprint.clone();
                view! {
                    <Dialog title="Trust this address?" on_close=move |()| confirm.set(None)
                        actions=ToChildren::to_children(move || {
                            let (a, f) = (addr.clone(), fp.clone());
                            view! {
                                <Button variant="secondary" on_click=move || confirm.set(None)>"Cancel"</Button>
                                <Button variant="primary" on_click=move || submit.run((a.clone(), Some(f.clone())))>
                                    "The fingerprints match"
                                </Button>
                            }
                        })>
                        "Only trust "{address.clone()}" if this fingerprint matches the one your server shows:"
                        <div style="font-family: ui-monospace, monospace; font-size: var(--text-xs); word-break: break-all; margin-top: 8px; user-select: all">
                            {fingerprint.clone()}
                        </div>
                    </Dialog>
                }
            })}
        </div>
    }
}

#[component]
pub fn ServerSection() -> impl IntoView {
    let host = use_host();
    let app = host.settings_state();
    let confirming = RwSignal::new(false);
    let re_pin = {
        let host = host.clone();
        move || {
            let host = host.clone();
            spawn_local(async move {
                // The certificate changed, so the second address needs checking again too.
                let _ = host
                    .store::<IgnoredAny>("removeAlternateAddress", &[])
                    .await;
                if let Some(a) = host.settings_now().server_address {
                    host.forget_pin(&a).await;
                }
                let _ = host.store::<IgnoredAny>("changeServer", &[]).await;
            });
        }
    };
    let change = {
        let host = host.clone();
        move || host.store_fire("changeServer", &[])
    };
    view! {
        <Card kicker="Server" title="Connection">
            <p class="card-body" style="font-family: ui-monospace, monospace">
                {move || app.with(|a| a.server_address.clone().unwrap_or_default())}
            </p>
            <div style="display: flex; gap: 8px; flex-wrap: wrap">
                <Button variant="secondary" on_click=move || confirming.set(true)>"Connect to a different server"</Button>
                {move || {
                    let re_pin = re_pin.clone();
                    (app.with(|a| a.platform == "tauri")).then(|| view! {
                        <Button variant="ghost" on_click=re_pin>"Re-verify server identity"</Button>
                    })
                }}
            </div>
            <p class="card-meta">
                "Re-verify after rotating your server's TLS certificate — the stored fingerprint pin is cleared and confirmed again on the next connect."
            </p>
            <AlternateAddressControl />
            {move || confirming.get().then(|| {
                let change = change.clone();
                view! {
                    <Dialog title="Disconnect from this server?" on_close=move |()| confirming.set(false)
                        actions=ToChildren::to_children(move || {
                            let change = change.clone();
                            view! {
                                <Button variant="secondary" on_click=move || confirming.set(false)>"Cancel"</Button>
                                <Button variant="primary" on_click=change>"Disconnect"</Button>
                            }
                        })>
                        "You'll be signed out on this device and asked for a new server address. Nothing on the server is affected."
                    </Dialog>
                }
            })}
        </Card>
    }
}
