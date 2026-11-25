//! Budget vs actual: port of
//! apps/desktop/src/screens/shell/BudgetVsActualPage.tsx. Budget and actual
//! for one month on a single Sankey, with the same figures in a table
//! underneath for reading off the exact cents.

use leptos::prelude::*;
use vault_core::budget_period::shift_month;
use vault_core::budget_sankey::build_budget_vs_actual;
use vault_core::budgets::BudgetListResponse;
use vault_core::categories::CategoryListResponse;
use wasm_bindgen::JsValue;

use super::{current_month, last_ok, month_label};
use crate::fmt;
use crate::host::use_host;
use crate::ui::{Button, EmptyState, Panel, SankeyCard, SkeletonList};

#[component]
pub fn BudgetVsActualPage() -> impl IntoView {
    let host = use_host();
    let month = RwSignal::new(current_month());
    let data_version = host.data_version;
    let res = LocalResource::new(move || {
        data_version.track();
        let m = month.get();
        let host = use_host();
        async move {
            host.call::<BudgetListResponse>("budgets", &[m.into(), JsValue::UNDEFINED])
                .await
        }
    });
    let data = last_ok(res);
    let cat_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move { host.call::<CategoryListResponse>("categories", &[]).await }
    });
    let cats = last_ok(cat_res);

    let view_data = Memo::new(move |_| {
        let d = data.get();
        let budgets = d.as_ref().map(|d| d.budgets.clone()).unwrap_or_default();
        let unbudgeted = d.and_then(|d| d.unbudgeted_spending).unwrap_or_default();
        let categories = cats.get().map(|c| c.categories).unwrap_or_default();
        build_budget_vs_actual(&budgets, &unbudgeted, &categories, fmt::cents)
    });
    let nodes = Signal::derive(move || view_data.with(|v| v.graph.nodes.clone()));
    let links = Signal::derive(move || view_data.with(|v| v.graph.links.clone()));
    let label = Signal::derive(move || month_label(&month.get()));

    let body = move || {
        if res.get().is_none() && data.with(Option::is_none) {
            return view! {
                <Panel title="Budget vs actual"><SkeletonList rows=4 height=52 /></Panel>
            }
            .into_any();
        }
        if view_data.with(|v| v.rows.is_empty()) {
            return view! {
                <Panel title="Budget vs actual">
                    <EmptyState compact=true icon="target"
                        title=format!("Nothing to compare for {}", label.get())
                        body="Add a budget, or record some spending, and it will flow through here." />
                </Panel>
            }
            .into_any();
        }
        let v = view_data.get();
        let difference = v.budgeted_cents - v.actual_cents;
        view! {
            <SankeyCard precise=true single_period=true title="Budget vs actual"
                hint="Budget flows in on the left, spending out on the right"
                nodes=nodes links=links month=month />
            <Panel title="By category">
                <div role="table" aria-label="Budget and actual by category"
                    style="display: grid; grid-template-columns: minmax(0, 1fr) repeat(3, auto); column-gap: var(--space-6); row-gap: var(--space-2)">
                    <Row cells=["Category".into(), "Budgeted".into(), "Actual".into(), "Left".into()] header=true />
                    {v.rows.into_iter().map(|r| {
                        let over = r.actual_cents > r.budgeted_cents;
                        let budgeted = if r.budgeted_cents > 0 { fmt::cents(r.budgeted_cents) } else { "—".into() };
                        view! {
                            <Row color=r.color.clone() over=over
                                cells=[r.label.clone(), budgeted, fmt::cents(r.actual_cents),
                                    fmt::cents(r.budgeted_cents - r.actual_cents)] />
                        }
                    }).collect_view()}
                    <Row header=true over={difference < 0}
                        cells=["Total".into(), fmt::cents(v.budgeted_cents), fmt::cents(v.actual_cents),
                            fmt::cents(difference)] />
                </div>
            </Panel>
        }
        .into_any()
    };

    view! {
        <div class="page" style="width: 100%; max-width: 1180px">
            <div class="row" style="gap: var(--space-1)">
                <Button variant="ghost" icon="chevronLeft" aria_label="Previous month"
                    on_click=move || month.update(|m| *m = shift_month(m, -1)) />
                <span class="t-md t-semibold"
                    style="min-width: 150px; text-align: center; font-family: var(--font-heading)">
                    {label}
                </span>
                <Button variant="ghost" icon="chevronRight" aria_label="Next month"
                    on_click=move || month.update(|m| *m = shift_month(m, 1)) />
            </div>
            {body}
        </div>
    }
}

#[component]
fn Row(
    cells: [String; 4],
    #[prop(optional)] header: bool,
    #[prop(optional)] over: bool,
    #[prop(optional)] color: Option<String>,
) -> impl IntoView {
    view! {
        <div role="row" style="display: contents">
            {cells.into_iter().enumerate().map(|(i, text)| {
                let mut style = String::from(if i == 0 {
                    "display: flex; align-items: center; gap: 7px; min-width: 0px"
                } else {
                    "text-align: right"
                });
                if header {
                    style.push_str("; font-weight: 600");
                }
                if over && i == 3 {
                    style.push_str("; color: var(--color-negative)");
                }
                let dot = (i == 0).then(|| color.clone()).flatten().map(|c| view! {
                    <span aria-hidden="true"
                        style=format!("width: 7px; height: 7px; border-radius: 50%; background: {c}; flex: none")>
                    </span>
                });
                view! {
                    <div role=if header { "columnheader" } else { "cell" }
                        class=if i == 0 { "t-sm" } else { "t-sm num" } style=style>
                        {dot}
                        {text}
                    </div>
                }
            }).collect_view()}
        </div>
    }
}
