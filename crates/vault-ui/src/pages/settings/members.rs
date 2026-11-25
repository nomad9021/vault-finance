//! `MembersSection`: household members. Only the owner (the household's
//! "sub-admin") sees this; members are hidden from it entirely.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::common::UserRole;
use vault_core::downloads::invite_message;
use vault_core::members::{
    mail_server_for, ConnectEmailRequest, CreateMemberRequest, EmailConnectionStatus,
    InviteMemberRequest, InviteMemberResponse, MemberListResponse,
};
use vault_core::serde_util::js_trim;
use vault_core::server_route::shareable_invite_link;
use vault_core::url::Url;

use crate::host::{use_host, HostCtx};
use crate::ui::{Avatar, Button, Card, Dialog, Field, Spinner, Tag};

/// What the invite dialog shows.
#[derive(Clone, PartialEq)]
struct InviteResult {
    resp: InviteMemberResponse,
    to: String,
    link_only: bool,
    link: Option<String>,
}

/// `Number(port)` when it's an integer port, else 587.
fn port_number(s: &str) -> u16 {
    let t = js_trim(s);
    let n = if t.is_empty() {
        Some(0.0)
    } else {
        t.parse::<f64>().ok()
    };
    match n {
        Some(n) if n.fract() == 0.0 && (0.0..=65535.0).contains(&n) => n as u16,
        _ => 587,
    }
}

#[component]
pub fn MembersSection() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let user = Memo::new(move |_| app.with(|a| a.user.clone()));
    let data = RwSignal::new(None::<MemberListResponse>);
    let mode = RwSignal::new("none");
    let f_name = RwSignal::new(String::new());
    let f_email = RwSignal::new(String::new());
    let f_temp = RwSignal::new(String::new());
    let email_status = RwSignal::new(None::<EmailConnectionStatus>);
    // Servers before 0.1.17 send invites their own way and have no email settings.
    let older_server = RwSignal::new(false);
    let copied = RwSignal::new(None::<&'static str>);
    let c_email = RwSignal::new(String::new());
    let c_password = RwSignal::new(String::new());
    let c_host = RwSignal::new(String::new());
    let c_port = RwSignal::new("587".to_string());
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let invite_result = RwSignal::new(None::<InviteResult>);
    let removing = RwSignal::new(None::<(String, String)>);

    let reload = {
        let host = host.clone();
        move || {
            let h = host.clone();
            spawn_local(async move {
                let r = h.call::<MemberListResponse>("members", &[]).await;
                data.try_set(r.ok());
            });
            let h = host.clone();
            spawn_local(async move {
                match h
                    .try_call::<EmailConnectionStatus>("emailConnection", &[])
                    .await
                {
                    Ok(s) => {
                        email_status.try_set(Some(s));
                    }
                    Err(e) => {
                        email_status.try_set(None);
                        older_server.try_set(e.is_api_request() && e.status == Some(404));
                    }
                }
            });
        }
    };
    reload();

    let can_send_email = Memo::new(move |_| {
        email_status.with(|s| {
            s.as_ref()
                .is_some_and(|s| s.connected || s.server_mail_available)
        })
    });
    let is_gmail = Memo::new(move |_| {
        let e = c_email.get();
        let lower = js_trim(&e).to_lowercase();
        let domain = lower.split('@').nth(1).unwrap_or("");
        domain == "gmail.com" || domain == "googlemail.com"
    });
    let needs_mail_server =
        Memo::new(move |_| c_email.with(|e| e.contains('@') && mail_server_for(e).is_none()));

    let clear_connect = move || {
        c_email.set(String::new());
        c_password.set(String::new());
        c_host.set(String::new());
        c_port.set("587".into());
    };
    let reset = move || {
        mode.set("none");
        f_name.set(String::new());
        f_email.set(String::new());
        f_temp.set(String::new());
        clear_connect();
        error.set(None);
        busy.set(false);
    };

    let start_invite = move || {
        error.set(None);
        if can_send_email.get_untracked() || older_server.get_untracked() {
            mode.set("invite");
        } else {
            let email = user.with_untracked(|u| u.as_ref().map(|u| u.email.clone()));
            c_email.set(email.unwrap_or_default());
            c_password.set(String::new());
            c_host.set(String::new());
            c_port.set("587".into());
            mode.set("connect");
        }
    };

    let disconnect = {
        let host = host.clone();
        move || {
            let host = host.clone();
            error.set(None);
            spawn_local(async move {
                match host
                    .try_call::<EmailConnectionStatus>("disconnectEmail", &[])
                    .await
                {
                    Ok(s) => {
                        email_status.try_set(Some(s));
                    }
                    Err(e) => {
                        error.try_set(Some(e.message_or("Couldn't disconnect your email.")));
                    }
                }
            });
        }
    };

    let submit = {
        let host = host.clone();
        let reload = reload.clone();
        move || {
            let host = host.clone();
            let reload = reload.clone();
            busy.set(true);
            error.set(None);
            let m = mode.get_untracked();
            spawn_local(async move {
                let result: Result<(), crate::host::CallError> = async {
                    if m == "connect" {
                        let needs = needs_mail_server.get_untracked();
                        let body = ConnectEmailRequest {
                            email: js_trim(&c_email.get_untracked()).to_string(),
                            password: c_password.get_untracked(),
                            host: needs.then(|| js_trim(&c_host.get_untracked()).to_string()),
                            port: needs.then(|| port_number(&c_port.get_untracked())),
                        };
                        let s = host
                            .try_call::<EmailConnectionStatus>(
                                "connectEmail",
                                &[HostCtx::arg(&body)],
                            )
                            .await?;
                        email_status.try_set(Some(s));
                        // Connected: go straight on to the thing they came here to do.
                        clear_connect();
                        mode.try_set("invite");
                        busy.try_set(false);
                        return Ok(());
                    }
                    if m == "invite" || m == "link" {
                        let to = js_trim(&f_email.get_untracked()).to_string();
                        let a = app.get_untracked();
                        let server_url = a.active_address.clone().unwrap_or(a.base_url.clone());
                        let link_only = m == "link";
                        let older = older_server.get_untracked();
                        let body = InviteMemberRequest {
                            email: to.clone(),
                            server_url: Some(server_url.clone()),
                            send_email: link_only.then_some(false),
                            // Older servers require a name; the part before the @ stands in for it.
                            display_name: older.then(|| {
                                let before = to.split('@').next().unwrap_or("");
                                if before.is_empty() {
                                    to.clone()
                                } else {
                                    before.to_string()
                                }
                            }),
                        };
                        let resp = host
                            .try_call::<InviteMemberResponse>(
                                "inviteMember",
                                &[HostCtx::arg(&body)],
                            )
                            .await?;
                        copied.try_set(None);
                        let link = shareable_invite_link(&resp.invite_url, Some(&server_url));
                        invite_result.try_set(Some(InviteResult {
                            resp,
                            to,
                            link_only,
                            link,
                        }));
                    } else {
                        let body = CreateMemberRequest {
                            display_name: js_trim(&f_name.get_untracked()).to_string(),
                            email: js_trim(&f_email.get_untracked()).to_string(),
                            temp_password: f_temp.get_untracked(),
                        };
                        host.try_call::<IgnoredAny>("createMember", &[HostCtx::arg(&body)])
                            .await?;
                    }
                    reset();
                    reload();
                    Ok(())
                }
                .await;
                if let Err(e) = result {
                    error.try_set(Some(e.message_or("Something went wrong.")));
                    busy.try_set(false);
                }
            });
        }
    };

    let remove = {
        let host = host.clone();
        let reload = reload.clone();
        move || {
            let Some((id, _)) = removing.get_untracked() else {
                return;
            };
            let host = host.clone();
            let reload = reload.clone();
            spawn_local(async move {
                let _ = host.call::<IgnoredAny>("removeMember", &[id.into()]).await;
                removing.try_set(None);
                reload();
            });
        }
    };

    let copy_message = {
        let host = host.clone();
        move || {
            let Some(link) =
                invite_result.with_untracked(|r| r.as_ref().and_then(|r| r.link.clone()))
            else {
                return;
            };
            let a = app.get_untracked();
            let inviter = a.user.map(|u| u.display_name).unwrap_or_default();
            let origin = Url::parse(&link).map(|u| u.origin()).unwrap_or_default();
            let text = invite_message(&inviter, &link, &origin, &a.app_version);
            let host = host.clone();
            spawn_local(async move {
                if host.copy_text(&text).await {
                    copied.try_set(Some("message"));
                }
            });
        }
    };
    let copy_link = {
        let host = host.clone();
        move || {
            let Some(link) =
                invite_result.with_untracked(|r| r.as_ref().and_then(|r| r.link.clone()))
            else {
                return;
            };
            let host = host.clone();
            spawn_local(async move {
                if host.copy_text(&link).await {
                    copied.try_set(Some("link"));
                }
            });
        }
    };

    let open_in_browser = {
        let host = host.clone();
        move |url: &str| host.open_external(url)
    };

    let form = {
        let submit = submit.clone();
        move || {
            let m = mode.get();
            if m == "none" {
                return view! {
                    <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px">
                        <Button variant="secondary" on_click=start_invite>"Invite by email"</Button>
                        <Button variant="ghost" on_click=move || mode.set("link")>"Get an invite link"</Button>
                        <Button variant="ghost" on_click=move || mode.set("create")>"Add with temporary password"</Button>
                    </div>
                }
                .into_any();
            }
            let submit = submit.clone();
            let open_in_browser = open_in_browser.clone();
            let label = match m {
                "connect" => "Connect email",
                "invite" => "Send invite",
                "link" => "Create link",
                _ => "Create account",
            };
            view! {
                <div style="display: grid; gap: 10px; margin-top: 12px; max-width: 360px">
                    {(m == "connect").then(|| view! {
                        <p class="card-body" style="margin: 0px">
                            "Connect your email once, and invites will come from your address. Use an app password, not your normal password. It's stored encrypted on your server."
                        </p>
                        <Field label="Your email" input_type="email" value=c_email autofocus=true />
                        {move || is_gmail.get().then(|| {
                            let open_in_browser = open_in_browser.clone();
                            view! {
                                <div>
                                    <Button variant="ghost" on_click=move || open_in_browser("https://myaccount.google.com/apppasswords")>
                                        "Create a Google app password"
                                    </Button>
                                    <p class="card-body" style="margin: 4px 0px 0px">
                                        "Google requires 2-Step Verification to be on first."
                                    </p>
                                </div>
                            }
                        })}
                        <Field label="App password" input_type="password" autocomplete="off" value=c_password />
                        {move || needs_mail_server.get().then(|| view! {
                            <Field label="Mail server" placeholder="smtp.example.com"
                                hint=Signal::derive(|| "Your email provider lists this in its help pages. Outlook and Hotmail may not allow app-password sign-in.".to_string())
                                value=c_host />
                            <Field label="Port" input_mode="numeric" value=c_port />
                        })}
                    })}
                    {(m == "create").then(|| view! {
                        <Field label="Name" value=f_name autofocus=true />
                    })}
                    {(m == "link").then(|| view! {
                        <p class="card-body" style="margin: 0px">
                            "You'll get a one-time link to send them however you like. No email is sent."
                        </p>
                    })}
                    {(m != "connect").then(|| view! {
                        <Field label=if m == "create" { "Email" } else { "Their email" } input_type="email"
                            value=f_email autofocus=m != "create" />
                    })}
                    {(m == "create").then(|| view! {
                        <Field label="Temporary password (min 12 characters)" input_type="text" value=f_temp />
                    })}
                    {move || error.get().map(|e| view! {
                        <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
                    })}
                    <div style="display: flex; gap: 8px">
                        <Button variant="primary" disabled=busy on_click=submit.clone()>
                            {move || if busy.get() {
                                view! { <Spinner label="Working" /> }.into_any()
                            } else {
                                label.into_any()
                            }}
                        </Button>
                        {(m == "connect").then(|| view! {
                            <Button variant="ghost" disabled=busy on_click=move || {
                                error.set(None);
                                mode.set("link");
                            }>
                                "Skip email, get a link"
                            </Button>
                        })}
                        <Button variant="ghost" disabled=busy on_click=reset>"Cancel"</Button>
                    </div>
                </div>
            }
            .into_any()
        }
    };

    let table = move || {
        let Some(d) = data.get() else {
            return view! { <Spinner label="Loading members" /> }.into_any();
        };
        let me = user.with(|u| u.as_ref().map(|u| u.id.clone()).unwrap_or_default());
        view! {
            <table class="table">
                <thead>
                    <tr>
                        <th>"Name"</th>
                        <th>"Email"</th>
                        <th>"Role"</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {d.members.into_iter().map(|m| {
                        let removable = m.role != UserRole::Owner && m.id != me;
                        let (id, label) = (m.id.clone(), m.display_name.clone());
                        let role = match m.role {
                            UserRole::Owner => "owner",
                            UserRole::Member => "member",
                        };
                        view! {
                            <tr>
                                <td>
                                    <span style="display: inline-flex; align-items: center; gap: 8px">
                                        <Avatar name=m.display_name.clone()
                                            color=m.avatar_color.clone().unwrap_or_else(|| "#8a94a6".into())
                                            image=m.avatar_image.clone().unwrap_or_default() size=26 />
                                        {m.display_name.clone()}
                                    </span>
                                </td>
                                <td>{m.email.clone()}</td>
                                <td style="text-transform: capitalize">{role}</td>
                                <td style="text-align: right">
                                    {removable.then(|| view! {
                                        <Button variant="ghost" on_click=move || removing.set(Some((id.clone(), label.clone())))>
                                            "Remove"
                                        </Button>
                                    })}
                                </td>
                            </tr>
                        }
                    }).collect_view()}
                    {d.invites.into_iter().map(|i| {
                        let (id, label) = (i.id.clone(), format!("the invite for {}", i.email));
                        view! {
                            <tr style="opacity: 0.7">
                                <td>{i.display_name.clone()}</td>
                                <td>{i.email.clone()}</td>
                                <td><Tag>"invite pending"</Tag></td>
                                <td style="text-align: right">
                                    <Button variant="ghost" on_click=move || removing.set(Some((id.clone(), label.clone())))>
                                        "Revoke"
                                    </Button>
                                </td>
                            </tr>
                        }
                    }).collect_view()}
                </tbody>
            </table>
        }
        .into_any()
    };

    let invite_dialog = move || {
        let r = invite_result.get()?;
        let older = older_server.get();
        let (copy_message, copy_link) = (copy_message.clone(), copy_link.clone());
        let has_link = r.link.is_some();
        let title = if r.resp.emailed {
            "Invite sent"
        } else if r.link_only || (older && has_link) {
            "Invite link ready"
        } else {
            "Invite not emailed"
        };
        let body = if !has_link && r.link_only {
            "This app reaches the server through an address that only works on this computer, so there's no link to share. Connect the app using the server's network address, then try again.".to_string()
        } else if r.link_only || (older && has_link) {
            format!("Send this one-time link to {}. It lasts 7 days. They'll need to be on the same home Wi-Fi or private network (VPN) as this server to open it, and their browser may warn about the server's certificate.", r.to)
        } else if r.resp.emailed {
            let from = r
                .resp
                .sent_from
                .as_deref()
                .filter(|f| !f.is_empty())
                .map(|f| format!(" from {f}"))
                .unwrap_or_default();
            format!("Sent to {}{from}. It can take a minute to arrive, so ask them to check spam too. They'll need to be on the same home Wi-Fi or private network (VPN) as this server to open it. You can also share this one-time link:", r.to)
        } else {
            let problem = r
                .resp
                .email_problem
                .clone()
                .unwrap_or_else(|| "The email couldn't be sent.".into());
            if has_link {
                format!("{problem} The invite is still valid, so you can share this one-time link yourself:")
            } else {
                problem
            }
        };
        let link = r.link.clone();
        let actions = move || {
            let (copy_message, copy_link) = (copy_message.clone(), copy_link.clone());
            view! {
                {has_link.then(|| view! {
                    <Button variant="secondary" on_click=copy_message>
                        {move || if copied.get() == Some("message") { "Message copied" } else { "Copy message with downloads" }}
                    </Button>
                    <Button variant="ghost" on_click=copy_link>
                        {move || if copied.get() == Some("link") { "Copied" } else { "Copy link only" }}
                    </Button>
                })}
                <Button variant="primary" on_click=move || invite_result.set(None)>"Done"</Button>
            }
        };
        Some(view! {
            <Dialog title=title.to_string() on_close=move || invite_result.set(None)
                actions=ToChildren::to_children(actions)>
                {body.clone()}
                {link.clone().map(|l| view! {
                    <div style="font-family: ui-monospace, monospace; font-size: var(--text-xs); word-break: break-all; margin-top: 8px; user-select: all">
                        {l}
                    </div>
                })}
            </Dialog>
        })
    };

    let remove_dialog = move || {
        let (_, label) = removing.get()?;
        let remove = remove.clone();
        let actions = move || {
            let remove = remove.clone();
            view! {
                <Button variant="secondary" on_click=move || removing.set(None)>"Cancel"</Button>
                <Button variant="primary" on_click=remove>"Remove"</Button>
            }
        };
        Some(view! {
            <Dialog title="Remove access?" on_close=move || removing.set(None)
                actions=ToChildren::to_children(actions)>
                {format!("{label} will lose access immediately. Shared data stays.")}
            </Dialog>
        })
    };

    let is_owner =
        Memo::new(move |_| user.with(|u| u.as_ref().is_some_and(|u| u.role == UserRole::Owner)));
    let disconnect = StoredValue::new(disconnect);
    move || {
        let (form, invite_dialog, remove_dialog) =
            (form.clone(), invite_dialog.clone(), remove_dialog.clone());
        is_owner.get().then(move || {
            view! {
                <Card kicker="Household" title="Family members">
                    <p class="card-body">
                        "Everyone here shares the same accounts and transactions. Invite people by email, or create an account with a temporary password you hand to them."
                    </p>
                    {move || email_status.get().filter(|s| s.connected).map(|s| view! {
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; font-size: var(--text-sm)">
                            <span>{format!("Invites send from {}", s.from_email.unwrap_or_default())}</span>
                            <Button variant="ghost" on_click=move || disconnect.with_value(|f| f())>"Disconnect email"</Button>
                        </div>
                    })}
                    {table}
                    {form}
                    {invite_dialog}
                    {remove_dialog}
                </Card>
            }
        })
    }
}
