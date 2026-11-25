//! Budgets: port of apps/desktop/src/screens/shell/BudgetsPage.tsx, with the
//! Budget vs actual tab (BudgetVsActualPage.tsx) in [`vs_actual`] and the
//! Planner tab (BudgetPlannerPage.tsx) in [`planner`].
//!
//! Budgets and the budget planner were two sidebar entries that nobody could
//! tell apart. They're the same subject at two time horizons — what you've
//! spent this month, and how you intend to divide a month's income — so
//! they're one destination with tabs, plus the two laid over each other on one
//! Sankey.

use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::budget_period::{
    available_categories, bar_fill, budget_amount, month_parts, month_summary, period_figures,
    shift_month, weekly_to_monthly, CreateBudgetBody, UpdateBudgetBody,
};
use vault_core::budgets::{BudgetListResponse, BudgetPeriod, BudgetWithSpend};
use vault_core::categories::{Category, CategoryListResponse};
use vault_core::dates::Month;
use vault_core::money::{cents_to_fixed2, parse_amount_to_cents};
use vault_core::nav::NavFilter;
use wasm_bindgen::JsValue;

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{
    Button, Dialog, EmptyState, Field, Panel, Segmented, Select, SelectOption, SkeletonList,
    Spinner, Tabs, Tag,
};

#[path = "budgets_planner.rs"]
mod planner;
#[path = "budgets_vs_actual.rs"]
mod vs_actual;

const TABS: &[(&str, &str)] = &[
    ("budgets", "This month"),
    ("compare", "Budget vs actual"),
    ("planner", "Planner"),
];

/// lib/spreadsheet.ts `SPREADSHEET_ACCEPT`.
pub const SPREADSHEET_ACCEPT: &str = ".csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

#[component]
pub fn BudgetsPage() -> impl IntoView {
    let host = use_host();
    let tab = RwSignal::new(match host.filter.tab.as_deref() {
        Some("planner") => "planner",
        Some("compare") => "compare",
        _ => "budgets",
    });
    view! {
        <div class="page">
            <Tabs items=TABS value=tab aria_label="Budget views" />
            {move || match tab.get() {
                "budgets" => view! { <BudgetsTab /> }.into_any(),
                "compare" => view! { <vs_actual::BudgetVsActualPage /> }.into_any(),
                _ => view! { <planner::BudgetPlannerPage /> }.into_any(),
            }}
        </div>
    }
}

/// `new Date().toISOString().slice(0, 7)`: this month in UTC.
pub(crate) fn current_month() -> String {
    String::from(js_sys::Date::new_0().to_iso_string())
        .chars()
        .take(7)
        .collect()
}

/// "November 2026".
pub(crate) fn month_label(month: &str) -> String {
    let (year, month) = month_parts(month);
    fmt::month_long_year(Month { year, month })
}

/// The last data a resource loaded, kept through refetches and failures
/// (useData's `data`, which only a successful load replaces).
pub(crate) fn last_ok<T: Clone + PartialEq + Send + Sync + 'static>(
    res: LocalResource<Result<T, String>>,
) -> Memo<Option<T>> {
    Memo::new(move |prev: Option<&Option<T>>| match res.get() {
        Some(Ok(v)) => Some(v),
        _ => prev.cloned().flatten(),
    })
}

/// `null` = closed; `Some(None)` = adding; `Some(Some(budget))` = editing.
type Editing = Option<Option<BudgetWithSpend>>;

#[component]
fn BudgetsTab() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let month = RwSignal::new(current_month());
    let week_start = Memo::new(move |_| app.with(|a| a.review_prefs.week_starts_on.clone()));
    let data_version = host.data_version;
    // Bumped after a save or delete, like useData's reload().
    let version = RwSignal::new(0_u32);
    let res = LocalResource::new(move || {
        data_version.track();
        version.track();
        let (m, w) = (month.get(), week_start.get());
        let host = use_host();
        async move {
            host.call::<BudgetListResponse>("budgets", &[m.into(), w.into()])
                .await
        }
    });
    let data = last_ok(res);
    let loading = Signal::derive(move || res.get().is_none());
    let cat_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move { host.call::<CategoryListResponse>("categories", &[]).await }
    });
    let categories = Signal::derive(move || {
        last_ok_value(cat_res)
            .map(|r| r.categories)
            .unwrap_or_default()
    });

    let editing = RwSignal::new(None::<Option<BudgetWithSpend>>);

    // Bring an existing budget over from a spreadsheet: the assistant reads it
    // and proposes the categories and budgets, which you approve.
    let ai_visible = Memo::new(move |_| app.with(|a| a.ai_visible));
    let file_ref = NodeRef::<html::Input>::new();
    let import_error = RwSignal::new(None::<String>);
    let import_sheet = {
        let host = host.clone();
        move |file: web_sys::File| {
            import_error.set(None);
            let host = host.clone();
            spawn_local(async move {
                match host.read_spreadsheet(&file).await {
                    Ok(sheet) => host.ask_assistant(
                        &format!("Import the budget in this spreadsheet ({}).", sheet.name),
                        &sheet,
                    ),
                    Err(msg) => import_error.set(Some(msg)),
                }
            });
        }
    };

    let budgets = Signal::derive(move || data.get().map(|d| d.budgets).unwrap_or_default());
    let total_budgeted =
        Signal::derive(move || data.with(|d| d.as_ref().map_or(0, |d| d.total_budgeted_cents)));
    let total_spent =
        Signal::derive(move || data.with(|d| d.as_ref().map_or(0, |d| d.total_spent_cents)));
    let summary = Signal::derive(move || month_summary(total_budgeted.get(), total_spent.get()));
    let label = Signal::derive(move || month_label(&month.get()));

    let add = move || editing.set(Some(None));

    // Memos, so the list below is only rebuilt when it switches between
    // skeleton, empty state and bars.
    let show_skeleton = Memo::new(move |_| loading.get() && data.with(Option::is_none));
    let is_empty = Memo::new(move |_| budgets.with(Vec::is_empty));
    let list = move || {
        if show_skeleton.get() {
            return view! { <SkeletonList rows=4 height=52 /> }.into_any();
        }
        if is_empty.get() {
            return view! {
                <EmptyState compact=true icon="target"
                    title=format!("No budgets for {}", label.get())
                    body="Add one to track spending against a weekly or monthly limit."
                    action=view! { <Button variant="primary" icon="plus" on_click=add>"Add budget"</Button> }.into_any() />
            }
            .into_any();
        }
        // Keyed like React's `key={b.id}`, plus what the bar shows, so a
        // refetch keeps unchanged bars (and their grow animation) in place.
        view! {
            <For each=move || {
                    let cats = categories.get();
                    budgets.get().into_iter().map(|b| {
                        let category = cats.iter().find(|c| c.id == b.category_id).cloned();
                        (b, category)
                    }).collect::<Vec<_>>()
                }
                key=|(b, c)| format!("{}|{:?}|{}|{}|{:?}|{:?}|{:?}|{:?}",
                    b.id, b.period, b.amount_cents, b.spent_cents, b.period_amount_cents,
                    b.period_spent_cents, c.as_ref().map(|c| &c.name), c.as_ref().map(|c| &c.color))
                children=move |(b, category)| view! { <BudgetBar budget=b category=category editing=editing /> } />
        }
        .into_any()
    };

    view! {
        <div class="page" style="max-width: 920px">
            // Month switcher and actions; on a phone the buttons drop to their own line.
            <div class="row wrap" style="gap: var(--space-2)">
                <div class="row" style="gap: var(--space-1); flex: 1 0 auto">
                    <Button variant="ghost" icon="chevronLeft" aria_label="Previous month"
                        on_click=move || month.update(|m| *m = shift_month(m, -1)) />
                    <span class="t-md t-semibold"
                        style="min-width: 140px; text-align: center; font-family: var(--font-heading)">
                        {label}
                    </span>
                    <Button variant="ghost" icon="chevronRight" aria_label="Next month"
                        on_click=move || month.update(|m| *m = shift_month(m, 1)) />
                </div>
                <div class="row" style="gap: var(--space-2); margin-left: auto">
                    {move || ai_visible.get().then(|| {
                        let import_sheet = import_sheet.clone();
                        view! {
                            <input node_ref=file_ref type="file" accept=SPREADSHEET_ACCEPT style="display: none"
                                on:change=move |e| {
                                    let input: web_sys::HtmlInputElement = event_target(&e);
                                    if let Some(file) = input.files().and_then(|f| f.get(0)) {
                                        import_sheet(file);
                                    }
                                    input.set_value("");
                                } />
                            <Button variant="secondary" icon="upload"
                                title="Import an existing budget from a CSV or Excel file — the assistant sets it up"
                                on_click=move || {
                                    if let Some(input) = file_ref.get_untracked() {
                                        input.click();
                                    }
                                }>
                                "Import"
                            </Button>
                        }
                    })}
                    <Button variant="primary" icon="plus" on_click=add>"Add budget"</Button>
                </div>
            </div>
            {move || import_error.get().map(|e| view! {
                <div role="alert" class="t-sm" style="color: var(--color-negative)">{e}</div>
            })}

            <div class="panel row wrap" style="gap: var(--space-6); align-items: baseline">
                <div class="stat">
                    <div class="stat-label">{move || format!("{} total", label.get())}</div>
                    <div class="stat-value">
                        {move || fmt::cents(total_spent.get())}" "
                        <span class="t-base t-tertiary" style="font-weight: 500">
                            {move || format!("of {}", fmt::cents(total_budgeted.get()))}
                        </span>
                    </div>
                </div>
                {move || (total_budgeted.get() > 0).then(|| {
                    let s = summary.get();
                    let text = if s.left_cents < 0 {
                        format!("{}% used · {} over", s.pct_used, fmt::cents(-s.left_cents))
                    } else {
                        format!("{}% used · {} left", s.pct_used, fmt::cents(s.left_cents))
                    };
                    view! {
                        <Tag variant=if s.left_cents < 0 { "negative" } else { "accent" }>{text}</Tag>
                    }
                })}
            </div>

            <Panel title="Category budgets">
                <div class="stack-lg">{list}</div>
            </Panel>

            {move || editing.get().map(|budget| {
                let existing: Vec<String> =
                    budgets.with_untracked(|bs| bs.iter().map(|b| b.category_id.clone()).collect());
                view! {
                    <BudgetDialog budget=budget month=month.get_untracked() categories=categories
                        existing=existing
                        on_close=move || editing.set(None)
                        on_saved=move || {
                            editing.set(None);
                            version.update(|v| *v += 1);
                        } />
                }
            })}
        </div>
    }
}

/// `last_ok` without a memo, for data only read inside other derivations.
fn last_ok_value<T: Clone + Send + Sync + 'static>(
    res: LocalResource<Result<T, String>>,
) -> Option<T> {
    res.get().and_then(Result::ok)
}

#[component]
fn BudgetBar(
    budget: BudgetWithSpend,
    category: Option<Category>,
    editing: RwSignal<Editing>,
) -> impl IntoView {
    let host = use_host();
    // Weekly budgets show this week (they reset every week); monthly ones the month.
    let figures = period_figures(&budget);
    let (pct, over) = bar_fill(figures);
    let color = category
        .as_ref()
        .map(|c| c.color.clone())
        .unwrap_or_else(|| "var(--color-accent)".into());
    let name = category
        .as_ref()
        .map(|c| c.name.clone())
        .unwrap_or_else(|| "Unknown category".into());
    let category_id = budget.category_id.clone();
    let open = move || editing.set(Some(Some(budget.clone())));
    let open_key = open.clone();
    view! {
        <div role="button" tabindex="0" on:click=move |_| open()
            on:keydown=move |e| {
                if e.key() == "Enter" || e.key() == " " {
                    open_key();
                }
            }
            style="display: block; width: 100%; background: none; border: none; padding: 0px; cursor: pointer; font: inherit; color: inherit; text-align: left">
            <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; column-gap: 12px; row-gap: 2px; font-size: var(--text-sm); margin-bottom: 5px">
                <span style="font-weight: 500; display: flex; align-items: center; gap: 7px; min-width: 0px; overflow-wrap: anywhere">
                    <span aria-hidden="true"
                        style=format!("width: 7px; height: 7px; border-radius: 50%; background: {color}; flex: none")>
                    </span>
                    {name}
                    {figures.weekly.then(|| view! {
                        <span style="font-weight: 400; font-size: var(--text-xs); color: var(--content-tertiary)">
                            "This week"
                        </span>
                    })}
                </span>
                <span style="display: flex; align-items: baseline; gap: 10px; margin-left: auto">
                    <span style=if over { "color: var(--color-negative)" } else { "color: var(--content-tertiary)" }>
                        {format!("{} of {}", fmt::cents(figures.spent), fmt::cents(figures.limit))}
                        {over.then_some(" — over")}
                    </span>
                    <button class="tap-target" title="View this category's transactions"
                        on:click=move |e| {
                            e.stop_propagation();
                            host.navigate("transactions", &NavFilter {
                                category_id: Some(category_id.clone()),
                                ..Default::default()
                            });
                        }
                        style="border: 0px; background: none; cursor: pointer; font: inherit; font-size: var(--text-xs); font-weight: 600; color: var(--content-tertiary); padding: 0px">
                        "Transactions →"
                    </button>
                </span>
            </div>
            <div style="height: 7px; border-radius: 99px; background: var(--color-neutral-900); overflow: hidden">
                <div class="grow-x"
                    style=format!(
                        "height: 100%; border-radius: 99px; width: {}%; background: {}; transition: width var(--dur-slow) var(--ease-out)",
                        pct.min(1.0) * 100.0,
                        if over { "var(--color-negative)" } else { color.as_str() },
                    )>
                </div>
            </div>
        </div>
    }
}

const PERIODS: &[(&str, &str)] = &[("monthly", "Monthly"), ("weekly", "Weekly")];

#[component]
fn BudgetDialog(
    budget: Option<BudgetWithSpend>,
    month: String,
    #[prop(into)] categories: Signal<Vec<Category>>,
    existing: Vec<String>,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_saved: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let week_start_label = move || {
        if app.with(|a| a.review_prefs.week_starts_on == "sunday") {
            "Sunday"
        } else {
            "Monday"
        }
    };
    let editing_cat = budget.as_ref().map(|b| b.category_id.clone());
    let available = {
        let editing_cat = editing_cat.clone();
        Signal::derive(move || {
            categories.with(|cs| {
                available_categories(cs, &existing, editing_cat.as_deref())
                    .into_iter()
                    .cloned()
                    .collect::<Vec<_>>()
            })
        })
    };
    let category_id = RwSignal::new(
        editing_cat
            .clone()
            .or_else(|| available.with_untracked(|a| a.first().map(|c| c.id.clone())))
            .unwrap_or_default(),
    );
    let period = RwSignal::new(match budget.as_ref().and_then(|b| b.period) {
        Some(BudgetPeriod::Weekly) => "weekly",
        _ => "monthly",
    });
    let amount = RwSignal::new(
        budget
            .as_ref()
            .map(|b| cents_to_fixed2(b.period_amount_cents.unwrap_or(b.amount_cents)))
            .unwrap_or_default(),
    );
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let amount_cents = Memo::new(move |_| budget_amount(&amount.get()));
    let valid = Signal::derive(move || {
        !category_id.with(String::is_empty) && amount_cents.get().0.is_some()
    });
    let month_text = month_label(&month);
    let budget_id = budget.as_ref().map(|b| b.id.clone());
    let is_edit = budget_id.is_some();
    let period_value = move || {
        if period.get_untracked() == "weekly" {
            BudgetPeriod::Weekly
        } else {
            BudgetPeriod::Monthly
        }
    };

    let save = {
        let (host, budget_id) = (host.clone(), budget_id.clone());
        move || {
            if !valid.get_untracked() || busy.get_untracked() {
                return;
            }
            let Some(cents) = amount_cents.get_untracked().0 else {
                return;
            };
            busy.set(true);
            error.set(None);
            let (host, budget_id, month) = (host.clone(), budget_id.clone(), month.clone());
            let period = period_value();
            spawn_local(async move {
                let result = match budget_id {
                    Some(id) => {
                        let body = HostCtx::arg(&UpdateBudgetBody {
                            amount_cents: cents,
                            period: Some(period),
                        });
                        host.try_call::<IgnoredAny>("updateBudget", &[id.into(), body])
                            .await
                    }
                    None => {
                        let body = HostCtx::arg(&CreateBudgetBody {
                            category_id: category_id.get_untracked(),
                            amount_cents: cents,
                            rollover: false,
                            period: Some(period),
                            month,
                        });
                        host.try_call::<IgnoredAny>("createBudget", &[body]).await
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
        let (host, budget_id) = (host.clone(), budget_id.clone());
        move || {
            let Some(id) = budget_id.clone() else { return };
            if busy.get_untracked() {
                return;
            }
            busy.set(true);
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<IgnoredAny>("deleteBudget", &[JsValue::from(id)])
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

    let options = Signal::derive(move || {
        available
            .get()
            .into_iter()
            .map(|c| SelectOption::new(c.id, c.name))
            .collect::<Vec<_>>()
    });
    let weekly = move || period.get() == "weekly";
    let hint = Signal::derive(move || {
        let first = if weekly() {
            let raw = parse_amount_to_cents(&amount.get()).unwrap_or(0);
            format!(
                "Starts fresh every {} — about {} a month. ",
                week_start_label(),
                fmt::cents(weekly_to_monthly(raw))
            )
        } else {
            "Starts fresh on the 1st of each month. ".to_string()
        };
        let second = if is_edit {
            "Changes apply from this budget's start month onward.".to_string()
        } else {
            format!("Applies from {month_text} onward, until you change it.")
        };
        first + &second
    });
    let field_error = Signal::derive(move || {
        amount_cents
            .get()
            .1
            .then(|| "Enter a positive amount like 600.00".to_string())
    });
    let field_label = Signal::derive(move || {
        if weekly() {
            "Weekly amount"
        } else {
            "Monthly amount"
        }
    });

    let actions = {
        let (save, remove) = (save.clone(), remove.clone());
        move || {
            let (save, remove) = (save.clone(), remove.clone());
            view! {
                {is_edit.then(|| view! {
                    <Button variant="ghost" disabled=busy on_click=remove>"Delete"</Button>
                })}
                <Button variant="secondary" disabled=busy on_click=move || on_close.run(())>"Cancel"</Button>
                <Button variant="primary" disabled=Signal::derive(move || !valid.get() || busy.get())
                    on_click=save>
                    {move || if busy.get() {
                        view! { <Spinner label="Saving" /> }.into_any()
                    } else {
                        "Save".into_any()
                    }}
                </Button>
            }
            .into_any()
        }
    };

    view! {
        <Dialog title=if is_edit { "Edit budget" } else { "Add budget" }.to_string()
            on_close=on_close actions=std::sync::Arc::new(actions)>
            <div style="display: flex; flex-direction: column; gap: 12px">
                {(!is_edit).then(|| view! {
                    <Select label="Category" value=category_id options=options />
                })}
                <Segmented aria_label="Resets" options=PERIODS value=period />
                <Field label=Signal::derive(move || field_label.get().to_string()) value=amount input_mode="decimal" autofocus=true
                    placeholder=Signal::derive(move || if weekly() { "150.00" } else { "600.00" })
                    error=field_error hint=hint />
                {move || error.get().map(|e| view! {
                    <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
                })}
            </div>
        </Dialog>
    }
}
