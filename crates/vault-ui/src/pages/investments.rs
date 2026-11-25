//! Investments: port of apps/desktop/src/screens/shell/InvestmentsPage.tsx.
//! Holdings and values are entered by the user; nothing here talks to a
//! market-data service.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::investments::{
    Holding, HoldingForm, InvestmentAccount, InvestmentsResponse, SLICE_COLORS,
};
use vault_core::nav::NavFilter;

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{Button, Card, Dialog, Field, Panel, Spinner};

/// The holding dialog: which account, and the holding (`None` = adding).
type Editing = Option<(InvestmentAccount, Option<Holding>)>;

#[component]
pub fn InvestmentsPage() -> impl IntoView {
    let host = use_host();
    let data_version = host.data_version;
    // Bumped after a save, like useData's reload().
    let version = RwSignal::new(0_u32);
    let data = LocalResource::new(move || {
        data_version.track();
        version.track();
        let host = use_host();
        async move { host.call::<InvestmentsResponse>("investments", &[]).await }
    });
    let editing = RwSignal::new(None::<(InvestmentAccount, Option<Holding>)>);

    let body = move || {
        let Some(result) = data.get() else {
            return view! { <Spinner label="Loading investments" /> }.into_any();
        };
        // A failed load shows the empty card, as useData leaves data null.
        let Some(data) = result.ok().filter(|d| !d.accounts.is_empty()) else {
            let host = use_host();
            return view! {
                <Card title="No investment accounts yet" style="max-width: 560px; margin: 0 auto">
                    <p class="card-body">
                        "Add an account with type “Investment” on the Accounts page, then track holdings and allocation here. Values are entered by you — this app never talks to a market-data service."
                    </p>
                    <div>
                        <Button variant="primary"
                            on_click=move || host.navigate("accounts", &NavFilter::default())>
                            "Open Accounts"
                        </Button>
                    </div>
                </Card>
            }
            .into_any();
        };
        view! {
            <div class="page">
                <Portfolio data=data editing=editing />
            </div>
        }
        .into_any()
    };

    view! {
        {body}
        {move || editing.get().map(|(account, holding)| view! {
            <HoldingDialog account=account holding=holding
                on_close=move || editing.set(None)
                on_saved=move || {
                    editing.set(None);
                    version.update(|v| *v += 1);
                } />
        })}
    }
}

#[component]
fn Portfolio(data: InvestmentsResponse, editing: RwSignal<Editing>) -> impl IntoView {
    let gain = data.gain_cents();
    let gain_color = if gain >= 0 {
        "var(--color-positive)"
    } else {
        "var(--color-negative)"
    };
    let allocation = (!data.allocation.is_empty()).then(|| {
        let slices = data.allocation.clone();
        view! {
            <Panel title="Allocation" subtitle="Share of portfolio value".to_string()>
                <div style="display: flex; height: 14px; border-radius: var(--radius-pill); overflow: hidden; gap: 2px">
                    {slices.iter().enumerate().map(|(i, s)| view! {
                        <div title=format!("{} · {}%", s.symbol, s.percent_label())
                            style=format!("width: {}; background: {}", s.width(), SLICE_COLORS[i % SLICE_COLORS.len()])>
                        </div>
                    }).collect_view()}
                </div>
                <div class="row wrap" style="gap: var(--space-4); margin-top: var(--space-3)">
                    {slices.iter().enumerate().map(|(i, s)| view! {
                        <span class="row t-xs t-tertiary" style="gap: var(--space-2)">
                            <span class="dot-swatch"
                                style=format!("background: {}", SLICE_COLORS[i % SLICE_COLORS.len()])>
                            </span>
                            {format!("{} · {}%", s.symbol, s.percent_label())}
                        </span>
                    }).collect_view()}
                </div>
            </Panel>
        }
    });
    view! {
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px">
            <Stat label="Portfolio value" value=fmt::cents_whole(data.total_value_cents)
                sub="user-entered valuations".into() sub_color="var(--content-tertiary)" />
            <Stat label="Cost basis" value=fmt::cents_whole(data.total_cost_basis_cents)
                sub="total invested".into() sub_color="var(--content-tertiary)" />
            <Stat label="Unrealized gain" value=fmt::cents_whole(gain)
                sub=data.gain_percent_label() sub_color=gain_color />
        </div>
        {allocation}
        {data.accounts.into_iter().map(|account| view! { <AccountPanel account=account editing=editing /> }).collect_view()}
    }
}

#[component]
fn Stat(label: &'static str, value: String, sub: String, sub_color: &'static str) -> impl IntoView {
    view! {
        <div style="background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-lg); padding: 16px 18px; box-shadow: var(--shadow-sm)">
            <div style="font-size: var(--text-2xs); letter-spacing: .04em; text-transform: uppercase; color: var(--content-tertiary); font-weight: 600">
                {label}
            </div>
            <div style="font-family: var(--font-heading); font-weight: 600; font-size: var(--text-2xl); margin-top: 2px">
                {value}
            </div>
            <div style=format!("font-size: var(--text-xs); color: {sub_color}")>{sub}</div>
        </div>
    }
}

#[component]
fn AccountPanel(account: InvestmentAccount, editing: RwSignal<Editing>) -> impl IntoView {
    let add = {
        let account = account.clone();
        move || editing.set(Some((account.clone(), None)))
    };
    let actions = view! {
        <span class="money t-semibold">{fmt::cents_whole(account.holdings_value_cents)}</span>
        <Button variant="secondary" size="sm" icon="plus" on_click=add>"Holding"</Button>
    }
    .into_any();
    let subtitle = account.institution.clone().filter(|s| !s.is_empty());
    let rows = if account.holdings.is_empty() {
        view! { <p class="card-meta" style="margin: 0px">"No holdings yet."</p> }.into_any()
    } else {
        account
            .holdings
            .iter()
            .map(|h| view! { <HoldingRow account=account.clone() holding=h.clone() editing=editing /> })
            .collect_view()
            .into_any()
    };
    let title = account.name.clone();
    // `{...(account.institution ? { subtitle: account.institution } : {})}`
    match subtitle {
        Some(sub) => view! {
            <Panel title=title subtitle=sub actions=actions>
                <div>{rows}</div>
            </Panel>
        }
        .into_any(),
        None => view! {
            <Panel title=title actions=actions>
                <div>{rows}</div>
            </Panel>
        }
        .into_any(),
    }
}

#[component]
fn HoldingRow(
    account: InvestmentAccount,
    holding: Holding,
    editing: RwSignal<Editing>,
) -> impl IntoView {
    let gain = holding.gain_cents();
    let name = holding.name.clone().filter(|n| !n.is_empty());
    let detail = format!("{} units · as of {}", holding.quantity, holding.as_of_date);
    let symbol = holding.symbol.clone();
    let value = fmt::cents(holding.market_value_cents);
    // The button's own border off first, then only the faint top divider.
    let style = "display: flex; align-items: baseline; gap: 12px; padding: 10px 0; border: none; \
        border-top: 1px solid color-mix(in srgb, var(--color-text) 7%, transparent); \
        font-size: var(--text-sm); width: 100%; background: none; \
        cursor: pointer; text-align: left; font: inherit; color: inherit";
    view! {
        <button style=style on:click=move |_| editing.set(Some((account.clone(), Some(holding.clone()))))>
            <div style="flex: 1; min-width: 0">
                <div style="font-weight: 500; font-size: var(--text-base)">
                    {symbol}
                    {name.map(|n| view! {
                        <span style="color: var(--content-tertiary); font-weight: 400; margin-left: 8px">{n}</span>
                    })}
                </div>
                <div style="font-size: var(--text-xs); color: var(--content-tertiary)">{detail}</div>
            </div>
            {gain.map(|g| view! {
                <span style=format!("font-size: var(--text-sm); color: {}",
                    if g >= 0 { "var(--color-positive)" } else { "var(--color-negative)" })>
                    {fmt::cents_signed(g)}
                </span>
            })}
            <span style="font-weight: 600; font-size: var(--text-base)">{value}</span>
        </button>
    }
}

#[component]
fn HoldingDialog(
    account: InvestmentAccount,
    holding: Option<Holding>,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_saved: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let start = HoldingForm::new(holding.as_ref());
    let symbol = RwSignal::new(start.symbol);
    let name = RwSignal::new(start.name);
    let quantity = RwSignal::new(start.quantity);
    let cost_basis = RwSignal::new(start.cost_basis);
    let value = RwSignal::new(start.value);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    // `onChange={(e) => setSymbol(e.target.value.toUpperCase())}`.
    Effect::new(move || {
        let s = symbol.get();
        let upper = s.to_uppercase();
        if upper != s {
            symbol.set(upper);
        }
    });

    let form = move || HoldingForm {
        symbol: symbol.get(),
        name: name.get(),
        quantity: quantity.get(),
        cost_basis: cost_basis.get(),
        value: value.get(),
    };
    let valid = Signal::derive(move || form().payload().is_some());
    let value_error = Signal::derive(move || form().value_error().map(str::to_string));
    let holding_id = holding.as_ref().map(|h| h.id.clone());
    let editing = holding_id.is_some();
    let title = match &holding {
        Some(h) => format!("Edit {}", h.symbol),
        None => format!("Add holding to {}", account.name),
    };

    let save = {
        let (host, holding_id, account_id) = (host.clone(), holding_id.clone(), account.id.clone());
        move || {
            let Some(payload) = form().payload() else {
                return;
            };
            if busy.get_untracked() {
                return;
            }
            busy.set(true);
            error.set(None);
            let (host, holding_id, account_id) =
                (host.clone(), holding_id.clone(), account_id.clone());
            spawn_local(async move {
                let body = HostCtx::arg(&payload);
                let result = match holding_id {
                    Some(id) => {
                        host.try_call::<IgnoredAny>("updateHolding", &[id.into(), body])
                            .await
                    }
                    None => {
                        host.try_call::<IgnoredAny>("createHolding", &[account_id.into(), body])
                            .await
                    }
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
    let remove = {
        let (host, holding_id) = (host.clone(), holding_id.clone());
        move || {
            let Some(id) = holding_id.clone() else { return };
            if busy.get_untracked() {
                return;
            }
            busy.set(true);
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<IgnoredAny>("deleteHolding", &[id.into()])
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

    let actions = move || {
        let (save, remove) = (save.clone(), remove.clone());
        view! {
            {editing.then(|| view! {
                <Button variant="ghost" disabled=busy on_click=remove.clone()>"Delete"</Button>
            })}
            <Button variant="secondary" disabled=busy on_click=move || on_close.run(())>"Cancel"</Button>
            <Button variant="primary" disabled=Signal::derive(move || !valid.get() || busy.get())
                on_click=save.clone()>
                {move || if busy.get() {
                    view! { <Spinner label="Saving" /> }.into_any()
                } else {
                    "Save".into_any()
                }}
            </Button>
        }
    };

    view! {
        <Dialog title=title on_close=on_close actions=ToChildren::to_children(actions)>
            <div style="display: flex; flex-direction: column; gap: 12px">
                <div style="display: flex; gap: 10px">
                    <div style="width: 120px">
                        <Field label="Symbol" value=symbol autofocus=!editing placeholder="VTI" />
                    </div>
                    <div style="flex: 1">
                        <Field label="Name (optional)" value=name placeholder="Total Market ETF" />
                    </div>
                </div>
                <div style="display: flex; gap: 10px">
                    <div style="flex: 1">
                        <Field label="Quantity" value=quantity input_mode="decimal" placeholder="10.5" />
                    </div>
                    <div style="flex: 1">
                        <Field label="Cost basis (optional)" value=cost_basis input_mode="decimal" placeholder="2000.00" />
                    </div>
                </div>
                <Field label="Current value" value=value input_mode="decimal" placeholder="2600.00"
                    hint="Entered by you — no market-data feeds, ever. Update it whenever you check your brokerage.".to_string()
                    error=value_error />
                {move || error.get().map(|e| view! {
                    <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
                })}
            </div>
        </Dialog>
    }
}
