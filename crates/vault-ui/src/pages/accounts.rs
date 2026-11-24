//! Accounts: port of apps/desktop/src/screens/shell/AccountsPage.tsx.
//!
//! Net worth up top, the six-month trend, asset and liability allocation,
//! then every account grouped by kind (collapsible, remembered per device),
//! with add/edit/archive in a dialog.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::accounts::{Account, AccountListResponse, AccountType};
use vault_core::accounts_page::{
    allocation, digits_only, meta_line, set_aside_title, share, shown_subtotal, total_set_aside,
    trend_change, type_icon, visible, AccountForm, AllocRow, Group, Stats, GROUPS,
};
use vault_core::balance_view::{available_cents, shown_balance};
use vault_core::cashflow::TrendsResponse;
use vault_core::money::{js_round, to_fixed};
use vault_core::nav::NavFilter;
use vault_core::trend_chart::project;
use wasm_bindgen::JsValue;

use crate::balance_view::use_show_actual_balances;
use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::storage;
use crate::ui::{
    Button, Card, Dialog, Field, Icon, MetricCard, Panel, Select, SelectOption, Spinner, TrendChart,
};

const COLLAPSE_KEY: &str = "accounts-collapsed";

/// `None` = closed; `Some(None)` = adding; `Some(Some(account))` = editing.
type Editing = Option<Option<Account>>;

fn negative_color(cents: i64) -> &'static str {
    if cents < 0 {
        "var(--color-negative)"
    } else {
        "var(--color-text)"
    }
}

#[component]
pub fn AccountsPage() -> impl IntoView {
    let host = use_host();
    let data_version = host.data_version;
    // Bumped after a save, like useData's reload().
    let version = RwSignal::new(0_u32);
    let accounts_res = LocalResource::new(move || {
        data_version.track();
        version.track();
        let host = use_host();
        async move { host.call::<AccountListResponse>("accounts", &[]).await }
    });
    let trends = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move {
            host.call::<TrendsResponse>("trends", &[JsValue::from(6)])
                .await
        }
    });
    let editing = RwSignal::new(None::<Option<Account>>);
    let collapsed = RwSignal::new(storage::get_string_list(COLLAPSE_KEY));
    let (show_actual, set_show_actual) = use_show_actual_balances();

    // A failed load reads as no accounts, as useData leaves data null.
    let accounts = Memo::new(move |_| match accounts_res.get() {
        Some(Ok(r)) => r.accounts,
        _ => Vec::new(),
    });
    let loaded = Memo::new(move |_| accounts_res.with(|r| r.is_some()));
    let history = Memo::new(move |_| match trends.get() {
        Some(Ok(r)) => r
            .points
            .iter()
            .map(|p| p.net_worth_cents)
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    });

    let body = move || {
        if !loaded.get() {
            return view! { <Spinner label="Loading accounts" /> }.into_any();
        }
        view! {
            <Loaded accounts history collapsed show_actual set_show_actual editing />
        }
        .into_any()
    };

    view! {
        {body}
        {move || editing.get().map(|account| view! {
            <AccountDialog account
                on_close=move || editing.set(None)
                on_saved=move || {
                    editing.set(None);
                    version.update(|v| *v += 1);
                } />
        })}
    }
}

#[component]
fn Loaded(
    accounts: Memo<Vec<Account>>,
    history: Memo<Vec<i64>>,
    collapsed: RwSignal<Vec<String>>,
    show_actual: ReadSignal<bool>,
    set_show_actual: Callback<bool>,
    editing: RwSignal<Editing>,
) -> impl IntoView {
    let stats = Memo::new(move |_| accounts.with(|a| Stats::new(a)));
    let has_accounts = Memo::new(move |_| accounts.with(|a| !a.is_empty()));
    let set_aside = Memo::new(move |_| accounts.with(|a| total_set_aside(a)));
    let projected = Signal::derive(move || history.with(|h| project(h, 3)));
    let has_delta = Memo::new(move |_| history.with(|h| h.len() >= 2));

    let trend_panel = move || {
        has_accounts.get().then(|| {
            let actions = has_delta.get().then(|| {
                view! {
                    {move || {
                        let (change, pct) = history.with(|h| trend_change(h));
                        let up = change >= 0;
                        view! {
                            <span class=if up { "stat-delta pos" } else { "stat-delta neg" }>
                                <Icon name=if up { "trendUp" } else { "trendDown" } size=14 />
                                {fmt::cents_whole(change.abs())}" ("{if pct >= 0.0 { "+" } else { "" }}
                                {to_fixed(pct, 0)}"%)"
                            </span>
                        }
                    }}
                }
                .into_any()
            });
            let chart = move || view! {
                <TrendChart history projected color="var(--color-positive)".to_string() height=150
                    empty_label="Not enough history yet — add transactions to build the trend." />
            };
            let subtitle = "Last 6 months · dashed = projected".to_string();
            match actions {
                Some(actions) => view! {
                    <Panel title="Net worth trend" subtitle actions>{chart()}</Panel>
                }
                .into_any(),
                None => view! { <Panel title="Net worth trend" subtitle>{chart()}</Panel> }.into_any(),
            }
        })
    };

    let alloc = move || {
        let (assets, liabilities) = accounts.with(|a| allocation(a));
        if assets.is_empty() && liabilities.is_empty() {
            return None;
        }
        let s = stats.get();
        Some(view! {
            <div class="grid">
                <div class="col-6">
                    <AllocationPanel title="Asset allocation" rows=assets total=s.assets />
                </div>
                <div class="col-6">
                    <AllocationPanel title="Liabilities" rows=liabilities total=s.liabilities.abs()
                        empty_label="No debts — you're all assets." />
                </div>
            </div>
        })
    };

    let toolbar = view! {
        <div style="display: flex; justify-content: flex-end; align-items: center; gap: 12px; flex-wrap: wrap">
            {move || (set_aside.get() > 0).then(|| {
                let actual = show_actual.get();
                view! {
                    <span class="t-xs t-tertiary">
                        {if actual {
                            "Showing bank balances, including money set aside".to_string()
                        } else {
                            format!("Showing what's free to use · {} set aside", fmt::cents_whole(set_aside.get()))
                        }}
                    </span>
                    <Button variant="ghost" size="sm" on_click=move || set_show_actual.run(!actual)>
                        {if actual { "Show available" } else { "Show actual balances" }}
                    </Button>
                }
            })}
            <Button variant="primary" icon="plus" on_click=move || editing.set(Some(None))>"Add account"</Button>
        </div>
    };

    let list = move || {
        let all_empty = accounts.with(|a| a.is_empty());
        let shown = accounts.with(|a| visible(a));
        if all_empty {
            view! {
                <Card title="No accounts yet">
                    <p class="card-body">
                        "Add your checking account, savings, credit cards, and loans to see your full financial picture."
                    </p>
                </Card>
            }
            .into_any()
        } else if shown.is_empty() {
            view! {
                <Card title="All accounts are at $0">
                    <p class="card-body">
                        "Accounts with a zero balance are hidden here. Record a transaction or edit a balance and the account reappears."
                    </p>
                </Card>
            }
            .into_any()
        } else {
            GROUPS
                .iter()
                .filter_map(|group| {
                    let rows: Vec<Account> = group.rows(&shown).into_iter().cloned().collect();
                    (!rows.is_empty()).then(|| {
                        view! { <GroupPanel group=*group rows collapsed show_actual editing /> }
                    })
                })
                .collect_view()
                .into_any()
        }
    };

    view! {
        <div class="page">
            <div class="grid">
                <div class="col-6">
                    <MetricCard large=true label="Net worth"
                        value=Signal::derive(move || fmt::cents_whole(stats.get().net_worth))
                        hint="assets − liabilities" />
                </div>
                <div class="col-3">
                    <MetricCard label="Assets" value=Signal::derive(move || fmt::cents_whole(stats.get().assets))
                        delta_tone="up" />
                </div>
                <div class="col-3">
                    <MetricCard label="Liabilities"
                        value=Signal::derive(move || fmt::cents_whole(stats.get().liabilities))
                        delta_tone="down" />
                </div>
            </div>
            {trend_panel}
            {alloc}
            {toolbar}
            {list}
        </div>
    }
}

/// Horizontal share bars for asset or liability groups.
#[component]
fn AllocationPanel(
    title: &'static str,
    rows: Vec<AllocRow>,
    total: i64,
    #[prop(default = "Nothing here yet.")] empty_label: &'static str,
) -> impl IntoView {
    let subtitle = (total > 0).then(|| Signal::stored(fmt::cents_whole(total)));
    let body = if rows.is_empty() || total <= 0 {
        view! { <p class="card-meta">{empty_label}</p> }.into_any()
    } else {
        let bars = rows
            .into_iter()
            .map(|r| {
                let s = share(r.subtotal, total);
                view! {
                    <div>
                        <div style="display: flex; justify-content: space-between; font-size: var(--text-sm); margin-bottom: 5px">
                            <span style="display: flex; align-items: center; gap: 7px; min-width: 0px">
                                <span aria-hidden="true" style=format!("width: 8px; height: 8px; border-radius: var(--radius-sm); background: {}; flex: none", r.color)></span>
                                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{r.title}</span>
                            </span>
                            <span class="num" style="color: var(--content-tertiary); flex: none">
                                {format!("{} · {}%", fmt::cents_whole(r.subtotal), js_round(s * 100.0))}
                            </span>
                        </div>
                        <div style="height: 8px; border-radius: 99px; background: color-mix(in srgb, var(--color-text) 8%, transparent); overflow: hidden">
                            <div style=format!("height: 100%; width: {}%; border-radius: 99px; background: {}; transition: width .4s var(--ease)", s * 100.0, r.color)></div>
                        </div>
                    </div>
                }
            })
            .collect_view();
        view! { <div style="display: flex; flex-direction: column; gap: 13px">{bars}</div> }
            .into_any()
    };
    match subtitle {
        Some(subtitle) => view! { <Panel title=title subtitle>{body}</Panel> }.into_any(),
        None => view! { <Panel title=title>{body}</Panel> }.into_any(),
    }
}

/// One collapsible group of accounts.
#[component]
fn GroupPanel(
    group: Group,
    rows: Vec<Account>,
    collapsed: RwSignal<Vec<String>>,
    show_actual: ReadSignal<bool>,
    editing: RwSignal<Editing>,
) -> impl IntoView {
    let host = use_host();
    let title = group.title;
    let count = rows.len();
    let is_collapsed = Memo::new(move |_| collapsed.with(|c| c.iter().any(|t| t == title)));
    let toggle = move |_| {
        collapsed.update(|c| {
            match c.iter().position(|t| t == title) {
                Some(i) => {
                    c.remove(i);
                }
                None => c.push(title.to_string()),
            }
            storage::set_string_list(COLLAPSE_KEY, c);
        });
    };
    let subtotal = {
        let rows = rows.clone();
        move || shown_subtotal(&rows.iter().collect::<Vec<_>>(), show_actual.get())
    };
    let subtotal2 = subtotal.clone();

    let head = view! {
        <button class="tap-target" on:click=toggle
            aria-expanded=move || if is_collapsed.get() { "false" } else { "true" }
            style="display: flex; align-items: center; gap: 8px; background: none; border: 0px; font: inherit; color: inherit; cursor: pointer; padding: 0px">
            <span aria-hidden="true" style=move || format!(
                "display: inline-flex; transition: transform var(--dur) var(--ease); transform: {}; color: var(--content-tertiary)",
                if is_collapsed.get() { "rotate(-90deg)" } else { "none" })>
                <Icon name="chevronDown" size=15 />
            </span>
            <span aria-hidden="true" class="dot-swatch" style=format!("background: {}", group.color)></span>
            {title}
            <span style="font-size: var(--text-xs); color: var(--content-tertiary); font-weight: 500">{format!("· {count}")}</span>
        </button>
    }
    .into_any();
    let actions = view! {
        <span class="num" style=move || format!(
            "font-weight: 600; font-size: var(--text-base); color: {}", negative_color(subtotal()))>
            {move || fmt::cents_whole(subtotal2())}
        </span>
    }
    .into_any();

    let body = move || {
        (!is_collapsed.get()).then(|| {
            let rows = rows
                .iter()
                .cloned()
                .map(|a| view! { <AccountRow account=a show_actual editing host=host.clone() /> })
                .collect_view();
            view! {
                <div style="padding: 0 var(--card-pad) 10px; animation: fadeUp var(--dur) var(--ease) both">
                    {rows}
                </div>
            }
        })
    };

    view! {
        <Panel flush=true title_view=head actions>
            {body}
        </Panel>
    }
}

#[component]
fn AccountRow(
    account: Account,
    show_actual: ReadSignal<bool>,
    editing: RwSignal<Editing>,
    host: HostCtx,
) -> impl IntoView {
    let open = {
        let a = account.clone();
        move || editing.set(Some(Some(a.clone())))
    };
    let open_key = open.clone();
    let shown = {
        let a = account.clone();
        move || shown_balance(&a, show_actual.get())
    };
    let shown2 = shown.clone();
    let currency = account.currency.clone();
    let set_aside = account.set_aside_cents.unwrap_or(0);
    let available = available_cents(&account);
    let id = account.id.clone();
    view! {
        <div role="button" tabindex="0"
            on:click=move |_| open()
            on:keydown=move |e| {
                if e.key() == "Enter" || e.key() == " " {
                    open_key();
                }
            }
            style="display: flex; align-items: center; gap: 12px; padding: 11px 0px; border-top: 1px solid color-mix(in srgb, var(--color-text) 7%, transparent); width: 100%; background: none; cursor: pointer; text-align: left; font: inherit; color: inherit">
            <span aria-hidden="true" class="tile tile-accent">
                <Icon name=type_icon(account.kind) size=17 />
            </span>
            <div style="flex: 1; min-width: 0px">
                <div style="font-weight: 500; font-size: var(--text-base)">{account.name.clone()}</div>
                <div style="font-size: var(--text-xs); color: var(--content-tertiary)">{meta_line(&account)}</div>
            </div>
            <div style="text-align: right" title=set_aside_title(&account, fmt::cents)>
                <div style=move || format!("font-weight: 600; font-size: var(--text-base); color: {}", negative_color(shown()))>
                    {move || fmt::cents_in(shown2(), &currency)}
                </div>
                {(set_aside > 0).then(|| view! {
                    <div style="font-size: var(--text-2xs); color: var(--content-tertiary)">
                        {move || if show_actual.get() {
                            format!("{} available", fmt::cents_whole(available))
                        } else {
                            format!("{} set aside", fmt::cents_whole(set_aside))
                        }}
                    </div>
                })}
            </div>
            <Button variant="secondary" size="sm" title="View this account's transactions" style="flex: none"
                stop_propagation=true
                on_click=move || host.navigate("transactions", &NavFilter::account(&id))>
                "Transactions"
            </Button>
        </div>
    }
}

#[component]
fn AccountDialog(
    account: Option<Account>,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_saved: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let start = AccountForm::new(account.as_ref());
    let name = RwSignal::new(start.name);
    let kind = RwSignal::new(start.kind.as_str().to_string());
    let institution = RwSignal::new(start.institution);
    let mask = RwSignal::new(start.mask);
    let balance = RwSignal::new(start.balance);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let form = move || AccountForm {
        name: name.get(),
        kind: AccountType::parse(&kind.get()).unwrap_or(AccountType::Checking),
        institution: institution.get(),
        mask: mask.get(),
        balance: balance.get(),
    };
    let valid = Signal::derive(move || form().payload().is_some());
    let balance_error = Signal::derive(move || {
        balance
            .with(|b| vault_core::money::parse_amount_to_cents(b).is_none())
            .then(|| "Enter an amount like 1250.00".to_string())
    });
    let account_id = account.as_ref().map(|a| a.id.clone());
    let editing = account_id.is_some();
    let archived = account.as_ref().is_some_and(|a| a.archived_at.is_some());

    let save = {
        let (host, account_id) = (host.clone(), account_id.clone());
        move || {
            if busy.get_untracked() {
                return;
            }
            let Some(payload) = form().payload() else {
                return;
            };
            busy.set(true);
            error.set(None);
            let (host, account_id) = (host.clone(), account_id.clone());
            spawn_local(async move {
                let body = HostCtx::arg(&payload);
                let result = match account_id {
                    Some(id) => {
                        host.try_call::<IgnoredAny>("updateAccount", &[id.into(), body])
                            .await
                    }
                    None => host.try_call::<IgnoredAny>("createAccount", &[body]).await,
                };
                match result {
                    Ok(_) => on_saved.run(()),
                    Err(e) => {
                        error.set(Some(e.message_or("Something went wrong.")));
                        busy.set(false);
                    }
                }
            });
        }
    };
    let archive = {
        let (host, account_id) = (host.clone(), account_id.clone());
        move || {
            let Some(id) = account_id.clone() else { return };
            if busy.get_untracked() {
                return;
            }
            busy.set(true);
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<IgnoredAny>("deleteAccount", &[id.into()])
                    .await
                {
                    Ok(_) => on_saved.run(()),
                    Err(e) => {
                        error.set(Some(e.message_or("Something went wrong.")));
                        busy.set(false);
                    }
                }
            });
        }
    };

    let type_options: Vec<SelectOption> = AccountType::ALL
        .iter()
        .map(|t| SelectOption::new(t.as_str(), t.label()))
        .collect();
    let actions = move || {
        let (save, archive) = (save.clone(), archive.clone());
        view! {
            {editing.then(|| view! {
                <Button variant="ghost" disabled=busy on_click=archive.clone()>
                    {if archived { "Delete" } else { "Archive" }}
                </Button>
            })}
            <Button variant="secondary" disabled=busy on_click=move || on_close.run(())>"Cancel"</Button>
            <Button variant="primary" disabled=Signal::derive(move || !valid.get() || busy.get())
                on_click=save.clone()>
                {move || if busy.get() {
                    view! { <Spinner label="Saving" /> }.into_any()
                } else if editing {
                    "Save".into_any()
                } else {
                    "Add account".into_any()
                }}
            </Button>
        }
    };

    view! {
        <Dialog title=if editing { "Edit account" } else { "Add account" }.to_string()
            on_close=on_close actions=ToChildren::to_children(actions)>
            <div style="display: flex; flex-direction: column; gap: 12px">
                <Field label="Name" value=name autofocus=true placeholder="Everyday Checking" />
                <Select label="Type" value=kind options=type_options.clone() />
                <div style="display: flex; gap: 10px">
                    <div style="flex: 1">
                        <Field label="Institution (optional)" value=institution placeholder="First Local Bank" />
                    </div>
                    <div style="width: 110px">
                        <Field label="Last 4 (optional)" value=mask max_length=4 filter=digits_only />
                    </div>
                </div>
                <Field label=if editing { "Current balance" } else { "Starting balance" } value=balance
                    input_mode="decimal" error=balance_error
                    hint="Use a negative amount for money owed (credit cards, loans).".to_string() />
                {move || error.get().map(|e| view! {
                    <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
                })}
            </div>
        </Dialog>
    }
}
