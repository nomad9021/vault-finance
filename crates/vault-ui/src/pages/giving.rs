//! Giving & Gifts: port of apps/desktop/src/screens/shell/GivingPage.tsx.
//!
//! "Giving" is recurring and open-ended (a tithe, a charity, a sponsorship):
//! what matters is the monthly commitment and what's gone out over the year.
//! "Gift savings" is a sinking fund with a deadline, so those rows lead with
//! the shortfall and the date. Both feed their own branch on the cash-flow
//! Sankey.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::accounts::{Account, AccountListResponse};
use vault_core::categories::{Category, CategoryKind, CategoryListResponse};
use vault_core::giving::{
    gift_shortfall, has_giving, GivingForm, GivingFund, GivingKind, GivingListResponse,
    GIVING_COLORS,
};
use vault_core::money::parse_amount_to_cents;
use vault_core::nav::NavFilter;
use wasm_bindgen::JsValue;

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{
    Button, DateField, Dialog, EmptyState, Field, MetricCard, Panel, Select, SelectOption, Spinner,
    Tabs, Tag,
};

const TABS: &[(&str, &str)] = &[("giving", "Giving"), ("gift", "Gift savings")];

/// `null` = closed; `Some(None)` = adding; `Some(Some(fund))` = editing.
type Editing = Option<Option<GivingFund>>;

const FALLBACK_ERROR: &str = "Something went wrong.";

#[component]
pub fn GivingPage() -> impl IntoView {
    let host = use_host();
    let data_version = host.data_version;
    // Bumped after a save, delete or contribution, like useData's reload().
    let version = RwSignal::new(0_u32);
    let giving_res = LocalResource::new(move || {
        data_version.track();
        version.track();
        let host = use_host();
        async move { host.call::<GivingListResponse>("giving", &[]).await }
    });
    let accounts_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move {
            host.call::<AccountListResponse>("accounts", &[JsValue::TRUE])
                .await
        }
    });
    let categories_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move { host.call::<CategoryListResponse>("categories", &[]).await }
    });
    let accounts = Signal::derive(move || {
        accounts_res
            .get()
            .and_then(Result::ok)
            .map(|r| r.accounts)
            .unwrap_or_default()
    });
    let categories = Signal::derive(move || {
        categories_res
            .get()
            .and_then(Result::ok)
            .map(|r| r.categories)
            .unwrap_or_default()
    });
    let tab = RwSignal::new("giving");
    let editing = RwSignal::new(None::<Option<GivingFund>>);
    let funding = RwSignal::new(None::<GivingFund>);
    let reload = move || version.update(|v| *v += 1);

    let body = move || {
        let Some(result) = giving_res.get() else {
            return view! { <Spinner label="Loading giving" /> }.into_any();
        };
        // A failed load reads as no funds, as useData leaves data null.
        let data = result.ok();
        let show_totals = has_giving(data.as_ref());
        let (monthly_giving, monthly_gift, given_year) = data.as_ref().map_or((0, 0, 0), |d| {
            (
                d.monthly_giving_cents,
                d.monthly_gift_cents,
                d.given_this_year_cents,
            )
        });
        let funds = data.map(|d| d.funds).unwrap_or_default();
        let count = |k: GivingKind| funds.iter().filter(|f| f.kind == k).count();
        let (n_giving, n_gift) = (count(GivingKind::Giving), count(GivingKind::Gift));
        let shortfall = gift_shortfall(&funds);
        view! {
            <div class="page">
                {show_totals.then(|| view! {
                    <div class="page-head">
                        <div class="grid" style="flex: 1; min-width: 0px">
                            <div class="col-3">
                                <MetricCard label="Giving per month" value=fmt::cents_whole(monthly_giving)
                                    hint=format!("{n_giving} commitments") />
                            </div>
                            <div class="col-3">
                                <MetricCard label="Gift savings per month" value=fmt::cents_whole(monthly_gift)
                                    hint=format!("{n_gift} funds") />
                            </div>
                            <div class="col-3">
                                <MetricCard label="Given this year" value=fmt::cents_whole(given_year)
                                    delta_tone="up" hint="from categorized transactions" />
                            </div>
                            <div class="col-3">
                                <MetricCard label="Still to save for gifts" value=fmt::cents_whole(shortfall)
                                    delta_tone={ if shortfall > 0 { "down" } else { "up" } }
                                    hint="across gift funds" />
                            </div>
                        </div>
                    </div>
                })}

                <Tabs items=TABS value=tab aria_label="Giving views" />

                <div style="display: flex; justify-content: flex-end">
                    <Button variant="primary" icon="plus" on_click=move || editing.set(Some(None))>
                        {move || if tab.get() == "gift" { "Add gift fund" } else { "Add giving" }}
                    </Button>
                </div>

                {move || {
                    let gift = tab.get() == "gift";
                    let kind = if gift { GivingKind::Gift } else { GivingKind::Giving };
                    let shown: Vec<GivingFund> =
                        funds.iter().filter(|f| f.kind == kind).cloned().collect();
                    view! {
                        <FundList gift=gift shown=shown accounts=accounts editing=editing funding=funding />
                    }
                }}
            </div>
        }
        .into_any()
    };

    view! {
        {body}
        {move || editing.get().map(|fund| view! {
            <GivingDialog fund=fund
                default_kind=if tab.get_untracked() == "gift" { GivingKind::Gift } else { GivingKind::Giving }
                accounts=accounts categories=categories
                on_close=move || editing.set(None)
                on_saved=move || {
                    editing.set(None);
                    reload();
                } />
        })}
        {move || funding.get().map(|fund| view! {
            <ContributeDialog fund=fund
                on_close=move || funding.set(None)
                on_saved=move || {
                    funding.set(None);
                    reload();
                } />
        })}
    }
}

#[component]
fn FundList(
    gift: bool,
    shown: Vec<GivingFund>,
    accounts: Signal<Vec<Account>>,
    editing: RwSignal<Editing>,
    funding: RwSignal<Option<GivingFund>>,
) -> impl IntoView {
    let (title, subtitle) = if gift {
        ("Gift funds", "Money set aside for a specific occasion")
    } else {
        (
            "Recurring giving",
            "Ongoing commitments, normalized to a monthly amount",
        )
    };
    view! {
        <Panel title=title subtitle=Signal::stored(subtitle.to_string())>
            {if shown.is_empty() {
                let (empty_title, body, action) = if gift {
                    (
                        "No gift funds yet",
                        "Save a little each month toward birthdays, Christmas or a wedding, and the money is there when the date arrives instead of landing on a credit card.",
                        "Add a gift fund",
                    )
                } else {
                    (
                        "No giving tracked yet",
                        "Track a tithe, a charity, or a sponsorship. Each one becomes its own flow on the cash-flow diagram so giving is visible rather than lost inside general spending.",
                        "Add giving",
                    )
                };
                view! {
                    <EmptyState icon="gift" title=empty_title body=body
                        action=view! {
                            <Button variant="primary" icon="plus" on_click=move || editing.set(Some(None))>
                                {action}
                            </Button>
                        }.into_any() />
                }.into_any()
            } else {
                view! {
                    <div style="display: flex; flex-direction: column">
                        {shown.into_iter().map(|f| view! {
                            <FundRow fund=f accounts=accounts editing=editing funding=funding />
                        }).collect_view()}
                    </div>
                }.into_any()
            }}
        </Panel>
    }
}

#[component]
fn FundRow(
    fund: GivingFund,
    accounts: Signal<Vec<Account>>,
    editing: RwSignal<Editing>,
    funding: RwSignal<Option<GivingFund>>,
) -> impl IntoView {
    let host = use_host();
    let target = fund.target();
    let pct = fund.progress();
    let funded = fund.funded();
    let behind = fund.behind();
    let meta = fund.meta_line();
    let account = fund.linked_account().map(|id| {
        let id = id.to_string();
        move || {
            let name = accounts.with(|a| {
                a.iter()
                    .find(|a| a.id == id)
                    .map(|a| a.name.clone())
                    .unwrap_or_else(|| "linked account".into())
            });
            format!(" · {name}")
        }
    });
    let saved_line = (target > 0).then(|| {
        let tail = match fund.needed_monthly_cents {
            Some(n) if behind => format!(" · needs {}/mo to be ready", fmt::cents_whole(n)),
            _ if funded => " · fully funded 🎉".to_string(),
            _ => String::new(),
        };
        let fill = if funded {
            "var(--color-positive)".to_string()
        } else {
            fund.color.clone()
        };
        view! {
            <div style="height: 6px; border-radius: 99px; margin-top: 7px; background: color-mix(in srgb, var(--color-text) 8%, transparent); overflow: hidden; max-width: 340px">
                <div style=format!("height: 100%; width: {}%; border-radius: 99px; background: {fill}; transition: width .4s var(--ease)", pct * 100.0)></div>
            </div>
            <div style="font-size: var(--text-2xs); color: var(--content-tertiary); margin-top: 3px">
                {format!("{} of {} saved{tail}", fmt::cents_whole(fund.saved_cents), fmt::cents_whole(target))}
            </div>
        }
    });
    let given_line = (fund.kind == GivingKind::Giving && fund.given_this_year_cents > 0).then(|| {
        view! {
            <div style="font-size: var(--text-2xs); color: var(--content-tertiary); margin-top: 3px">
                {format!("{} actually given in the last 12 months", fmt::cents_whole(fund.given_this_year_cents))}
            </div>
        }
    });
    let account_button = fund.linked_account().map(|id| {
        let id = id.to_string();
        view! {
            <Button variant="ghost" size="sm" icon_end="arrowRight"
                title="View the linked account's transactions"
                on_click=move || host.navigate("transactions", &NavFilter::account(&id))>
                "Account"
            </Button>
        }
    });
    let edit = {
        let fund = fund.clone();
        move || editing.set(Some(Some(fund.clone())))
    };
    let edit_name = edit.clone();
    let fund_it = {
        let fund = fund.clone();
        move || funding.set(Some(fund.clone()))
    };
    view! {
        <div class="row-div" style="display: flex; align-items: center; gap: 14px; padding: 12px 2px">
            <span style=format!("width: 10px; height: 10px; border-radius: var(--radius-sm); background: {}; flex: none", fund.color)></span>
            <div style="flex: 1; min-width: 0px">
                <div style="display: flex; align-items: center; gap: 8px">
                    <button on:click=move |_| edit_name() title="Edit"
                        style="background: none; border: 0px; font: inherit; font-weight: 600; font-size: var(--text-base); cursor: pointer; color: var(--color-text); padding: 0px">
                        {fund.name.clone()}
                    </button>
                    {funded.then(|| view! { <Tag variant="positive">"ready"</Tag> })}
                    {behind.then(|| view! { <Tag variant="warning">"behind"</Tag> })}
                </div>
                <div style="font-size: var(--text-xs); color: var(--content-tertiary); margin-top: 1px">
                    {meta}{account}
                </div>
                {saved_line}
                {given_line}
            </div>

            <div style="text-align: right; flex: none">
                <div class="num" style="font-weight: 600; font-size: var(--text-md)">
                    {fmt::cents_whole(fund.monthly_cents)}
                </div>
                <div style="font-size: var(--text-2xs); color: var(--content-tertiary)">"per month"</div>
            </div>
            <Button variant="secondary" size="sm" on_click=fund_it>"Set aside"</Button>
            <Button variant="ghost" size="sm" icon="edit" title="Edit or delete this fund" on_click=edit>
                "Edit"
            </Button>
            {account_button}
        </div>
    }
}

#[component]
fn GivingDialog(
    fund: Option<GivingFund>,
    default_kind: GivingKind,
    accounts: Signal<Vec<Account>>,
    categories: Signal<Vec<Category>>,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_saved: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let start = GivingForm::new(fund.as_ref(), default_kind);
    let kind = RwSignal::new(start.kind.as_str().to_string());
    let name = RwSignal::new(start.name);
    let recipient = RwSignal::new(start.recipient);
    let monthly = RwSignal::new(start.monthly);
    let target = RwSignal::new(start.target);
    let occasion_date = RwSignal::new(start.occasion_date);
    let saved = RwSignal::new(start.saved);
    let account_id = RwSignal::new(start.account_id);
    let category_id = RwSignal::new(start.category_id);
    let color = RwSignal::new(start.color);
    let note = RwSignal::new(start.note);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let is_gift = move || kind.get() == "gift";
    let form = move || GivingForm {
        kind: GivingKind::parse(&kind.get()).unwrap_or(GivingKind::Giving),
        name: name.get(),
        recipient: recipient.get(),
        monthly: monthly.get(),
        target: target.get(),
        occasion_date: occasion_date.get(),
        saved: saved.get(),
        account_id: account_id.get(),
        category_id: category_id.get(),
        color: color.get(),
        note: note.get(),
    };
    let valid = Signal::derive(move || form().payload().is_some());
    let fund_id = fund.as_ref().map(|f| f.id.clone());
    let editing = fund_id.is_some();

    let save = {
        let (host, fund_id) = (host.clone(), fund_id.clone());
        move || {
            if busy.get_untracked() {
                return;
            }
            let Some(payload) = form().payload() else {
                return;
            };
            busy.set(true);
            error.set(None);
            let (host, fund_id) = (host.clone(), fund_id.clone());
            spawn_local(async move {
                let body = HostCtx::arg(&payload);
                let result = match fund_id {
                    Some(id) => {
                        host.try_call::<IgnoredAny>("updateGivingFund", &[id.into(), body])
                            .await
                    }
                    None => {
                        host.try_call::<IgnoredAny>("createGivingFund", &[body])
                            .await
                    }
                };
                match result {
                    Ok(_) => on_saved.run(()),
                    Err(e) => {
                        error.set(Some(e.message_or(FALLBACK_ERROR)));
                        busy.set(false);
                    }
                }
            });
        }
    };
    let remove = move || {
        let Some(id) = fund_id.clone() else { return };
        if busy.get_untracked() {
            return;
        }
        busy.set(true);
        let host = host.clone();
        spawn_local(async move {
            match host
                .try_call::<IgnoredAny>("deleteGivingFund", &[id.into()])
                .await
            {
                Ok(_) => on_saved.run(()),
                Err(e) => {
                    error.set(Some(e.message_or(FALLBACK_ERROR)));
                    busy.set(false);
                }
            }
        });
    };

    let kind_options = Signal::stored(vec![
        SelectOption::new("giving", "Recurring giving — ongoing, no end date"),
        SelectOption::new("gift", "Gift fund — saving toward an occasion"),
    ]);
    let account_options = Signal::derive(move || {
        let mut o = vec![SelectOption::new(
            "",
            "Not linked — track the set-aside manually",
        )];
        o.extend(
            accounts
                .get()
                .into_iter()
                .map(|a| SelectOption::new(a.id, a.name)),
        );
        o
    });
    let category_options = Signal::derive(move || {
        let mut o = vec![SelectOption::new("", "No category")];
        o.extend(
            categories
                .get()
                .into_iter()
                .filter(|c| c.kind != CategoryKind::Income)
                .map(|c| SelectOption::new(c.id, c.name)),
        );
        o
    });
    let pick = move |gift: &'static str, giving: &'static str| {
        Signal::derive(move || if is_gift() { gift } else { giving })
    };
    let pick_label = move |gift: &'static str, giving: &'static str| {
        Signal::derive(move || if is_gift() { gift } else { giving }.to_string())
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
    let title = Signal::derive(move || {
        if editing {
            "Edit"
        } else if is_gift() {
            "Add gift fund"
        } else {
            "Add giving"
        }
        .to_string()
    });

    view! {
        <Dialog title=title on_close=on_close actions=ToChildren::to_children(actions)>
            <div style="display: flex; flex-direction: column; gap: 12px">
                <Select label="Type" value=kind options=kind_options />
                <Field label=pick_label("What's it for", "Name") value=name autofocus=!editing
                    placeholder=pick("Christmas 2026", "Monthly tithe") />
                <Field label=pick_label("Who it's for (optional)", "Recipient (optional)")
                    value=recipient placeholder=pick("The kids", "Local food bank") />
                <div style="display: flex; gap: 10px">
                    <div style="flex: 1">
                        <Field label=pick_label("Set aside per month", "Given per month")
                            value=monthly input_mode="decimal" placeholder="50.00" />
                    </div>
                    {move || is_gift().then(|| view! {
                        <div style="flex: 1">
                            <Field label="Target amount" value=target input_mode="decimal" placeholder="600.00" />
                        </div>
                    })}
                </div>
                {move || is_gift().then(|| view! {
                    <DateField label="Occasion date" value=occasion_date placeholder="When is it needed?"
                        hint="Used to work out what you'd need to set aside each month." />
                })}
                <Select label="Linked account (optional)" value=account_id options=account_options />
                <Select label="Category (optional)" value=category_id options=category_options />
                {move || account_id.get().is_empty().then(|| view! {
                    <Field label="Set aside so far" value=saved input_mode="decimal"
                        hint="Correct the running total outright; 'Set aside' on the row adds to it.".to_string() />
                })}
                <p class="text-muted" style="font-size: var(--text-xs); margin: 0px; line-height: 1.6">
                    {move || if account_id.get().is_empty() {
                        "Pick a category to see what you've actually given over the last 12 months, not just what you planned."
                    } else {
                        "The set-aside amount follows this account's balance automatically."
                    }}
                </p>
                <div class="field">
                    <label>"Color"</label>
                    <div style="display: flex; gap: 8px">
                        {GIVING_COLORS.map(|c| view! {
                            <button type="button" aria-label=format!("Color {c}") on:click=move |_| color.set(c.to_string())
                                style=move || format!(
                                    "width: 26px; height: 26px; border-radius: 50%; background: {c}; cursor: pointer; border: {}",
                                    if color.get() == c { "2px solid var(--color-text)" } else { "2px solid transparent" })>
                            </button>
                        })}
                    </div>
                </div>
                <Field label="Note (optional)" value=note placeholder="Pledged through December" />
                {move || error.get().map(|e| view! {
                    <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
                })}
            </div>
        </Dialog>
    }
}

#[component]
fn ContributeDialog(
    fund: GivingFund,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_saved: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let amount = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let cents = Memo::new(move |_| amount.with(|a| parse_amount_to_cents(a)));
    let id = fund.id.clone();

    let submit = move |sign: i64| {
        let Some(c) = cents.get_untracked() else {
            return;
        };
        if busy.get_untracked() {
            return;
        }
        busy.set(true);
        error.set(None);
        let (host, id) = (host.clone(), id.clone());
        spawn_local(async move {
            let delta = JsValue::from_f64((c * sign) as f64);
            match host
                .try_call::<IgnoredAny>("contributeGivingFund", &[id.into(), delta])
                .await
            {
                Ok(_) => on_saved.run(()),
                Err(e) => {
                    error.set(Some(e.message_or(FALLBACK_ERROR)));
                    busy.set(false);
                }
            }
        });
    };
    let disabled = Signal::derive(move || cents.get().is_none() || busy.get());
    let actions = move || {
        let submit = submit.clone();
        let take_out = submit.clone();
        view! {
            <Button variant="secondary" disabled=busy on_click=move || on_close.run(())>"Cancel"</Button>
            <Button variant="ghost" disabled=disabled on_click=move || take_out(-1)>"Take out"</Button>
            <Button variant="primary" disabled=disabled on_click=move || submit(1)>
                {move || if busy.get() {
                    view! { <Spinner label="Saving" /> }.into_any()
                } else {
                    "Add".into_any()
                }}
            </Button>
        }
    };
    let set_aside = format!(
        "{} set aside{}",
        fmt::cents_whole(fund.saved_cents),
        fund.target_cents
            .filter(|&t| t != 0)
            .map(|t| format!(" of {}", fmt::cents_whole(t)))
            .unwrap_or_default()
    );

    view! {
        <Dialog title=format!("Set aside for {}", fund.name) on_close=on_close
            actions=ToChildren::to_children(actions)>
            <div style="display: flex; flex-direction: column; gap: 12px">
                <div class="t-sm t-tertiary">{set_aside.clone()}</div>
                <Field label="Amount" value=amount input_mode="decimal" autofocus=true placeholder="50.00" />
                {move || error.get().map(|e| view! {
                    <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
                })}
            </div>
        </Dialog>
    }
}
