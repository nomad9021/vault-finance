//! Insights: port of apps/desktop/src/screens/shell/InsightsPage.tsx.

use leptos::prelude::*;
use vault_core::insights::{Insight, InsightListResponse, InsightSeverity};

use crate::fmt;
use crate::host::use_host;
use crate::ui::{Button, EmptyState, Icon, MetricCard, Panel, Spinner};

fn severity_style(s: InsightSeverity) -> (&'static str, &'static str) {
    match s {
        InsightSeverity::Critical => ("alert", "var(--color-negative)"),
        InsightSeverity::Warning => ("alert", "var(--color-accent)"),
        InsightSeverity::Info => ("info", "var(--content-tertiary)"),
        InsightSeverity::Good => ("check", "var(--color-positive)"),
    }
}

#[component]
pub fn InsightsPage() -> impl IntoView {
    let host = use_host();
    let version = host.data_version;
    let data = LocalResource::new(move || {
        version.track();
        let host = use_host();
        async move { host.call::<InsightListResponse>("insights", &[]).await }
    });

    move || {
        match data.get() {
        None => view! { <Spinner label="Looking for anything worth flagging" /> }.into_any(),
        Some(Err(e)) => view! { <div class="panel"><EmptyState icon="alert" title="Couldn't load insights" body=e /></div> }.into_any(),
        Some(Ok(r)) => view! { <Loaded data=r /> }.into_any(),
    }
    }
}

#[component]
fn Loaded(data: InsightListResponse) -> impl IntoView {
    let good = data.by_severity(InsightSeverity::Good).len();
    let groups: Vec<_> = InsightSeverity::ORDER
        .into_iter()
        .map(|s| {
            (
                s,
                data.by_severity(s).into_iter().cloned().collect::<Vec<_>>(),
            )
        })
        .filter(|(_, g)| !g.is_empty())
        .collect();

    view! {
        <div class="page">
            <div class="page-head">
                <div class="grid" style="flex: 1; min-width: 0">
                    <div class="col-4"><MetricCard label="Needs attention" value=data.critical_count.to_string() hint="urgent items" /></div>
                    <div class="col-4"><MetricCard label="Worth a look" value=data.warning_count.to_string() hint="not urgent yet" /></div>
                    <div class="col-4"><MetricCard label="Going well" value=good.to_string() hint="wins to keep" /></div>
                </div>
            </div>
            {if groups.is_empty() {
                view! {
                    <div class="panel">
                        <EmptyState icon="check" title="Nothing needs your attention"
                            body="No overspent budgets, underfunded bills or stalled goals. Add some budgets and bills and this page will start watching them for you." />
                    </div>
                }.into_any()
            } else {
                groups.into_iter().map(|(s, group)| {
                    let n = group.len();
                    view! {
                        <Panel title=s.label() subtitle=format!("{n} item{}", if n == 1 { "" } else { "s" })>
                            <div style="display: flex; flex-direction: column">
                                {group.into_iter().map(|i| view! { <InsightRow insight=i /> }).collect_view()}
                            </div>
                        </Panel>
                    }
                }).collect_view().into_any()
            }}
        </div>
    }
}

#[component]
fn InsightRow(insight: Insight) -> impl IntoView {
    let host = use_host();
    let (icon, color) = severity_style(insight.severity);
    let amount = insight.amount_cents.map(|c| {
        let text = if insight.amount_in_cents_exact() { fmt::cents(c) } else { fmt::cents_whole(c) };
        view! { <div class="num" style=format!("flex: none; font-weight: 600; color: {color}")>{text}</div> }
    });
    let page = insight.page.clone();
    let filter = insight.filter();
    view! {
        <div class="row-div" style="display: flex; align-items: flex-start; gap: 14px; padding: 13px 2px">
            <span aria-hidden="true" style=format!(
                "flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-md); color: {color}; background: color-mix(in srgb, {color} 12%, transparent); margin-top: 1px")>
                <Icon name=icon size=16 />
            </span>
            <div style="flex: 1; min-width: 0">
                <div style="font-weight: 600; font-size: var(--text-base)">{insight.title}</div>
                <p style="margin: 3px 0 0; font-size: var(--text-sm); color: var(--content-tertiary); line-height: 1.55">{insight.detail}</p>
            </div>
            {amount}
            <Button variant="secondary" size="sm" icon_end="arrowRight" style="flex: none"
                on_click=move || host.navigate(&page, &filter)>
                "Open"
            </Button>
        </div>
    }
}
