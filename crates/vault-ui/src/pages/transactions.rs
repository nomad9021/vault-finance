//! Transactions: port of apps/desktop/src/screens/shell/TransactionsPage.tsx.
//!
//! The ledger, 50 rows at a time, with search and category/account/date
//! filters, bulk recategorize/delete, auto-categorize, CSV import and the
//! add/edit dialog. Phones get a day-grouped list with swipe actions
//! instead of the table. A link from another page opens it filtered to a
//! category or account (`NavFilter`).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::Duration;

use leptos::html;
use leptos::leptos_dom::helpers::{set_timeout_with_handle, TimeoutHandle};
use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::accounts::{Account, AccountListResponse};
use vault_core::categories::{Category, CategoryListResponse};
use vault_core::categorize::{AutocategorizeResponse, CreateRuleRequest};
use vault_core::transactions::{SetCategoryBody, Transaction, TransactionListResponse};
use vault_core::transactions_page::{
    all_selected, autocat_message, bulk_category, bulk_delete_title, day_label, group_by_day,
    DayLabel, Filters, ImportResponse, Period, TxnForm,
};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{
    use_narrow, Button, DateField, Dialog, Field, Panel, Select, SelectOption, Spinner,
    SwipeAction, SwipeRow,
};

const SELECT_STYLE: &str = "border-radius: var(--radius-md)";
const DANGER_BTN: &str =
    "background: var(--color-negative); border-color: var(--color-negative); color: #fff";

/// `Promise.all` over futures that never fail (each already swallowed its
/// error, like `.catch(() => {})`): all start at once.
async fn all(futs: Vec<impl Future<Output = ()> + 'static>) {
    let promises: js_sys::Array = futs
        .into_iter()
        .map(|f| {
            JsValue::from(wasm_bindgen_futures::future_to_promise(async move {
                f.await;
                Ok(JsValue::UNDEFINED)
            }))
        })
        .collect();
    let _ = JsFuture::from(js_sys::Promise::all(&promises)).await;
}

/// The list and everything that refetches it.
#[derive(Clone, Copy)]
struct List {
    host: StoredValue<HostCtx>,
    filters: Memo<Filters>,
    rows: RwSignal<Vec<Transaction>>,
    next_cursor: RwSignal<Option<String>>,
    total_count: RwSignal<i64>,
    sum_in: RwSignal<i64>,
    sum_out: RwSignal<i64>,
    loading: RwSignal<bool>,
    generation: StoredValue<u32>,
    selected: RwSignal<HashSet<String>>,
}

impl List {
    /// React's `reload()`: the first page for the current filters; a newer
    /// reload wins over one still in flight.
    fn reload(self) {
        let gen = self.generation.get_value() + 1;
        self.generation.set_value(gen);
        self.loading.set(true);
        self.selected.set(HashSet::new());
        let query = self.filters.get_untracked().query(fmt::today_local(), None);
        let host = self.host.get_value();
        let current = move || self.generation.try_get_value() == Some(gen);
        spawn_local(async move {
            let res = host
                .call::<TransactionListResponse>("transactions", &[HostCtx::arg(&query)])
                .await;
            if !current() {
                return;
            }
            if let Ok(res) = res {
                self.rows.try_set(res.transactions);
                self.next_cursor.try_set(res.next_cursor);
                self.total_count.try_set(res.total_count);
                self.sum_in.try_set(res.sum_in_cents);
                self.sum_out.try_set(res.sum_out_cents);
            }
            self.loading.try_set(false);
        });
    }

    fn load_more(self) {
        let Some(cursor) = self.next_cursor.get_untracked() else {
            return;
        };
        let query = self
            .filters
            .get_untracked()
            .query(fmt::today_local(), Some(&cursor));
        let host = self.host.get_value();
        spawn_local(async move {
            if let Ok(res) = host
                .call::<TransactionListResponse>("transactions", &[HostCtx::arg(&query)])
                .await
            {
                self.rows.try_update(|r| r.extend(res.transactions));
                self.next_cursor.try_set(res.next_cursor);
            }
        });
    }
}

#[component]
pub fn TransactionsPage() -> impl IntoView {
    let host = use_host();
    let phone = use_narrow();
    let data_version = host.data_version;

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
    // Kept from the last good load, as useData keeps `data` across refetches.
    let accounts = RwSignal::new(Vec::<Account>::new());
    let categories = RwSignal::new(Vec::<Category>::new());
    Effect::new(move || {
        if let Some(Ok(r)) = accounts_res.get() {
            accounts.set(r.accounts);
        }
    });
    Effect::new(move || {
        if let Some(Ok(r)) = categories_res.get() {
            categories.set(r.categories);
        }
    });
    let category_by_id = Memo::new(move |_| {
        categories.with(|cs| {
            cs.iter()
                .map(|c| (c.id.clone(), c.clone()))
                .collect::<HashMap<_, _>>()
        })
    });
    let account_name = Memo::new(move |_| {
        accounts.with(|a| {
            a.iter()
                .map(|a| (a.id.clone(), a.name.clone()))
                .collect::<HashMap<_, _>>()
        })
    });
    let open_accounts = Signal::derive(move || {
        accounts.with(|a| {
            a.iter()
                .filter(|a| a.archived_at.is_none())
                .cloned()
                .collect::<Vec<_>>()
        })
    });

    // Filters
    let search = RwSignal::new(String::new());
    let debounced = RwSignal::new(String::new());
    let category_filter = RwSignal::new(host.filter.category_id.clone().unwrap_or_default());
    let account_filter = RwSignal::new(host.filter.account_id.clone().unwrap_or_default());
    let period = RwSignal::new(Period::All);
    let timer = StoredValue::new(None::<TimeoutHandle>);
    Effect::new(move || {
        let s = search.get();
        if let Some(h) = timer.get_value() {
            h.clear();
        }
        timer.set_value(
            set_timeout_with_handle(
                move || {
                    if debounced.try_get_untracked().is_some_and(|d| d != s) {
                        debounced.try_set(s);
                    }
                },
                Duration::from_millis(250),
            )
            .ok(),
        );
    });
    on_cleanup(move || {
        if let Some(h) = timer.try_get_value().flatten() {
            h.clear();
        }
    });
    let filters = Memo::new(move |_| Filters {
        search: debounced.get(),
        category_id: category_filter.get(),
        account_id: account_filter.get(),
        period: period.get(),
    });

    let list = List {
        host: StoredValue::new(host.clone()),
        filters,
        rows: RwSignal::new(Vec::new()),
        next_cursor: RwSignal::new(None),
        total_count: RwSignal::new(0),
        sum_in: RwSignal::new(0),
        sum_out: RwSignal::new(0),
        loading: RwSignal::new(true),
        generation: StoredValue::new(0),
        selected: RwSignal::new(HashSet::new()),
    };
    Effect::new(move || {
        filters.track();
        list.reload();
    });
    let List {
        rows,
        next_cursor,
        total_count,
        sum_in,
        sum_out,
        loading,
        selected,
        ..
    } = list;

    // `None` = closed; `Some(None)` = adding; `Some(Some(t))` = editing.
    let editing = RwSignal::new(None::<Option<Transaction>>);
    let importing = RwSignal::new(false);
    let autocatting = RwSignal::new(false);
    let autocat_msg = RwSignal::new(None::<String>);
    let bulk_busy = RwSignal::new(false);
    let bulk_cat = RwSignal::new(String::new());
    let confirm_delete = RwSignal::new(false);
    // Phone: a transaction swiped to Delete, waiting for confirmation.
    let deleting_one = RwSignal::new(None::<Transaction>);
    let delete_busy = RwSignal::new(false);

    let toggle_row = move |id: &str| {
        selected.update(|s| {
            if !s.remove(id) {
                s.insert(id.to_string());
            }
        })
    };
    let all_sel = Memo::new(move |_| rows.with(|r| selected.with(|s| all_selected(r, s))));
    let toggle_all = move || {
        selected.set(if all_sel.get_untracked() {
            HashSet::new()
        } else {
            rows.with_untracked(|r| r.iter().map(|t| t.id.clone()).collect())
        })
    };

    let apply_bulk_category = {
        let host = host.clone();
        move || {
            let ids = selected.get_untracked();
            if ids.is_empty() {
                return;
            }
            bulk_busy.set(true);
            let body = SetCategoryBody {
                category_id: bulk_category(&bulk_cat.get_untracked()),
            };
            let futs: Vec<_> = ids
                .into_iter()
                .map(|id| {
                    let host = host.clone();
                    let body = HostCtx::arg(&body);
                    async move {
                        let _ = host
                            .call::<IgnoredAny>(
                                "updateTransaction",
                                &[JsValue::from_str(&id), body],
                            )
                            .await;
                    }
                })
                .collect();
            spawn_local(async move {
                all(futs).await;
                bulk_busy.try_set(false);
                bulk_cat.try_set(String::new());
                if bulk_busy.try_get_untracked().is_some() {
                    list.reload();
                }
            });
        }
    };
    let do_bulk_delete = {
        let host = host.clone();
        move || {
            bulk_busy.set(true);
            let futs: Vec<_> = selected
                .get_untracked()
                .into_iter()
                .map(|id| {
                    let host = host.clone();
                    async move {
                        let _ = host
                            .call::<IgnoredAny>("deleteTransaction", &[JsValue::from_str(&id)])
                            .await;
                    }
                })
                .collect();
            spawn_local(async move {
                all(futs).await;
                bulk_busy.try_set(false);
                confirm_delete.try_set(false);
                if bulk_busy.try_get_untracked().is_some() {
                    list.reload();
                }
            });
        }
    };
    let run_autocategorize = {
        let host = host.clone();
        move || {
            autocatting.set(true);
            autocat_msg.set(None);
            let host = host.clone();
            spawn_local(async move {
                match host
                    .call::<AutocategorizeResponse>("autocategorize", &[])
                    .await
                {
                    Ok(r) => {
                        autocat_msg.try_set(Some(autocat_message(&r)));
                        if autocat_msg.try_get_untracked().is_some() {
                            list.reload();
                        }
                    }
                    Err(_) => {
                        autocat_msg.try_set(Some(
                            "Auto-categorize failed. Is the server reachable?".into(),
                        ));
                    }
                }
                autocatting.try_set(false);
            });
        }
    };
    let delete_one = {
        let host = host.clone();
        move || {
            let Some(t) = deleting_one.get_untracked() else {
                return;
            };
            delete_busy.set(true);
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<IgnoredAny>("deleteTransaction", &[JsValue::from_str(&t.id)])
                    .await
                {
                    Ok(_) => {
                        deleting_one.try_set(None);
                        if deleting_one.try_get_untracked().is_some() {
                            list.reload();
                        }
                    }
                    Err(e) => {
                        autocat_msg.try_set(Some(e.message_or("Couldn't delete it.")));
                    }
                }
                delete_busy.try_set(false);
            });
        }
    };

    let category_options = move || {
        categories
            .get()
            .into_iter()
            .map(|c| (c.id, c.name))
            .collect::<Vec<_>>()
    };
    let option = move |value: String, label: String, current: RwSignal<String>| {
        let v = value.clone();
        view! { <option value=value prop:selected=move || current.get() == v>{label}</option> }
    };

    let toolbar = view! {
        <div style="position: sticky; top: 0px; z-index: 5; background: var(--color-bg); padding-top: 2px; padding-bottom: 10px; margin-top: -2px; border-bottom: 1px solid var(--hairline); display: flex; flex-direction: column; gap: 10px">
            <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center">
                <input class="input"
                    style="flex: 1; min-width: 170px; max-width: 300px; border-radius: var(--radius-md)"
                    placeholder="Search merchants…" aria-label="Search merchants"
                    prop:value=move || search.get()
                    on:input=move |e| search.set(event_target_value(&e)) />
                <select class="input" aria-label="Filter by category"
                    style=format!("width: auto; min-width: 155px; {SELECT_STYLE}")
                    on:change=move |e| category_filter.set(event_target_value(&e))>
                    {option(String::new(), "All categories".into(), category_filter)}
                    {option("none".into(), "Uncategorized".into(), category_filter)}
                    {move || category_options().into_iter()
                        .map(|(id, name)| option(id, name, category_filter)).collect_view()}
                </select>
                <select class="input" aria-label="Filter by account"
                    style=format!("width: auto; min-width: 145px; {SELECT_STYLE}")
                    on:change=move |e| account_filter.set(event_target_value(&e))>
                    {option(String::new(), "All accounts".into(), account_filter)}
                    {move || accounts.get().into_iter()
                        .map(|a| option(a.id, a.name, account_filter)).collect_view()}
                </select>
                <select class="input" aria-label="Filter by date"
                    style=format!("width: auto; min-width: 140px; {SELECT_STYLE}")
                    on:change=move |e| period.set(Period::from_value(&event_target_value(&e)))>
                    {Period::ALL.map(|p| view! {
                        <option value=p.value() prop:selected=move || period.get() == p>{p.label()}</option>
                    })}
                </select>
                <div style="display: flex; gap: 10px; margin-left: auto; flex-wrap: wrap">
                    <Button variant="secondary" on_click=run_autocategorize disabled=autocatting
                        title="Sort uncategorized transactions using your keyword rules and past categorizations — all local, nothing leaves your server.">
                        {move || if autocatting.get() { "Sorting…" } else { "Auto-categorize" }}
                    </Button>
                    <Button variant="secondary" on_click=move || importing.set(true)>"Import CSV"</Button>
                    <Button variant="primary" icon="plus" on_click=move || editing.set(Some(None))>"Add"</Button>
                </div>
            </div>

            {move || {
                let n = selected.with(HashSet::len);
                (n > 0).then(|| view! {
                    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 12px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-accent) 12%, var(--color-surface)); border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)">
                        <strong style="font-size: var(--text-sm)">{n}" selected"</strong>
                        <select class="input" aria-label="Recategorize selected"
                            style=format!("width: auto; min-width: 160px; {SELECT_STYLE}")
                            on:change=move |e| bulk_cat.set(event_target_value(&e))>
                            {option(String::new(), "Set category…".into(), bulk_cat)}
                            {option("__none__".into(), "Uncategorized".into(), bulk_cat)}
                            {move || category_options().into_iter()
                                .map(|(id, name)| option(id, name, bulk_cat)).collect_view()}
                        </select>
                        <Button variant="secondary" on_click=apply_bulk_category.clone()
                            disabled=Signal::derive(move || bulk_busy.get() || bulk_cat.with(String::is_empty))>
                            {move || if bulk_busy.get() { "Applying…" } else { "Apply" }}
                        </Button>
                        <Button variant="ghost" on_click=move || confirm_delete.set(true) disabled=bulk_busy
                            style="color: var(--color-negative)">
                            "Delete"
                        </Button>
                        <Button variant="ghost" on_click=move || selected.set(HashSet::new())
                            style="margin-left: auto">
                            "Clear"
                        </Button>
                    </div>
                })
            }}
        </div>
    };

    let empty_text = move |phone: bool| filters.with(|f| f.empty_text(total_count.get(), phone));

    let table = move || {
        let body = move || {
            if loading.get() && rows.with(Vec::is_empty) {
                return view! {
                    <tr>
                        <td colspan="6" style="padding: 24px; text-align: center">
                            <Spinner label="Loading transactions" />
                        </td>
                    </tr>
                }
                .into_any();
            }
            if rows.with(Vec::is_empty) {
                return view! {
                    <tr>
                        <td colspan="6" style="padding: 24px; text-align: center" class="text-muted">
                            {empty_text(false)}
                        </td>
                    </tr>
                }
                .into_any();
            }
            let cats = category_by_id.get();
            let names = account_name.get();
            rows.get()
                .into_iter()
                .map(|t| {
                    let category = t.category_id.as_ref().and_then(|id| cats.get(id)).cloned();
                    let id = t.id.clone();
                    let is_sel = {
                        let id = id.clone();
                        move || selected.with(|s| s.contains(&id))
                    };
                    let row_style = {
                        let is_sel = is_sel.clone();
                        move || {
                            let mut s = "border-top: 1px solid color-mix(in srgb, var(--color-text) 7%, transparent); cursor: pointer".to_string();
                            if is_sel() {
                                s.push_str("; background: color-mix(in srgb, var(--color-accent) 9%, transparent)");
                            }
                            s
                        }
                    };
                    let account = names.get(&t.account_id).cloned().unwrap_or_else(|| "—".into());
                    let amount_color = if t.amount_cents > 0 { "var(--color-positive)" } else { "var(--color-text)" };
                    let open = t.clone();
                    view! {
                        <tr class="txn-row" style=row_style on:click=move |_| editing.set(Some(Some(open.clone())))>
                            <td style="padding: 8px 0px 8px 16px" on:click=|e| e.stop_propagation()>
                                <input type="checkbox" aria-label=format!("Select {}", t.merchant_name)
                                    prop:checked=is_sel on:change=move |_| toggle_row(&id)
                                    style="cursor: pointer" />
                            </td>
                            <td style="padding: 8px 16px; color: var(--content-tertiary); white-space: nowrap">{t.posted_at.clone()}</td>
                            <td style="padding: 8px 16px; font-weight: 500">
                                {t.merchant_name.clone()}
                                {(t.is_transfer == Some(true)).then(|| view! {
                                    <span class="txn-transfer" title="Between your own accounts: not income or spending">"Transfer"</span>
                                })}
                            </td>
                            <td style="padding: 8px 16px"><CategoryPill category=category /></td>
                            <td style="padding: 8px 16px; color: var(--content-tertiary); white-space: nowrap">{account}</td>
                            <td style=format!("padding: 8px 16px; white-space: nowrap; text-align: right; font-weight: 600; color: {amount_color}")>
                                {fmt::cents_signed(t.amount_cents)}
                            </td>
                        </tr>
                    }
                })
                .collect_view()
                .into_any()
        };
        view! {
            <div class="panel panel-flush table-scroll">
                <table style="width: 100%; border-collapse: collapse; font-size: var(--text-sm)">
                    <thead>
                        <tr style="text-align: left">
                            <th style="width: 38px; padding: 10px 0px 10px 16px">
                                <input type="checkbox" aria-label="Select all shown"
                                    prop:checked=move || all_sel.get() on:change=move |_| toggle_all()
                                    style="cursor: pointer" />
                            </th>
                            <Th label="Date" />
                            <Th label="Merchant" />
                            <Th label="Category" />
                            <Th label="Account" />
                            <Th label="Amount" right=true />
                        </tr>
                    </thead>
                    <tbody>{body}</tbody>
                </table>
            </div>
        }
    };

    let phone_list = move || {
        if loading.get() && rows.with(Vec::is_empty) {
            return view! {
                <div class="panel" style="display: grid; place-items: center; padding: 24px">
                    <Spinner label="Loading transactions" />
                </div>
            }
            .into_any();
        }
        if rows.with(Vec::is_empty) {
            return view! {
                <div class="panel text-muted" style="padding: 24px; text-align: center">{empty_text(true)}</div>
            }
            .into_any();
        }
        let cats = category_by_id.get();
        let names = account_name.get();
        let today = fmt::today_local();
        let days = rows.with(|r| group_by_day(r));
        view! {
            <div style="display: flex; flex-direction: column; gap: 16px">
                {days.into_iter().map(|(day, items)| {
                    let label = match day_label(&day, today) {
                        DayLabel::Today => "Today".to_string(),
                        DayLabel::Yesterday => "Yesterday".to_string(),
                        DayLabel::Date { with_year } => fmt::weekday_month_day(&day, with_year),
                    };
                    let aria = label.clone();
                    view! {
                        <section aria-label=aria>
                            <div class="phone-list-head">{label}</div>
                            <div class="panel panel-flush">
                                {items.into_iter().map(|t| {
                                    let category = t.category_id.as_ref().and_then(|id| cats.get(id));
                                    let dot = category.map(|c| c.color.clone())
                                        .unwrap_or_else(|| "var(--color-neutral-600)".into());
                                    let kind = if t.is_transfer == Some(true) {
                                        "Transfer".to_string()
                                    } else {
                                        category.map(|c| c.name.clone()).unwrap_or_else(|| "Uncategorized".into())
                                    };
                                    let account = names.get(&t.account_id).cloned().unwrap_or_else(|| "—".into());
                                    let color = if t.amount_cents > 0 { "var(--color-positive)" } else { "var(--color-text)" };
                                    let (edit_t, del_t, open_t) = (t.clone(), t.clone(), t.clone());
                                    let actions = vec![
                                        SwipeAction {
                                            label: "Edit",
                                            danger: false,
                                            on_action: Callback::new(move |_| editing.set(Some(Some(edit_t.clone())))),
                                        },
                                        SwipeAction {
                                            label: "Delete",
                                            danger: true,
                                            on_action: Callback::new(move |_| deleting_one.set(Some(del_t.clone()))),
                                        },
                                    ];
                                    view! {
                                        <SwipeRow label=t.merchant_name.clone() actions=actions>
                                            <button type="button" class="phone-row"
                                                on:click=move |_| editing.set(Some(Some(open_t.clone())))>
                                                <span class="phone-row-main">
                                                    <span class="phone-row-title">{t.merchant_name.clone()}</span>
                                                    <span class="phone-row-sub">
                                                        <span aria-hidden="true" class="dot" style=format!("background: {dot}")></span>
                                                        {format!("{kind} · {account}")}
                                                    </span>
                                                </span>
                                                <span class="phone-row-amount num" style=format!("color: {color}")>
                                                    {fmt::cents_signed(t.amount_cents)}
                                                </span>
                                            </button>
                                        </SwipeRow>
                                    }
                                }).collect_view()}
                            </div>
                        </section>
                    }
                }).collect_view()}
            </div>
        }
        .into_any()
    };

    let net = move || sum_in.get() - sum_out.get();

    view! {
        <div class="page" style="gap: var(--space-4)">
            {toolbar}

            {move || autocat_msg.get().map(|m| view! {
                <div role="status" style="font-size: var(--text-sm); color: var(--content-secondary); background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-md); padding: 8px 12px">
                    {m}
                </div>
            })}

            <div class="grid">
                <div class="col-9">
                    {move || if phone.get() { phone_list().into_any() } else { table().into_any() }}
                    {move || next_cursor.with(Option::is_some).then(|| view! {
                        <div style="display: flex; justify-content: center; margin-top: 14px">
                            <Button variant="secondary" on_click=move || list.load_more()>"Load more"</Button>
                        </div>
                    })}
                </div>

                <div class="col-3">
                    <Panel title="Summary" subtitle=Signal::derive(move || period.get().label().to_string())
                        style="position: sticky; top: 96px">
                        <div style="display: flex; flex-direction: column; gap: 12px">
                            <div>
                                <div class="eyebrow">"Transactions"</div>
                                <div class="metric-value" style="font-size: var(--text-2xl)">
                                    {move || fmt::count(total_count.get())}
                                </div>
                            </div>
                            <div style="height: 1px; background: var(--hairline)"></div>
                            <SummaryRow label="Money in" value=Signal::derive(move || fmt::cents_whole(sum_in.get()))
                                color=Signal::derive(|| "var(--color-positive)") />
                            <SummaryRow label="Money out" value=Signal::derive(move || fmt::cents_whole(sum_out.get()))
                                color=Signal::derive(|| "var(--color-text)") />
                            <SummaryRow label="Net" strong=true
                                value=Signal::derive(move || {
                                    let n = net();
                                    format!("{}{}", if n >= 0 { "+" } else { "\u{2212}" }, fmt::cents_whole(n.abs()))
                                })
                                color=Signal::derive(move || if net() >= 0 { "var(--color-positive)" } else { "var(--color-negative)" }) />
                        </div>
                    </Panel>
                </div>
            </div>

            {move || deleting_one.get().map(|t| {
                let delete_one = delete_one.clone();
                let text = format!(
                    "{}, {} on {}. This can't be undone. Account balances aren't affected.",
                    t.merchant_name, fmt::cents_signed(t.amount_cents), t.posted_at
                );
                view! {
                    <Dialog title="Delete this transaction?".to_string() on_close=move |_| deleting_one.set(None)
                        actions=std::sync::Arc::new(move || {
                            let delete_one = delete_one.clone();
                            view! {
                                <Button variant="secondary" on_click=move || deleting_one.set(None) disabled=delete_busy>"Cancel"</Button>
                                <Button variant="primary" disabled=delete_busy style=DANGER_BTN on_click=move || delete_one()>
                                    {move || if delete_busy.get() {
                                        view! { <Spinner label="Deleting" /> }.into_any()
                                    } else {
                                        "Delete".into_any()
                                    }}
                                </Button>
                            }.into_any()
                        })>
                        {text.clone()}
                    </Dialog>
                }
            })}

            {move || confirm_delete.get().then(|| {
                let do_bulk_delete = do_bulk_delete.clone();
                view! {
                    <Dialog title=Signal::derive(move || bulk_delete_title(selected.with(HashSet::len)))
                        on_close=move |_| confirm_delete.set(false)
                        actions=std::sync::Arc::new(move || {
                            let do_bulk_delete = do_bulk_delete.clone();
                            view! {
                                <Button variant="secondary" on_click=move || confirm_delete.set(false) disabled=bulk_busy>"Cancel"</Button>
                                <Button variant="primary" on_click=move || do_bulk_delete() disabled=bulk_busy style=DANGER_BTN>
                                    {move || if bulk_busy.get() {
                                        view! { <Spinner label="Deleting" /> }.into_any()
                                    } else {
                                        "Delete".into_any()
                                    }}
                                </Button>
                            }.into_any()
                        })>
                        "This permanently removes the selected transactions. Account balances aren't affected."
                    </Dialog>
                }
            })}

            {move || editing.get().map(|t| view! {
                <TransactionDialog transaction=t accounts=open_accounts
                    categories=categories
                    on_close=move || editing.set(None)
                    on_saved=move || {
                        editing.set(None);
                        list.reload();
                    } />
            })}
            {move || importing.get().then(|| view! {
                <ImportDialog accounts=open_accounts
                    on_close=move || importing.set(false)
                    on_imported=move || {
                        importing.set(false);
                        list.reload();
                    } />
            })}
        </div>
    }
}

#[component]
fn SummaryRow(
    label: &'static str,
    value: Signal<String>,
    color: Signal<&'static str>,
    #[prop(optional)] strong: bool,
) -> impl IntoView {
    let (weight, size) = if strong { (700, 16) } else { (600, 14) };
    view! {
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px">
            <span style="font-size: var(--text-sm); color: var(--content-tertiary)">{label}</span>
            <span class="num" style=move || format!("font-weight: {weight}; font-size: {size}px; color: {}", color.get())>
                {move || value.get()}
            </span>
        </div>
    }
}

#[component]
fn Th(label: &'static str, #[prop(optional)] right: bool) -> impl IntoView {
    let align = if right { "right" } else { "left" };
    view! {
        <th style=format!("padding: 10px 16px; font-size: var(--text-2xs); letter-spacing: .05em; text-transform: uppercase; color: var(--content-tertiary); text-align: {align}; font-weight: 600")>
            {label}
        </th>
    }
}

#[component]
fn CategoryPill(category: Option<Category>) -> impl IntoView {
    let bg = match &category {
        Some(c) => format!("color-mix(in srgb, {} 16%, transparent)", c.color),
        None => "color-mix(in srgb, var(--color-text) 7%, transparent)".into(),
    };
    let dot = category
        .as_ref()
        .map(|c| c.color.clone())
        .unwrap_or_else(|| "var(--color-neutral-600)".into());
    let name = category
        .map(|c| c.name)
        .unwrap_or_else(|| "Uncategorized".into());
    view! {
        <span style=format!("display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); padding: 2px 9px; border-radius: 99px; background: {bg}; color: var(--color-text); white-space: nowrap")>
            <span aria-hidden="true" style=format!("width: 6px; height: 6px; border-radius: 50%; background: {dot}")></span>
            {name}
        </span>
    }
}

/// A checkbox row in the dialog (`label.radio` with a hint under the text).
fn check_row(
    checked: RwSignal<bool>,
    text: impl IntoView + 'static,
    hint: &'static str,
) -> impl IntoView {
    view! {
        <label class="radio" style="align-items: flex-start; gap: var(--space-2)">
            <input type="checkbox" prop:checked=move || checked.get()
                on:change=move |e| checked.set(event_target_checked(&e))
                style="position: static; opacity: 1; width: 16px; height: 16px; margin-top: 2px" />
            <span>
                <span class="t-sm">{text}</span>
                <span class="field-hint" style="display: block">{hint}</span>
            </span>
        </label>
    }
}

#[component]
fn TransactionDialog(
    transaction: Option<Transaction>,
    accounts: Signal<Vec<Account>>,
    categories: RwSignal<Vec<Category>>,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_saved: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let init = TxnForm::new(
        transaction.as_ref(),
        accounts
            .with_untracked(|a| a.first().map(|a| a.id.clone()))
            .as_deref(),
        &fmt::today_utc(),
    );
    let account_id = RwSignal::new(init.account_id);
    let category_id = RwSignal::new(init.category_id);
    let posted_at = RwSignal::new(init.posted_at);
    let merchant = RwSignal::new(init.merchant);
    let amount = RwSignal::new(init.amount);
    let notes = RwSignal::new(init.notes);
    let is_transfer = RwSignal::new(init.is_transfer);
    // Offered only when you're actually filing something that wasn't filed
    // before — that's the moment the rule is worth creating.
    let also_rule = RwSignal::new(false);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let original = StoredValue::new(transaction.clone());
    let editing = transaction.is_some();

    let form = move || TxnForm {
        account_id: account_id.get(),
        category_id: category_id.get(),
        posted_at: posted_at.get(),
        merchant: merchant.get(),
        amount: amount.get(),
        notes: notes.get(),
        is_transfer: is_transfer.get(),
        also_rule: also_rule.get(),
    };
    let valid = Memo::new(move |_| form().valid(editing));
    let categorizing_fresh =
        Memo::new(move |_| original.with_value(|o| form().categorizing_fresh(o.as_ref())));

    let save = {
        let host = host.clone();
        move || {
            if !valid.get_untracked() || busy.get_untracked() {
                return;
            }
            busy.set(true);
            error.set(None);
            let f = untrack(form);
            let original = original.get_value();
            let host = host.clone();
            spawn_local(async move {
                let saved = match &original {
                    Some(t) => {
                        let body = HostCtx::arg(&f.update_body(t));
                        host.try_call::<IgnoredAny>(
                            "updateTransaction",
                            &[JsValue::from_str(&t.id), body],
                        )
                        .await
                    }
                    None => {
                        let body = HostCtx::arg(&f.create_body());
                        host.try_call::<IgnoredAny>("createTransaction", &[body])
                            .await
                    }
                };
                match saved {
                    Ok(_) => {
                        // Turn this one-off correction into a standing rule, so the
                        // same merchant files itself on every future import.
                        // Non-fatal: the transaction is already saved.
                        if let Some((keyword, category_id)) = f.rule() {
                            let body = CreateRuleRequest {
                                keyword,
                                category_id,
                                priority: None,
                            };
                            let _ = host
                                .call::<IgnoredAny>(
                                    "createCategorizationRule",
                                    &[HostCtx::arg(&body)],
                                )
                                .await;
                        }
                        if busy.try_get_untracked().is_some() {
                            on_saved.run(());
                        }
                    }
                    Err(e) => {
                        error.try_set(Some(e.message_or("Something went wrong.")));
                        busy.try_set(false);
                    }
                }
            });
        }
    };
    let remove = {
        let host = host.clone();
        move || {
            let Some(t) = original.get_value() else {
                return;
            };
            if busy.get_untracked() {
                return;
            }
            busy.set(true);
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<IgnoredAny>("deleteTransaction", &[JsValue::from_str(&t.id)])
                    .await
                {
                    Ok(_) => {
                        if busy.try_get_untracked().is_some() {
                            on_saved.run(());
                        }
                    }
                    Err(e) => {
                        error.try_set(Some(e.message_or("Something went wrong.")));
                        busy.try_set(false);
                    }
                }
            });
        }
    };

    let account_options = Signal::derive(move || {
        accounts.with(|a| {
            a.iter()
                .map(|a| SelectOption::new(a.id.clone(), a.name.clone()))
                .collect::<Vec<_>>()
        })
    });
    let category_options = Signal::derive(move || {
        std::iter::once(SelectOption::new("", "Uncategorized"))
            .chain(
                categories
                    .get()
                    .into_iter()
                    .map(|c| SelectOption::new(c.id, c.name)),
            )
            .collect::<Vec<_>>()
    });
    let amount_error = Signal::derive(move || {
        amount.with(|a| {
            TxnForm {
                amount: a.clone(),
                ..Default::default()
            }
            .amount_error()
            .map(str::to_string)
        })
    });
    let title = if editing {
        "Edit transaction"
    } else {
        "Add transaction"
    };

    view! {
        <Dialog title=title.to_string() on_close=move |_| on_close.run(())
            actions=std::sync::Arc::new(move || {
                let (save, remove) = (save.clone(), remove.clone());
                view! {
                    {editing.then(|| view! {
                        <Button variant="ghost" on_click=move || remove() disabled=busy>"Delete"</Button>
                    })}
                    <Button variant="secondary" on_click=move || on_close.run(()) disabled=busy>"Cancel"</Button>
                    <Button variant="primary" on_click=move || save()
                        disabled=Signal::derive(move || !valid.get() || busy.get())>
                        {move || if busy.get() {
                            view! { <Spinner label="Saving" /> }.into_any()
                        } else {
                            "Save".into_any()
                        }}
                    </Button>
                }.into_any()
            })>
            <div style="display: flex; flex-direction: column; gap: 12px">
                {(!editing).then(|| view! {
                    <Select label="Account" value=account_id options=account_options />
                })}
                <Field label="Merchant" value=merchant autofocus=!editing placeholder="Fresh Market" />
                <div style="display: flex; gap: 10px">
                    <div style="flex: 1">
                        <Field label="Amount" value=amount input_mode="decimal" placeholder="-42.50"
                            error=amount_error
                            hint=Signal::derive(|| "Negative = money out, positive = money in.".to_string()) />
                    </div>
                    <div style="width: 180px">
                        <DateField label="Date" value=posted_at clearable=false />
                    </div>
                </div>
                <Select label="Category" value=category_id options=category_options />
                {move || categorizing_fresh.get().then(|| check_row(
                    also_rule,
                    move || {
                        let m = merchant.get();
                        TxnForm { merchant: m, ..Default::default() }.rule_label()
                    },
                    "Creates a rule so future imports categorize it automatically.",
                ))}
                <Field label="Notes (optional)" value=notes />
                {editing.then(|| check_row(
                    is_transfer,
                    "Transfer between my accounts",
                    "Not counted as income or spending. Found automatically when both sides are here; change it if it's wrong.",
                ))}
                {move || error.get().map(|e| view! {
                    <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
                })}
            </div>
        </Dialog>
    }
}

#[component]
fn ImportDialog(
    accounts: Signal<Vec<Account>>,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_imported: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let account_id = RwSignal::new(
        accounts
            .with_untracked(|a| a.first().map(|a| a.id.clone()))
            .unwrap_or_default(),
    );
    let file_name = RwSignal::new(None::<String>);
    let csv_text = RwSignal::new(None::<String>);
    let busy = RwSignal::new(false);
    let result = RwSignal::new(None::<ImportResponse>);
    let error = RwSignal::new(None::<String>);
    let file_ref = NodeRef::<html::Input>::new();

    let pick = move |file: web_sys::File| {
        file_name.set(Some(file.name()));
        result.set(None);
        error.set(None);
        spawn_local(async move {
            if let Ok(text) = JsFuture::from(file.text()).await {
                if let Some(text) = text.as_string() {
                    csv_text.try_set(Some(text));
                }
            }
        });
    };
    let can_import = Signal::derive(move || {
        csv_text.with(Option::is_some) && !account_id.with(String::is_empty) && !busy.get()
    });
    let do_import = move || {
        if !can_import.get_untracked() {
            return;
        }
        let (Some(csv), acc) = (csv_text.get_untracked(), account_id.get_untracked()) else {
            return;
        };
        busy.set(true);
        error.set(None);
        let host = host.clone();
        spawn_local(async move {
            match host
                .try_call::<ImportResponse>(
                    "importTransactions",
                    &[JsValue::from_str(&acc), JsValue::from_str(&csv)],
                )
                .await
            {
                Ok(r) => {
                    result.try_set(Some(r));
                }
                Err(e) => {
                    error.try_set(Some(e.message_or("Import failed.")));
                }
            }
            busy.try_set(false);
        });
    };

    let account_options = Signal::derive(move || {
        accounts.with(|a| {
            a.iter()
                .map(|a| SelectOption::new(a.id.clone(), a.name.clone()))
                .collect::<Vec<_>>()
        })
    });

    view! {
        <Dialog title="Import transactions from CSV".to_string() on_close=move |_| on_close.run(())
            actions=std::sync::Arc::new(move || {
                let do_import = do_import.clone();
                view! {
                    {move || if result.with(Option::is_some) {
                        view! {
                            <Button variant="primary" on_click=move || on_imported.run(())>"Done"</Button>
                        }.into_any()
                    } else {
                        let do_import = do_import.clone();
                        view! {
                            <Button variant="secondary" on_click=move || on_close.run(()) disabled=busy>"Cancel"</Button>
                            <Button variant="primary" on_click=move || do_import()
                                disabled=Signal::derive(move || !can_import.get())>
                                {move || if busy.get() {
                                    view! { <Spinner label="Importing" /> }.into_any()
                                } else {
                                    "Import".into_any()
                                }}
                            </Button>
                        }.into_any()
                    }}
                }.into_any()
            })>
            <div style="display: flex; flex-direction: column; gap: 12px">
                <Select label="Into account" value=account_id options=account_options />
                <input node_ref=file_ref type="file" accept=".csv,text/csv" style="display: none"
                    on:change=move |e| {
                        let input: web_sys::HtmlInputElement = event_target(&e);
                        if let Some(file) = input.files().and_then(|f| f.get(0)) {
                            pick(file);
                        }
                    } />
                <Button variant="secondary" on_click=move || {
                    if let Some(input) = file_ref.get_untracked() {
                        input.click();
                    }
                }>
                    {move || file_name.get().unwrap_or_else(|| "Choose CSV file…".into())}
                </Button>
                <p class="text-muted" style="font-size: var(--text-xs); margin: 0px; line-height: 1.6">
                    "Needs columns: "<code>"date"</code>", "<code>"merchant"</code>" (or payee/name), "
                    <code>"amount"</code>". Optional: "<code>"category"</code>", "<code>"description"</code>", "
                    <code>"external_id"</code>". Re-importing the same file won't create duplicates."
                </p>
                {move || result.get().map(|r| view! {
                    <div style="font-size: var(--text-sm); line-height: 1.7" role="status">
                        "✓ Imported "<strong>{r.imported}</strong>
                        {r.skipped_text()}
                        {r.errors_text().map(|t| view! { <div style="color: var(--color-negative)">{t}</div> })}
                    </div>
                })}
                {move || error.get().map(|e| view! {
                    <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
                })}
            </div>
        </Dialog>
    }
}
