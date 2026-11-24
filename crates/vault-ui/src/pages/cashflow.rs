//! Cash Flow: port of apps/desktop/src/screens/shell/CashFlowPage.tsx.
//! Income vs. spending bars for the last six months, and the debt payoff
//! planner as a second tab (both answer "where is the surplus going?").

use leptos::prelude::*;
use vault_core::cashflow::{self, CashflowSummaryResponse, MonthSummary};

use super::debt_calculator::DebtCalculator;
use crate::fmt;
use crate::host::use_host;
use crate::ui::{MetricCard, Panel, Spinner, Tabs};

const TABS: &[(&str, &str)] = &[("trends", "Income vs. spending"), ("debt", "Debt payoff")];

#[component]
pub fn CashFlowPage() -> impl IntoView {
    // Read once, like the React page's `useState(initialTab)`.
    let initial = use_host().filter.tab;
    let tab = RwSignal::new(if initial.as_deref() == Some("debt") {
        "debt"
    } else {
        "trends"
    });
    view! {
        <div class="page">
            <Tabs items=TABS value=tab aria_label="Cash flow views" />
            {move || if tab.get() == "trends" {
                view! { <TrendsTab /> }.into_any()
            } else {
                view! { <DebtCalculator /> }.into_any()
            }}
        </div>
    }
}

#[component]
fn TrendsTab() -> impl IntoView {
    let host = use_host();
    let version = host.data_version;
    let data = LocalResource::new(move || {
        version.track();
        let host = use_host();
        async move {
            host.call::<CashflowSummaryResponse>("cashflowSummary", &[6.into()])
                .await
        }
    });
    move || match data.get() {
        None => view! { <Spinner label="Loading cash flow" /> }.into_any(),
        // useData keeps `data` null on error: the page draws with no months.
        Some(r) => view! { <Trends months=r.map(|r| r.months).unwrap_or_default() /> }.into_any(),
    }
}

#[component]
fn Trends(months: Vec<MonthSummary>) -> impl IntoView {
    let s = cashflow::stats(&months);
    let legend = || {
        view! {
            <div style="display: flex; gap: 14px; font-size: var(--text-xs); color: var(--content-tertiary)">
                <span style="display: flex; align-items: center; gap: 5px">
                    <span style="width: 8px; height: 8px; border-radius: var(--radius-sm); background: var(--color-positive)"></span>
                    "In"
                </span>
                <span style="display: flex; align-items: center; gap: 5px">
                    <span style="width: 8px; height: 8px; border-radius: var(--radius-sm); background: var(--color-neutral-500)"></span>
                    "Out"
                </span>
            </div>
        }
    };
    let bar = |title: String, cents: i64, i: usize, color: &str| {
        let style = format!(
            "animation-delay: {}ms; width: 26%; max-width: 30px; height: {}; min-height: {}px; border-radius: 5px 5px 2px 2px; background: {color}",
            i.min(5) * 20,
            cashflow::bar_height(cents, s.max_cents),
            if cents > 0 { 3 } else { 0 },
        );
        view! { <div title=title class="grow-up" style=style></div> }
    };
    let columns = months
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let net_color = if m.net_cents >= 0 { "var(--color-positive)" } else { "var(--color-negative)" };
            view! {
                <div style="flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; height: 100%">
                    <div style="display: flex; gap: 5px; align-items: flex-end; width: 100%; justify-content: center; flex: 1">
                        {bar(format!("Income {}", fmt::cents_whole(m.income_cents)), m.income_cents, i, "var(--color-positive)")}
                        {bar(format!("Spending {}", fmt::cents_whole(m.spending_cents)), m.spending_cents, i, "var(--color-neutral-500)")}
                    </div>
                    <div style="font-size: var(--text-xs); color: var(--content-tertiary)">
                        {fmt::month_short(&m.month)}
                    </div>
                    <div style=format!("font-size: var(--text-xs); font-weight: 600; color: {net_color}")>
                        {fmt::cents_whole(m.net_cents)}
                    </div>
                </div>
            }
        })
        .collect_view();

    view! {
        <div class="page">
            <Panel flush=true title="Income vs. spending" subtitle="Last 6 months" actions=legend().into_any()>
                <div style="padding: 8px 18px 18px; display: flex; gap: 14px; align-items: flex-end; height: 220px">
                    {columns}
                </div>
            </Panel>
            <div class="grid">
                <div class="col-4">
                    <MetricCard label="Avg monthly net" value=fmt::cents_whole(s.avg_net_cents) hint="months with activity" />
                </div>
                <div class="col-4">
                    <MetricCard label="Avg savings rate" value=cashflow::rate_label(s.avg_rate) hint="of income kept" />
                </div>
                <div class="col-4">
                    <MetricCard label="Saved over period" value=fmt::cents_whole(s.total_saved_cents) hint="sum of positive months" />
                </div>
            </div>
        </div>
    }
}
