//! Bills: port of apps/desktop/src/screens/shell/BillsPage.tsx. Recurring
//! obligations and when each is next due; money is set aside for each
//! automatically (the server works it out), so there's nothing to enter.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::accounts::{Account, AccountListResponse};
use vault_core::bills::{
    bill_month, digits_only, due_label, totals, Bill, BillCadence, BillForm, BillListResponse,
    BILL_COLORS,
};
use vault_core::categories::{Category, CategoryKind, CategoryListResponse};
use vault_core::dates::Month;
use wasm_bindgen::JsValue;

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{Button, Dialog, Field, MetricCard, Panel, Select, SelectOption, Spinner, Tabs};

const TABS: &[(&str, &str)] = &[("list", "Upcoming"), ("calendar", "Calendar")];

/// `null` = closed; `Some(None)` = adding; `Some(Some(bill))` = editing.
type Editing = Option<Option<Bill>>;

#[component]
pub fn BillsPage() -> impl IntoView {
    let host = use_host();
    let tab = RwSignal::new(if host.filter.tab.as_deref() == Some("calendar") {
        "calendar"
    } else {
        "list"
    });
    let data_version = host.data_version;
    // Bumped after a save or delete, like useData's reload().
    let version = RwSignal::new(0_u32);
    let bills_res = LocalResource::new(move || {
        data_version.track();
        version.track();
        let host = use_host();
        async move { host.call::<BillListResponse>("bills", &[]).await }
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
    let editing = RwSignal::new(None::<Option<Bill>>);

    let body = move || {
        let Some(result) = bills_res.get() else {
            return view! { <Spinner label="Loading bills" /> }.into_any();
        };
        // A failed load reads as no bills, as useData leaves data null.
        let data = result.ok();
        let (total_due, total_saved, remaining) = totals(data.as_ref());
        let bills = data.map(|d| d.bills).unwrap_or_default();
        let n = bills.len();
        view! {
            <div class="page">
                // Nothing to total until a bill exists: the list below says how to start.
                {(n > 0).then(|| view! {
                    <div class="page-head">
                        <div class="grid" style="flex: 1; min-width: 0px">
                            <div class="col-4">
                                <MetricCard label="Upcoming bills" value=fmt::cents_whole(total_due)
                                    hint=format!("{n} tracked") />
                            </div>
                            <div class="col-4">
                                <MetricCard label="Set aside" value=fmt::cents_whole(total_saved)
                                    delta_tone="up" hint="automatically, before each is due" />
                            </div>
                            <div class="col-4">
                                <MetricCard label="Still to set aside" value=fmt::cents_whole(remaining)
                                    hint="builds up by each due date" />
                            </div>
                        </div>
                    </div>
                })}

                <Tabs items=TABS value=tab aria_label="Bill views" />

                <div style="display: flex; justify-content: flex-end">
                    <Button variant="primary" icon="plus" on_click=move || editing.set(Some(None))>
                        "Add bill"
                    </Button>
                </div>

                {move || if tab.get() == "calendar" {
                    view! { <BillCalendar bills=bills.clone() editing=editing /> }.into_any()
                } else {
                    view! { <BillList bills=bills.clone() accounts=accounts editing=editing /> }.into_any()
                }}
            </div>
        }
        .into_any()
    };

    view! {
        {body}
        {move || editing.get().map(|bill| view! {
            <BillDialog bill=bill
                accounts=Signal::derive(move || {
                    accounts.get().into_iter().filter(|a| a.archived_at.is_none()).collect::<Vec<_>>()
                })
                categories=categories
                on_close=move || editing.set(None)
                on_saved=move || {
                    editing.set(None);
                    version.update(|v| *v += 1);
                } />
        })}
    }
}

#[component]
fn BillList(
    bills: Vec<Bill>,
    #[prop(into)] accounts: Signal<Vec<Account>>,
    editing: RwSignal<Editing>,
) -> impl IntoView {
    view! {
        <Panel title="Upcoming bills" subtitle=Signal::stored("Sorted by next due date".to_string())>
            {if bills.is_empty() {
                view! {
                    <p class="card-meta">
                        "No bills yet. Add your rent, utilities, subscriptions and loans to see when they’re due; money is set aside for each automatically."
                    </p>
                }.into_any()
            } else {
                view! {
                    <div style="display: flex; flex-direction: column">
                        {bills.into_iter().map(|b| view! { <BillRow bill=b accounts=accounts editing=editing /> }).collect_view()}
                    </div>
                }.into_any()
            }}
        </Panel>
    }
}

#[component]
fn BillRow(
    bill: Bill,
    accounts: Signal<Vec<Account>>,
    editing: RwSignal<Editing>,
) -> impl IntoView {
    let (due_text, tone) = due_label(bill.days_until_due);
    let pct = bill.progress();
    let funded = bill.funded();
    let account = bill
        .account_id
        .clone()
        .filter(|id| !id.is_empty())
        .map(|id| {
            move || {
                let name = accounts.with(|a| {
                    a.iter()
                        .find(|a| a.id == id)
                        .map(|a| a.name.clone())
                        .unwrap_or_default()
                });
                format!(" · {name}")
            }
        });
    let set_aside = if funded {
        "Ready to pay".to_string()
    } else {
        format!(
            "{} of {} set aside automatically",
            fmt::cents_whole(bill.saved_cents),
            fmt::cents_whole(bill.amount_cents)
        )
    };
    let fill = if funded {
        "var(--color-positive)".to_string()
    } else {
        bill.color.clone()
    };
    let open = {
        let bill = bill.clone();
        move || editing.set(Some(Some(bill.clone())))
    };
    let open_name = open.clone();
    view! {
        <div class="row-div" style="display: flex; align-items: center; gap: 14px; padding: 12px 2px">
            <span style=format!("width: 10px; height: 10px; border-radius: var(--radius-sm); background: {}; flex: none", bill.color)></span>
            <div style="flex: 1; min-width: 0px">
                <div style="display: flex; align-items: center; gap: 8px">
                    <button on:click=move |_| open_name() title="Edit bill"
                        style="background: none; border: 0px; font: inherit; font-weight: 600; font-size: var(--text-base); cursor: pointer; color: var(--color-text); padding: 0px">
                        {bill.name.clone()}
                    </button>
                    {bill.autopay.then(|| view! {
                        <span style="font-size: var(--text-2xs); font-weight: 600; color: var(--color-positive); border: 1px solid color-mix(in srgb, var(--color-positive) 40%, transparent); border-radius: var(--radius-sm); padding: 1px 6px">
                            "autopay"
                        </span>
                    })}
                </div>
                <div style="font-size: var(--text-xs); color: var(--content-tertiary); margin-top: 1px">
                    {fmt::day_short(&bill.next_due_date)}" · "{bill.cadence.as_str()}{account}
                </div>
                // set-aside progress
                <div style="height: 6px; border-radius: 99px; margin-top: 7px; background: color-mix(in srgb, var(--color-text) 8%, transparent); overflow: hidden; max-width: 340px">
                    <div style=format!("height: 100%; width: {}%; border-radius: 99px; background: {fill}; transition: width .4s var(--ease)", pct * 100.0)></div>
                </div>
                <div style="font-size: var(--text-2xs); color: var(--content-tertiary); margin-top: 3px">
                    {set_aside}
                </div>
            </div>
            <div style="text-align: right; flex: none">
                <div class="num" style="font-weight: 600; font-size: var(--text-md)">
                    {fmt::cents_whole(bill.amount_cents)}
                </div>
                <div style=format!("font-size: var(--text-xs); font-weight: 600; color: {}", tone.color())>{due_text}</div>
            </div>
            <Button variant="ghost" size="sm" icon="edit" title="Edit or delete this bill"
                style="flex: none" on_click=open>
                "Edit"
            </Button>
        </div>
    }
}

/// A month grid of when bills land: the list answers "what's due next",
/// this answers "when does the money actually leave". Weekly bills show on
/// every matching day; the rest on their due day, clamped to the month.
#[component]
fn BillCalendar(bills: Vec<Bill>, editing: RwSignal<Editing>) -> impl IntoView {
    let today = js_sys::Date::new_0();
    let year = today.get_utc_full_year() as i32;
    let month = today.get_utc_month() + 1;
    let m = bill_month(&bills, year, month, today.get_utc_date());
    let title = fmt::month_long_year(Month { year, month });
    let subtitle = format!("{} due across the month", fmt::cents_whole(m.total_cents));
    view! {
        <Panel title=title subtitle=Signal::stored(subtitle)>
            <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(|label| view! {
                    <div style="font-size: var(--text-2xs); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--content-tertiary); padding: 0 2px 2px">
                        {label}
                    </div>
                })}
                {(0..m.lead).map(|_| view! { <div></div> }).collect_view()}
                {m.days.into_iter().map(|d| {
                    let style = format!(
                        "min-height: 76px; border-radius: var(--radius-md); border: {}; background: {}; padding: 6px; opacity: {}; display: flex; flex-direction: column; gap: 3px",
                        if d.is_today { "1px solid var(--color-accent)" } else { "1px solid var(--color-divider)" },
                        if d.total_cents > 0 {
                            format!("color-mix(in srgb, var(--color-accent) {}%, transparent)", d.heat_pct)
                        } else {
                            "transparent".to_string()
                        },
                        if d.is_past { "0.55" } else { "1" },
                    );
                    let num_style = format!(
                        "font-size: var(--text-2xs); font-weight: {}; color: {}",
                        if d.is_today { 700 } else { 500 },
                        if d.is_today { "var(--color-accent)" } else { "var(--content-tertiary)" },
                    );
                    view! {
                        <div style=style>
                            <div style=num_style>{d.day}</div>
                            {d.bills.iter().map(|&i| {
                                let bill = bills[i].clone();
                                let title = format!("{} · {}", bill.name, fmt::cents_whole(bill.amount_cents));
                                let dot = format!("width: 6px; height: 6px; border-radius: 99px; background: {}; flex: none", bill.color);
                                let name = bill.name.clone();
                                view! {
                                    <button on:click=move |_| editing.set(Some(Some(bill.clone()))) title=title
                                        style="display: flex; align-items: center; gap: 4px; background: none; border: 0px; padding: 0px; font: inherit; cursor: pointer; text-align: left; color: var(--color-text); font-size: var(--text-2xs); min-width: 0px">
                                        <span style=dot></span>
                                        <span class="truncate">{name}</span>
                                    </button>
                                }
                            }).collect_view()}
                            {(d.total_cents > 0).then(|| view! {
                                <div class="num" style="margin-top: auto; font-size: var(--text-2xs); font-weight: 600; color: var(--content-tertiary)">
                                    {fmt::cents_whole(d.total_cents)}
                                </div>
                            })}
                        </div>
                    }
                }).collect_view()}
            </div>
        </Panel>
    }
}

#[component]
fn BillDialog(
    bill: Option<Bill>,
    #[prop(into)] accounts: Signal<Vec<Account>>,
    #[prop(into)] categories: Signal<Vec<Category>>,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_saved: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let start = BillForm::new(bill.as_ref());
    let name = RwSignal::new(start.name);
    let amount = RwSignal::new(start.amount);
    let due_day = RwSignal::new(start.due_day);
    let cadence = RwSignal::new(start.cadence.as_str().to_string());
    let autopay = RwSignal::new(start.autopay);
    let account_id = RwSignal::new(start.account_id);
    let category_id = RwSignal::new(start.category_id);
    let color = RwSignal::new(start.color);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let form = move || BillForm {
        name: name.get(),
        amount: amount.get(),
        due_day: due_day.get(),
        cadence: BillCadence::parse(&cadence.get()).unwrap_or(BillCadence::Monthly),
        autopay: autopay.get(),
        account_id: account_id.get(),
        category_id: category_id.get(),
        color: color.get(),
    };
    let valid = Signal::derive(move || form().payload().is_some());
    let bill_id = bill.as_ref().map(|b| b.id.clone());
    let editing = bill_id.is_some();

    let save = {
        let (host, bill_id) = (host.clone(), bill_id.clone());
        move || {
            let Some(payload) = form().payload() else {
                return;
            };
            busy.set(true);
            error.set(None);
            let (host, bill_id) = (host.clone(), bill_id.clone());
            spawn_local(async move {
                let body = HostCtx::arg(&payload);
                let result = match bill_id {
                    Some(id) => {
                        host.call::<IgnoredAny>("updateBill", &[id.into(), body])
                            .await
                    }
                    None => host.call::<IgnoredAny>("createBill", &[body]).await,
                };
                match result {
                    Ok(_) => on_saved.run(()),
                    Err(_) => {
                        error.set(Some("Couldn't save the bill.".into()));
                        busy.set(false);
                    }
                }
            });
        }
    };
    let remove = move || {
        let Some(id) = bill_id.clone() else { return };
        busy.set(true);
        let host = host.clone();
        spawn_local(async move {
            if host
                .call::<IgnoredAny>("deleteBill", &[id.into()])
                .await
                .is_err()
            {
                error.set(Some("Couldn't delete.".into()));
            }
            // Closes either way, as the React dialog does.
            on_saved.run(());
        });
    };

    let cadence_options = Signal::stored(
        BillCadence::ALL
            .iter()
            .map(|c| SelectOption::new(c.as_str(), c.label()))
            .collect::<Vec<_>>(),
    );
    let account_options = Signal::derive(move || {
        let mut o = vec![SelectOption::new("", "None")];
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

    view! {
        <Dialog title=if editing { "Edit bill" } else { "Add bill" }.to_string() on_close=on_close>
            <Field label="Name" value=name placeholder="Rent, Electric, Netflix…" autofocus=true />
            <div style="display: flex; gap: 10px">
                <div style="flex: 1">
                    <Field label="Amount" value=amount placeholder="0.00" input_mode="decimal" />
                </div>
                <div style="width: 120px">
                    <Field label="Due day (1–31)" value=due_day input_mode="numeric" sanitize=digits_only />
                </div>
            </div>
            <div style="display: flex; gap: 10px">
                <div style="flex: 1">
                    <Select label="Frequency" value=cadence options=cadence_options />
                </div>
            </div>
            <Select label="Pay from account (optional)" value=account_id options=account_options />
            <Select label="Category (optional)" value=category_id options=category_options />
            <div style="display: flex; align-items: center; justify-content: space-between">
                <label class="radio" style="cursor: pointer">
                    <input type="checkbox" prop:checked=move || autopay.get()
                        on:change=move |e| autopay.set(event_target_checked(&e))
                        style="position: static; width: auto; height: auto; opacity: 1" />
                    "Autopay enabled"
                </label>
                <div style="display: flex; gap: 6px">
                    {BILL_COLORS.map(|c| view! {
                        <button on:click=move |_| color.set(c.to_string()) aria-label=format!("color {c}")
                            style=move || format!(
                                "width: 20px; height: 20px; border-radius: var(--radius-sm); background: {c}; border: {}; cursor: pointer",
                                if color.get() == c { "2px solid var(--color-text)" } else { "2px solid transparent" })>
                        </button>
                    })}
                </div>
            </div>
            {move || error.get().map(|e| view! {
                <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
            })}
            <div class="dialog-actions">
                {editing.then(|| view! {
                    <Button variant="ghost" disabled=busy on_click=remove.clone()>"Delete"</Button>
                })}
                <Button variant="secondary" disabled=busy on_click=move || on_close.run(())>"Cancel"</Button>
                <Button variant="primary" disabled=Signal::derive(move || !valid.get() || busy.get())
                    on_click=save.clone()>
                    {if editing { "Save" } else { "Add bill" }}
                </Button>
            </div>
        </Dialog>
    }
}
