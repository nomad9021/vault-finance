//! Income: port of apps/desktop/src/screens/shell/IncomePage.tsx.
//!
//! Income-kind categories are the "sources" (Salary, Side Income, Gifts…);
//! every income transaction can be assigned to one, the totals link through
//! to the transactions behind them, and sources are created, renamed and
//! reordered here.

use std::collections::HashMap;

use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::accounts::AccountListResponse;
use vault_core::categories::{
    Category, CategoryKind, CategoryListResponse, CreateCategoryBody, RenameCategoryBody,
};
use vault_core::dates::Month;
use vault_core::goals::trim_js;
use vault_core::income::{
    income_items, month_bounds, next_source_color, short_date, sources, IncomeTotals,
};
use vault_core::nav::NavFilter;
use vault_core::transactions::{
    SetCategoryBody, Transaction, TransactionListResponse, TransactionQuery,
};
use wasm_bindgen::JsValue;

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{Button, Card, Spinner};

const ROW_RULE: &str = "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)";
const ICON_BTN: &str = "border: 0px; background: none; cursor: pointer; color: var(--content-tertiary); font: inherit; font-size: var(--text-base); padding: 0px 3px";

/// `new Date().toISOString().slice(0, 7)`: this month, in UTC.
fn current_month() -> Month {
    let today: String = String::from(js_sys::Date::new_0().to_iso_string())
        .chars()
        .take(10)
        .collect();
    Month::of(&today, &today)
}

/// `a.localeCompare(b)`.
fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    js_sys::JsString::from(a)
        .locale_compare(b, &js_sys::Array::new(), &js_sys::Object::new())
        .cmp(&0)
}

/// What the mutations need, `Copy` so every handler can hold one.
#[derive(Clone, Copy)]
struct Actions {
    host: StoredValue<HostCtx>,
    busy: RwSignal<bool>,
    error: RwSignal<Option<String>>,
    cats_version: RwSignal<u32>,
    txns_version: RwSignal<u32>,
}

impl Actions {
    /// `run(fn, msg)`: one request at a time, `msg` if it fails, then reload.
    fn run(
        self,
        method: &'static str,
        args: Vec<JsValue>,
        msg: &'static str,
        reload: RwSignal<u32>,
    ) {
        self.busy.set(true);
        self.error.set(None);
        let host = self.host.get_value();
        spawn_local(async move {
            match host.call::<IgnoredAny>(method, &args).await {
                Ok(_) => reload.update(|v| *v += 1),
                Err(_) => self.error.set(Some(msg.to_string())),
            }
            self.busy.set(false);
        });
    }

    fn add_source(self, existing: usize) {
        let body = CreateCategoryBody {
            name: "New source".into(),
            color: next_source_color(existing).into(),
            kind: CategoryKind::Income,
        };
        self.run(
            "createCategory",
            vec![HostCtx::arg(&body)],
            "Couldn't add the source.",
            self.cats_version,
        );
    }

    fn rename(self, id: String, name: String) {
        self.run(
            "updateCategory",
            vec![id.into(), HostCtx::arg(&RenameCategoryBody { name })],
            "Couldn't rename.",
            self.cats_version,
        );
    }

    fn remove(self, id: String) {
        self.run(
            "deleteCategory",
            vec![id.into()],
            "That source is in use — reassign its income first.",
            self.cats_version,
        );
    }

    fn move_source(self, id: String, direction: &'static str) {
        self.run(
            "moveCategory",
            vec![id.into(), direction.into()],
            "Couldn't reorder.",
            self.cats_version,
        );
    }

    fn assign(self, txn_id: String, category_id: String) {
        let body = SetCategoryBody {
            category_id: (!category_id.is_empty()).then_some(category_id),
        };
        self.run(
            "updateTransaction",
            vec![txn_id.into(), HostCtx::arg(&body)],
            "Couldn't assign that income.",
            self.txns_version,
        );
    }

    fn navigate(self, category_id: &str) {
        let filter = NavFilter {
            category_id: Some(category_id.to_string()),
            ..Default::default()
        };
        self.host
            .with_value(|h| h.navigate("transactions", &filter));
    }
}

#[component]
pub fn IncomePage() -> impl IntoView {
    let host = use_host();
    let data_version = host.data_version;
    let month = RwSignal::new(current_month());
    let actions = Actions {
        host: StoredValue::new(host),
        busy: RwSignal::new(false),
        error: RwSignal::new(None),
        cats_version: RwSignal::new(0),
        txns_version: RwSignal::new(0),
    };
    let (cats_version, txns_version) = (actions.cats_version, actions.txns_version);

    let cats = LocalResource::new(move || {
        data_version.track();
        cats_version.track();
        let host = use_host();
        async move { host.call::<CategoryListResponse>("categories", &[]).await }
    });
    let txns = LocalResource::new(move || {
        data_version.track();
        txns_version.track();
        let (from, to) = month_bounds(month.get());
        let host = use_host();
        async move {
            let query = TransactionQuery {
                from: Some(from),
                to: Some(to),
                limit: Some(200),
            };
            host.call::<TransactionListResponse>("transactions", &[HostCtx::arg(&query)])
                .await
        }
    });
    let accts = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move {
            host.call::<AccountListResponse>("accounts", &[JsValue::TRUE])
                .await
        }
    });

    // useData keeps the last data while it refetches; a failed load is null.
    let sources = Memo::new(move |_| {
        let cats = cats
            .get()
            .and_then(Result::ok)
            .map(|r| r.categories)
            .unwrap_or_default();
        sources(&cats, locale_cmp)
    });
    let items = Memo::new(move |_| {
        txns.get()
            .and_then(Result::ok)
            .map(|r| income_items(&r.transactions))
            .unwrap_or_default()
    });
    let totals = Memo::new(move |_| sources.with(|s| items.with(|i| IncomeTotals::new(s, i))));
    let account_names = Memo::new(move |_| {
        accts
            .get()
            .and_then(Result::ok)
            .map(|r| r.accounts.into_iter().map(|a| (a.id, a.name)).collect())
            .unwrap_or_else(HashMap::<String, String>::new)
    });
    let label = Memo::new(move |_| fmt::month_long_year(month.get()));
    // Only the first load shows the spinner (`loading && !txnData`).
    let loaded = Memo::new(move |_| txns.with(|t| t.is_some()));

    let page = move || {
        view! {
            <div class="page">
                <div style="display: flex; align-items: center; gap: 8px">
                    <Button variant="ghost" aria_label="Previous month"
                        on_click=move || month.update(|m| *m = m.shift(-1))>"‹"</Button>
                    <div style="font-family: var(--font-heading); font-weight: 600; font-size: var(--text-md); min-width: 150px; text-align: center">
                        {label}
                    </div>
                    <Button variant="ghost" aria_label="Next month"
                        on_click=move || month.update(|m| *m = m.shift(1))>"›"</Button>
                    <div style="margin-left: auto; text-align: right">
                        <div style="font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: .04em; color: var(--content-tertiary); font-weight: 600">
                            "Total income"
                        </div>
                        <div style="font-family: var(--font-heading); font-weight: 600; font-size: var(--text-2xl); color: var(--color-positive)">
                            {move || fmt::cents_whole(totals.with(|t| t.total_cents))}
                        </div>
                    </div>
                </div>

                <Card kicker="Income" title="By source">
                    <p class="card-meta">
                        "Each source is an income category — rename them to match your world (a person’s job, a side gig, gifts). Totals link straight to the transactions behind them."
                    </p>
                    <div style="display: flex; flex-direction: column; margin-top: 6px">
                        {move || {
                            let list = sources.get();
                            let t = totals.get();
                            if list.is_empty() && t.other_cents == 0 {
                                return view! { <p class="card-meta">"No income this month."</p> }.into_any();
                            }
                            let other = t.other_cents;
                            view! {
                                {list.into_iter().map(|s| {
                                    let cents = t.source(&s.id);
                                    view! {
                                        <SourceRow name=s.name color=s.color cents=cents
                                            on_view=move || actions.navigate(&s.id) />
                                    }
                                }).collect_view()}
                                {(other > 0).then(|| view! {
                                    <SourceRow name="Other income (unassigned)".to_string() color="#9aa0ab".to_string()
                                        cents=other on_view=move || actions.navigate("none") />
                                })}
                            }
                            .into_any()
                        }}
                    </div>
                </Card>

                <Card kicker="This month" title="Income items">
                    {move || {
                        let list = items.get();
                        if list.is_empty() {
                            return view! {
                                <p class="card-meta">"No income recorded for "{label.get()}"."</p>
                            }
                            .into_any();
                        }
                        let opts = sources.get();
                        let names = account_names.get();
                        view! {
                            <div style="display: flex; flex-direction: column; gap: 2px; margin-top: 4px">
                                {list.into_iter().map(|t| {
                                    let account = names.get(&t.account_id).cloned().unwrap_or_else(|| "—".into());
                                    view! { <IncomeItem txn=t account_name=account sources=opts.clone() actions=actions /> }
                                }).collect_view()}
                            </div>
                        }
                        .into_any()
                    }}
                </Card>

                <Card kicker="Sources" title="Manage income sources">
                    <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 4px">
                        <For
                            each=move || {
                                let list = sources.get();
                                let n = list.len();
                                list.into_iter().enumerate().map(move |(i, s)| (i == 0, i + 1 == n, s)).collect::<Vec<_>>()
                            }
                            // Re-made when what it shows changes; kept (with any
                            // rename in progress) across refetches that change nothing.
                            key=|(first, last, s)| (s.id.clone(), s.name.clone(), s.color.clone(), *first, *last)
                            children=move |(first, last, s)| view! {
                                <ManageRow source=s is_first=first is_last=last actions=actions />
                            }
                        />
                    </div>
                    <div style="margin-top: 10px">
                        <Button variant="secondary" disabled=actions.busy
                            on_click=move || actions.add_source(sources.with_untracked(Vec::len))>
                            "＋ Add income source"
                        </Button>
                    </div>
                    {move || actions.error.get().map(|e| view! {
                        <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative); margin-top: 8px">
                            {e}
                        </div>
                    })}
                </Card>
            </div>
        }
    };

    move || {
        if loaded.get() {
            page().into_any()
        } else {
            view! { <Spinner label="Loading income" /> }.into_any()
        }
    }
}

#[component]
fn SourceRow(
    name: String,
    color: String,
    cents: i64,
    on_view: impl Fn() + 'static,
) -> impl IntoView {
    let style = format!(
        "display: flex; align-items: center; gap: 10px; padding: 9px 4px; border-top: {ROW_RULE}; background: none; border: 0px; border-top-style: solid; font: inherit; color: inherit; cursor: pointer; text-align: left; width: 100%"
    );
    view! {
        <button on:click=move |_| on_view() title="View this source's transactions" style=style>
            <span aria-hidden="true"
                style=format!("width: 10px; height: 10px; border-radius: var(--radius-sm); background: {color}; flex: none")>
            </span>
            <span style="flex: 1; min-width: 0px; font-weight: 500; font-size: var(--text-base)">{name}</span>
            <span style="font-weight: 600; font-size: var(--text-base); color: var(--color-positive)">
                {fmt::cents_whole(cents)}
            </span>
            <span style="font-size: var(--text-xs); color: var(--content-tertiary)">"→"</span>
        </button>
    }
}

#[component]
fn IncomeItem(
    txn: Transaction,
    account_name: String,
    sources: Vec<Category>,
    actions: Actions,
) -> impl IntoView {
    let current = txn.category_id.clone().unwrap_or_default();
    let id = txn.id.clone();
    let on_change = {
        let current = current.clone();
        move |e: leptos::ev::Event| {
            let el = event_target::<web_sys::HtmlSelectElement>(&e);
            let picked = el.value();
            // Controlled like React's: show the saved value until the reload.
            el.set_value(&current);
            actions.assign(id.clone(), picked);
        }
    };
    view! {
        <div style=format!("display: flex; align-items: center; gap: 10px; padding: 8px 0px; border-top: {ROW_RULE}; font-size: var(--text-sm)")>
            <span style="color: var(--content-tertiary); flex: none; width: 44px">
                {short_date(&txn.posted_at).to_string()}
            </span>
            <div style="flex: 1; min-width: 0px">
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                    {txn.merchant_name.clone()}
                </div>
                <div style="font-size: var(--text-xs); color: var(--content-tertiary)">{account_name}</div>
            </div>
            <select class="input" aria-label="Income source" disabled=move || actions.busy.get()
                style="width: 150px; font-size: var(--text-sm)" on:change=on_change>
                <option value="" prop:selected=current.is_empty()>"Unassigned"</option>
                {sources.into_iter().map(|s| {
                    let selected = s.id == current;
                    view! { <option value=s.id prop:selected=selected>{s.name}</option> }
                }).collect_view()}
            </select>
            <span style="font-weight: 600; white-space: nowrap; color: var(--color-positive); width: 88px; text-align: right">
                {fmt::cents_signed(txn.amount_cents)}
            </span>
        </div>
    }
}

#[component]
fn ManageRow(source: Category, is_first: bool, is_last: bool, actions: Actions) -> impl IntoView {
    let editing = RwSignal::new(false);
    let draft = RwSignal::new(source.name.clone());
    let input = NodeRef::<html::Input>::new();
    // autoFocus.
    Effect::new(move || {
        if let Some(el) = input.get() {
            let _ = el.focus();
        }
    });
    let Category {
        id, name, color, ..
    } = source;
    let name = StoredValue::new(name);
    let id = StoredValue::new(id);

    let commit = move || {
        editing.set(false);
        let d = draft.get_untracked();
        let t = trim_js(&d);
        if !t.is_empty() && name.with_value(|n| t != n) {
            actions.rename(id.get_value(), t.to_string());
        }
    };
    let name_or_input = move || {
        if editing.get() {
            view! {
                <input node_ref=input class="input" prop:value=move || draft.get()
                    on:input=move |e| draft.set(event_target_value(&e))
                    on:blur=move |_| commit()
                    on:keydown=move |e| {
                        if e.key() == "Enter" {
                            if let Some(el) = input.get_untracked() {
                                let _ = el.blur();
                            }
                        }
                        if e.key() == "Escape" {
                            draft.set(name.get_value());
                            editing.set(false);
                        }
                    }
                    style="width: 180px; padding: 2px 6px; font-size: var(--text-sm)" />
            }
            .into_any()
        } else {
            view! {
                <button title="Rename"
                    on:click=move |_| {
                        draft.set(name.get_value());
                        editing.set(true);
                    }
                    style="background: none; border: 0px; font: inherit; font-weight: 600; font-size: var(--text-sm); cursor: text; color: var(--color-text); flex: 1; text-align: left">
                    {name.get_value()}
                </button>
            }
            .into_any()
        }
    };
    let dim = |off: bool| format!("{ICON_BTN}; opacity: {}", if off { "0.25" } else { "1" });
    view! {
        <div style="display: flex; align-items: center; gap: 8px; padding: 6px 9px; border: 1px solid var(--color-divider); border-radius: var(--radius-md); background: var(--color-surface)">
            <span style=format!("width: 10px; height: 10px; border-radius: var(--radius-sm); background: {color}; flex: none")></span>
            {name_or_input}
            <button title="Move up" disabled=is_first style=dim(is_first)
                on:click=move |_| actions.move_source(id.get_value(), "up")>"▲"</button>
            <button title="Move down" disabled=is_last style=dim(is_last)
                on:click=move |_| actions.move_source(id.get_value(), "down")>"▼"</button>
            <button title="Delete" disabled=move || actions.busy.get()
                style=format!("{ICON_BTN}; color: var(--color-negative)")
                on:click=move |_| actions.remove(id.get_value())>"×"</button>
        </div>
    }
}
