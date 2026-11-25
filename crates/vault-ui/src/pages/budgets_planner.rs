//! Budget planner: port of apps/desktop/src/screens/shell/BudgetPlannerPage.tsx.
//! A forward-looking view: set one fixed monthly income, split it across
//! category budgets, and watch the Sankey balance the plan (income → each
//! budgeted category → unallocated/savings). Pure plan, independent of what
//! has actually been spent. The planned income persists via /budget-plan; the
//! per-category allocations are the same budgets as the Budgets page.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::budget_period::{
    allocation_change, allocation_text, income_input, planner_amount, planner_totals, shift_month,
    AllocationChange, BudgetPlanBody, CreateBudgetBody, UpdateBudgetBody,
};
use vault_core::budget_sankey::{build_budget_sankey, pre_income_branches, with_tax_branch};
use vault_core::budgets::{BudgetListResponse, BudgetPlan, BudgetWithSpend, PreIncome};
use vault_core::categories::{Category, CategoryKind, CategoryListResponse};
use vault_core::money::cents_to_fixed2;
use vault_core::taxes::TaxProfileResponse;
use wasm_bindgen::JsValue;

use super::{current_month, last_ok, month_label};
use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{Button, Panel, PreIncomeDialog, SankeyCard, Spinner};

#[component]
pub fn BudgetPlannerPage() -> impl IntoView {
    let host = use_host();
    let month = RwSignal::new(current_month());
    let data_version = host.data_version;
    let version = RwSignal::new(0_u32);
    let pre_version = RwSignal::new(0_u32);

    let plan_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move { host.call::<BudgetPlan>("budgetPlan", &[]).await }
    });
    let plan_data = last_ok(plan_res);
    let budget_res = LocalResource::new(move || {
        data_version.track();
        version.track();
        let m = month.get();
        let host = use_host();
        async move {
            host.call::<BudgetListResponse>("budgets", &[m.into()])
                .await
        }
    });
    let budget_data = last_ok(budget_res);
    let cat_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move { host.call::<CategoryListResponse>("categories", &[]).await }
    });
    let cat_data = last_ok(cat_res);
    // Before income: with a tax profile or the user's own taxes and
    // deductions, the plan can start from gross pay.
    let tax_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move { host.call::<TaxProfileResponse>("taxProfile", &[]).await }
    });
    let tax_data = last_ok(tax_res);
    let pre_res =
        LocalResource::new(move || {
            data_version.track();
            pre_version.track();
            let host = use_host();
            async move {
                Ok::<_, String>(host.call::<PreIncome>("preIncome", &[]).await.unwrap_or(
                    PreIncome {
                        items: vec![],
                        use_estimate: true,
                    },
                ))
            }
        });
    let pre_income = last_ok(pre_res);
    let editing_pre_income = RwSignal::new(false);
    let from_gross = RwSignal::new(true);

    let expense_cats = Memo::new(move |_| {
        cat_data.with(|c| {
            c.as_ref()
                .map(|c| {
                    c.categories
                        .iter()
                        .filter(|c| c.kind == CategoryKind::Expense)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
    });
    let budgets = Memo::new(move |_| budget_data.get().map(|d| d.budgets).unwrap_or_default());

    // Planned income: hydrate once, persist debounced + on unmount.
    let income = RwSignal::new(String::new());
    // Plain atomics, not signals: the unmount save reads them after the
    // page's reactive values are gone.
    let hydrated = Arc::new(AtomicBool::new(false));
    {
        let hydrated = Arc::clone(&hydrated);
        Effect::new(move || {
            let Some(plan) = plan_data.get() else { return };
            if hydrated.swap(true, Ordering::Relaxed) {
                return;
            }
            income.set(income_input(plan.planned_income_cents));
        });
    }
    // Something unreadable ("12.345") keeps the last good figure rather than
    // saving a zero or a guess; the field says what's wrong.
    let parsed_income = Memo::new(move |_| planner_amount(&income.get()));
    let income_invalid = Signal::derive(move || parsed_income.get().is_none());
    let income_cents = Memo::new(move |prev: Option<&i64>| {
        parsed_income
            .get()
            .unwrap_or_else(|| prev.copied().unwrap_or(0))
    });
    let income_save_failed = RwSignal::new(false);
    let latest = Arc::new(AtomicI64::new(0));
    let timer = Arc::new(Mutex::new(None::<TimeoutHandle>));
    {
        let (host, hydrated, latest, timer) = (
            host.clone(),
            Arc::clone(&hydrated),
            Arc::clone(&latest),
            Arc::clone(&timer),
        );
        Effect::new(move || {
            let cents = income_cents.get();
            latest.store(cents, Ordering::Relaxed);
            if !hydrated.load(Ordering::Relaxed) {
                return;
            }
            let mut timer = timer.lock().unwrap();
            if let Some(t) = timer.take() {
                t.clear();
            }
            let host = host.clone();
            let handle = set_timeout_with_handle(
                move || {
                    spawn_local(async move {
                        let body = HostCtx::arg(&BudgetPlanBody {
                            planned_income_cents: cents,
                        });
                        let ok = host
                            .call::<IgnoredAny>("updateBudgetPlan", &[body])
                            .await
                            .is_ok();
                        income_save_failed.try_set(!ok);
                    });
                },
                Duration::from_millis(500),
            )
            .ok();
            *timer = handle;
        });
    }
    {
        let host = host.clone();
        on_cleanup(move || {
            if let Some(t) = timer.lock().unwrap().take() {
                t.clear();
            }
            if hydrated.load(Ordering::Relaxed) {
                let cents = latest.load(Ordering::Relaxed);
                host.fire(
                    "updateBudgetPlan",
                    &[HostCtx::arg(&BudgetPlanBody {
                        planned_income_cents: cents,
                    })],
                );
            }
        });
    }

    let totals = Memo::new(move |_| budgets.with(|bs| planner_totals(income_cents.get(), bs)));

    // Hierarchical budget Sankey, built from the same category tree as the
    // main cash-flow diagram so both are shaped by the Settings category editor.
    let tax_estimate = Memo::new(move |_| tax_data.get().and_then(|t| t.estimate));
    let branches = Memo::new(move |_| {
        let est = tax_estimate.get();
        pre_income.with(|p| pre_income_branches(est.as_ref(), p.as_ref()))
    });
    let gross = Memo::new(move |_| {
        from_gross.get() && branches.with(|b| !b.is_empty()) && income_cents.get() > 0
    });
    let graph = Memo::new(move |_| {
        let by_cat: HashMap<String, i64> = budgets.with(|bs| {
            bs.iter()
                .map(|b| (b.category_id.clone(), b.amount_cents))
                .collect()
        });
        let plan = expense_cats.with(|cats| build_budget_sankey(income_cents.get(), cats, &by_cat));
        if gross.get() {
            branches.with(|b| with_tax_branch(plan.graph, b))
        } else {
            plan.graph
        }
    });
    let nodes = Signal::derive(move || graph.with(|g| g.nodes.clone()));
    let links = Signal::derive(move || graph.with(|g| g.links.clone()));
    let has_flow = Memo::new(move |_| income_cents.get() > 0 || totals.get().allocated > 0);

    let set_allocation = {
        let host = host.clone();
        move |category_id: String, amount_cents: i64| {
            let host = host.clone();
            let existing = budgets
                .with_untracked(|bs| bs.iter().find(|b| b.category_id == category_id).cloned());
            let month = month.get_untracked();
            async move {
                let result = match allocation_change(existing.as_ref(), amount_cents) {
                    AllocationChange::Update { id, amount_cents } => {
                        let body = HostCtx::arg(&UpdateBudgetBody {
                            amount_cents,
                            period: None,
                        });
                        host.call::<IgnoredAny>("updateBudget", &[id.into(), body])
                            .await
                            .map(|_| ())
                    }
                    AllocationChange::Delete { id } => host
                        .call::<IgnoredAny>("deleteBudget", &[JsValue::from(id)])
                        .await
                        .map(|_| ()),
                    AllocationChange::Create { amount_cents } => {
                        let body = HostCtx::arg(&CreateBudgetBody {
                            category_id,
                            amount_cents,
                            rollover: false,
                            period: None,
                            month,
                        });
                        host.call::<IgnoredAny>("createBudget", &[body])
                            .await
                            .map(|_| ())
                    }
                    AllocationChange::Nothing => Ok(()),
                };
                if result.is_ok() {
                    version.try_update(|v| *v += 1);
                }
                result
            }
        }
    };
    let on_save = Callback::new(
        move |(category_id, cents, failed): (String, i64, RwSignal<bool>)| {
            let fut = set_allocation(category_id, cents);
            spawn_local(async move {
                if fut.await.is_err() {
                    failed.try_set(true);
                }
            });
        },
    );

    let label = Signal::derive(move || month_label(&month.get()));
    let sync_note = move || {
        let sync = tax_data.with(|t| {
            t.as_ref()
                .and_then(|t| t.profile.as_ref())
                .is_some_and(|p| p.sync_planned_income)
        });
        if sync && tax_estimate.with(Option::is_some) {
            " · from Salary & taxes"
        } else {
            ""
        }
    };

    view! {
        <div class="page" style="max-width: 1040px">
            <div style="display: flex; align-items: center; gap: 8px">
                <Button variant="ghost" aria_label="Previous month"
                    on_click=move || month.update(|m| *m = shift_month(m, -1))>"←"</Button>
                <span style="font-family: var(--font-heading); font-weight: 600; font-size: var(--text-md); min-width: 150px; text-align: center">
                    {label}
                </span>
                <Button variant="ghost" aria_label="Next month"
                    on_click=move || month.update(|m| *m = shift_month(m, 1))>"→"</Button>
                <div style="margin-left: auto">
                    <Button variant="secondary"
                        on_click={
                            let host = host.clone();
                            move || host.navigate("budgets", &vault_core::nav::NavFilter::default())
                        }>
                        "Track vs. actual →"
                    </Button>
                </div>
            </div>

            <Panel kicker="Plan" title="Budget planner"
                subtitle=Signal::stored("Set your monthly income, then allocate it across categories".to_string())>
                <div style="display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 6px">
                    <div>
                        <div class="eyebrow" style="margin-bottom: 4px">
                            "Fixed monthly income"{sync_note}
                        </div>
                        <div style="display: flex; align-items: center; gap: 6px">
                            <span style="color: var(--content-tertiary); font-size: var(--text-xl)">"$"</span>
                            <input class="input" inputmode="decimal" placeholder="5000"
                                aria-invalid=move || if income_invalid.get() { "true" } else { "false" }
                                prop:value=move || income.get()
                                on:input=move |e| income.set(event_target_value(&e))
                                style=move || format!(
                                    "width: 160px; font-size: var(--text-xl); font-weight: 600{}",
                                    if income_invalid.get() { "; border-color: var(--color-negative)" } else { "" },
                                ) />
                        </div>
                        {move || income_invalid.get().then(|| view! {
                            <div role="alert" class="field-error">
                                {format!("Enter dollars and cents, like 5000.25. Still using ${}.", cents_to_fixed2(income_cents.get()))}
                            </div>
                        })}
                        {move || income_save_failed.get().then(|| view! {
                            <div role="alert" class="field-error">
                                "Couldn't save your income. Check the connection and try again."
                            </div>
                        })}
                    </div>
                    <div>
                        <div class="eyebrow" style="margin-bottom: 4px">"Allocated"</div>
                        <div class="metric-value" style="font-size: var(--text-xl)">
                            {move || fmt::cents(totals.get().allocated)}
                        </div>
                    </div>
                    <div>
                        <div class="eyebrow" style="margin-bottom: 4px">
                            {move || if totals.get().over { "Over budget" } else { "Unallocated / savings" }}
                        </div>
                        <div class="metric-value"
                            style=move || format!("font-size: var(--text-xl); color: {}",
                                if totals.get().over { "var(--color-negative)" } else { "var(--color-positive)" })>
                            {move || {
                                let t = totals.get();
                                if t.over {
                                    format!("-{}", fmt::cents(t.allocated - income_cents.get()))
                                } else {
                                    fmt::cents(t.unallocated)
                                }
                            }}
                        </div>
                    </div>
                </div>
            </Panel>

            {move || has_flow.get().then(|| view! {
                <SankeyCard nodes=nodes links=links month=month precise=true
                    title=if gross.get() { "Budget plan, from gross pay" } else { "Budget plan" }.to_string()
                    hint="Click a category to see this month's actual spending" />
            })}
            {move || has_flow.get().then(|| view! {
                <div class="row" style="gap: 12px; margin-top: -8px; flex-wrap: wrap">
                    {move || branches.with(|b| !b.is_empty()).then(|| view! {
                        <label class="radio" style="font-size: var(--text-sm)">
                            <input type="checkbox" prop:checked=move || from_gross.get()
                                on:change=move |e| from_gross.set(event_target_checked(&e)) />
                            <span class="dot" style="border-radius: var(--radius-sm)"></span>
                            "Start from gross pay (taxes and deductions come off first)"
                        </label>
                    })}
                    <Button variant="ghost" size="sm" icon="edit"
                        disabled=Signal::derive(move || pre_income.with(Option::is_none))
                        on_click=move || editing_pre_income.set(true)>
                        "Before income"
                    </Button>
                </div>
            })}
            {move || {
                if !editing_pre_income.get() {
                    return None;
                }
                let value = pre_income.get()?;
                Some(view! {
                    <PreIncomeDialog value=value has_estimate=tax_estimate.with_untracked(Option::is_some)
                        on_close=move || editing_pre_income.set(false)
                        on_saved=move |_| {
                            editing_pre_income.set(false);
                            from_gross.set(true);
                            pre_version.update(|v| *v += 1);
                        } />
                })
            }}
            {move || (!has_flow.get()).then(|| view! {
                <Panel title="Budget plan">
                    <p class="card-meta" style="padding: 12px 0px">
                        {if income_cents.get() <= 0 {
                            "Enter your fixed monthly income above to start planning."
                        } else {
                            "Add an allocation below and the plan will flow through here."
                        }}
                    </p>
                </Panel>
            })}

            <Panel title="Allocations"
                subtitle=Signal::stored("How much of your income each category gets this month".to_string())>
                {move || if budget_res.get().is_none() && budget_data.with(Option::is_none) {
                    view! { <Spinner label="Loading budgets" /> }.into_any()
                } else {
                    view! {
                        <div style="display: flex; flex-direction: column">
                            <For each=move || expense_cats.get() key=|c| c.id.clone()
                                children=move |c: Category| {
                                    let id = c.id.clone();
                                    let budget = Signal::derive(move || {
                                        budgets.with(|bs| bs.iter().find(|b| b.category_id == id).cloned())
                                    });
                                    view! { <AllocationRow category=c budget=budget on_save=on_save /> }
                                } />
                            {move || expense_cats.with(Vec::is_empty).then(|| view! {
                                <p class="card-meta">
                                    "No expense categories yet. Add some in Settings, then allocate here."
                                </p>
                            })}
                        </div>
                    }.into_any()
                }}
            </Panel>
        </div>
    }
}

#[component]
fn AllocationRow(
    category: Category,
    #[prop(into)] budget: Signal<Option<BudgetWithSpend>>,
    /// (category id, cents, the row's save-failed flag to set on failure).
    on_save: Callback<(String, i64, RwSignal<bool>)>,
) -> impl IntoView {
    let stored = Memo::new(move |_| {
        budget.with(|b| {
            b.as_ref()
                .map(|b| cents_to_fixed2(b.amount_cents))
                .unwrap_or_default()
        })
    });
    let val = RwSignal::new(stored.get_untracked());
    let invalid = RwSignal::new(false);
    let save_failed = RwSignal::new(false);
    Effect::new(move || {
        val.set(stored.get());
        invalid.set(false);
    });

    let id = category.id.clone();
    let commit = move || {
        // Blank removes the allocation on purpose. A typo must not: it stays
        // in the field, marked, with the saved amount untouched.
        let Some(cents) = planner_amount(&val.get_untracked()) else {
            invalid.set(true);
            return;
        };
        invalid.set(false);
        save_failed.set(false);
        val.set(allocation_text(cents));
        let current = budget.with_untracked(|b| b.as_ref().map_or(0, |b| b.amount_cents));
        if cents != current {
            // A failed save must not leave the unsaved figure looking saved.
            on_save.run((id.clone(), cents, save_failed));
        }
    };
    let name = category.name.clone();
    view! {
        <div class="row-div"
            style="display: flex; align-items: center; gap: 10px; padding: 9px 2px; font-size: var(--text-sm)">
            <span aria-hidden="true"
                style=format!("width: 9px; height: 9px; border-radius: 50%; background: {}; flex: none", category.color)>
            </span>
            <span style="flex: 1; min-width: 0px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                {category.name.clone()}
            </span>
            <span style="color: var(--content-tertiary)">"$"</span>
            <input class="input num" inputmode="decimal" placeholder="0.00"
                aria-label=format!("{name} monthly amount")
                aria-invalid=move || if invalid.get() || save_failed.get() { "true" } else { "false" }
                title=move || if invalid.get() {
                    Some("Enter dollars and cents, like 212.37")
                } else if save_failed.get() {
                    Some("Couldn't save this amount. Try again.")
                } else {
                    None
                }
                prop:value=move || val.get()
                on:input=move |e| val.set(event_target_value(&e))
                on:blur=move |_| commit()
                on:keydown=move |e| {
                    if e.key() == "Enter" {
                        if let Some(el) = e
                            .current_target()
                            .and_then(|t| wasm_bindgen::JsCast::dyn_into::<web_sys::HtmlElement>(t).ok())
                        {
                            let _ = el.blur();
                        }
                    }
                }
                style=move || format!(
                    "width: 112px; text-align: right; padding: 5px 8px{}",
                    if invalid.get() || save_failed.get() { "; border-color: var(--color-negative)" } else { "" },
                ) />
        </div>
    }
}
