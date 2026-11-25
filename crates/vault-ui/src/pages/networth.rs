//! Net worth: port of apps/desktop/src/screens/shell/NetWorthPage.tsx.
//!
//! Assets minus liabilities, split by side and account type, with the
//! month-over-month change and the reconstructed history next to it.

use leptos::prelude::*;
use vault_core::accounts::{Account, AccountListResponse};
use vault_core::cashflow::{TrendPoint, TrendsResponse};
use vault_core::nav::NavFilter;
use vault_core::networth::{changes, group_by_type, plural, share_percent, NetWorth};
use vault_core::trend_chart::project;
use wasm_bindgen::JsValue;

use crate::fmt;
use crate::host::use_host;
use crate::ui::{EmptyState, MetricCard, Panel, Segmented, Spinner, TrendChart};

const RANGES: &[(&str, &str)] = &[("6", "6 months"), ("12", "12 months"), ("24", "24 months")];

fn month_label(p: &TrendPoint) -> String {
    p.year_month()
        .map(|(y, m)| fmt::month_label(y, m))
        .unwrap_or_default()
}

#[component]
pub fn NetWorthPage() -> impl IntoView {
    let host = use_host();
    let version = host.data_version;
    let range = RwSignal::new("12");
    let accounts = LocalResource::new(move || {
        version.track();
        let host = use_host();
        async move { host.call::<AccountListResponse>("accounts", &[]).await }
    });
    let trends = LocalResource::new(move || {
        version.track();
        let months: f64 = range.get().parse().unwrap_or(12.0);
        let host = use_host();
        async move {
            host.call::<TrendsResponse>("trends", &[JsValue::from(months)])
                .await
        }
    });
    // Like React's useData: a failed or pending trends fetch reads as no
    // points, and the last good result stays up while a new range loads.
    let points = Signal::derive(move || match trends.get() {
        Some(Ok(r)) => r.points,
        _ => Vec::new(),
    });

    move || {
        match accounts.get() {
        None => view! { <Spinner label="Loading net worth" /> }.into_any(),
        Some(Err(e)) => view! {
            <div class="panel"><EmptyState icon="alert" title="Couldn't load your accounts" body=e /></div>
        }
        .into_any(),
        Some(Ok(r)) if r.accounts.is_empty() => view! {
            <div class="page">
                <div class="panel">
                    <EmptyState icon="scale" title="No accounts yet"
                        body="Net worth is everything you own minus everything you owe. Add your accounts and this page fills itself in." />
                </div>
            </div>
        }
        .into_any(),
        Some(Ok(r)) => view! { <Loaded accounts=r.accounts points range /> }.into_any(),
    }
    }
}

#[component]
fn Loaded(
    accounts: Vec<Account>,
    points: Signal<Vec<TrendPoint>>,
    range: RwSignal<&'static str>,
) -> impl IntoView {
    let host = use_host();
    let nw = NetWorth::new(&accounts);
    let history = Memo::new(move |_| {
        points.with(|p| p.iter().map(|p| p.net_worth_cents).collect::<Vec<_>>())
    });
    let change = Memo::new(move |_| history.with(|h| changes(h).0));
    // The month delta sits in a card that React rebuilds with the trends; a
    // signal keeps it live here.
    let month_change = Memo::new(move |_| history.with(|h| changes(h).1));
    let projected = Signal::derive(move || history.with(|h| project(h, 3)));
    let color = Signal::derive(move || {
        if change.get() >= 0 {
            "var(--color-positive)".to_string()
        } else {
            "var(--color-negative)".to_string()
        }
    });
    let subtitle = Signal::derive(move || {
        if history.with(|h| h.len()) > 1 {
            let c = change.get();
            format!(
                "{} {} over {} months · dashed line is a projection",
                if c >= 0 { "Up" } else { "Down" },
                fmt::cents_whole(c.abs()),
                range.get()
            )
        } else {
            "Not enough history yet".to_string()
        }
    });
    let ends = move || {
        points.with(|p| {
            (p.len() > 1).then(|| {
                let (first, last) = (month_label(&p[0]), month_label(&p[p.len() - 1]));
                view! {
                    <div style="display: flex; justify-content: space-between; margin-top: 6px; font-size: var(--text-2xs); color: var(--content-tertiary)">
                        <span>{first}</span>
                        <span>{last}</span>
                    </div>
                }
            })
        })
    };

    let (h1, h2) = (host.clone(), host.clone());
    let to_accounts = Callback::new(move |_| h1.navigate("accounts", &NavFilter::default()));
    let to_debt = Callback::new(move |_| {
        h2.navigate(
            "cashflow",
            &NavFilter {
                tab: Some("debt".into()),
                ..Default::default()
            },
        )
    });
    let owed_tone = if nw.owed_total > 0 { "down" } else { "up" };
    let net = nw.net();

    view! {
        <div class="page">
            <div class="grid">
                <div class="col-6">
                    {move || {
                        let mc = month_change.get();
                        view! {
                            <MetricCard large=true label="Net worth" value=fmt::cents_whole(net)
                                delta={format!("{}{} this month", if mc >= 0 { "+" } else { "\u{2212}" }, fmt::cents_whole(mc.abs()))}
                                delta_tone={if mc >= 0 { "up" } else { "down" }}
                                hint=plural(accounts.len(), "account") />
                        }
                    }}
                </div>
                <div class="col-3">
                    <MetricCard label="Assets" value=fmt::cents_whole(nw.asset_total) delta_tone="up"
                        hint=plural(nw.assets.len(), "account") on_click=to_accounts />
                </div>
                <div class="col-3">
                    <MetricCard label="Liabilities" value=fmt::cents_whole(nw.owed_total) delta_tone=owed_tone
                        hint=plural(nw.liabilities.len(), "account") on_click=to_debt />
                </div>
            </div>

            <Panel flush=true title="Net worth over time" subtitle
                actions=Some(view! { <Segmented options=RANGES value=range aria_label="Time range" /> }.into_any())>
                <div style="padding: 4px 18px 12px">
                    <TrendChart history projected color height=180 />
                    {ends}
                </div>
            </Panel>

            <div class="grid">
                <div class="col-6">
                    <BalanceBreakdown title="What you own" subtitle="Assets by account"
                        accounts=nw.assets.clone() total=nw.asset_total tone="var(--color-positive)" />
                </div>
                <div class="col-6">
                    <BalanceBreakdown title="What you owe" subtitle="Liabilities by account"
                        accounts=nw.liabilities.clone() total=nw.owed_total tone="var(--color-negative)" />
                </div>
            </div>
        </div>
    }
}

#[component]
fn BalanceBreakdown(
    title: &'static str,
    subtitle: &'static str,
    accounts: Vec<Account>,
    total: i64,
    tone: &'static str,
) -> impl IntoView {
    let host = use_host();
    let groups = group_by_type(&accounts);
    let body = if groups.is_empty() {
        view! { <p class="card-meta">"Nothing here — which is good news on the liabilities side."</p> }
            .into_any()
    } else {
        let groups = groups
            .into_iter()
            .map(|group| {
                let rows = group
                    .list
                    .into_iter()
                    .map(|account| {
                        let host = host.clone();
                        let id = account.id.clone();
                        let mask = account.mask.filter(|m| !m.is_empty());
                        view! {
                            <button
                                on:click=move |_| host.navigate("transactions", &NavFilter { account_id: Some(id.clone()), ..Default::default() })
                                title="View this account's transactions"
                                style="display: flex; justify-content: space-between; width: 100%; gap: 10px; background: none; border: 0; padding: 4px 0; font: inherit; cursor: pointer; color: var(--content-tertiary); font-size: var(--text-xs)">
                                <span class="truncate">
                                    {account.name}
                                    {mask.map(|m| format!(" ····{m}"))}
                                </span>
                                <span class="num">{fmt::cents_whole(account.balance_cents.abs())}</span>
                            </button>
                        }
                    })
                    .collect_view();
                view! {
                    <div>
                        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 10px">
                            <span style="font-weight: 600; font-size: var(--text-sm)">{group.kind.label()}</span>
                            <span class="num" style="font-weight: 600">{fmt::cents_whole(group.total)}</span>
                        </div>
                        <div style="height: 6px; border-radius: 99px; margin-top: 6px; background: color-mix(in srgb, var(--color-text) 8%, transparent); overflow: hidden">
                            <div style=format!(
                                "height: 100%; width: {}; border-radius: 99px; background: {tone}; transition: width .4s var(--ease)",
                                share_percent(group.total, total)
                            )></div>
                        </div>
                        <div style="margin-top: 4px">{rows}</div>
                    </div>
                }
            })
            .collect_view();
        view! { <div style="display: flex; flex-direction: column; gap: var(--space-4)">{groups}</div> }
            .into_any()
    };
    view! { <Panel title=title subtitle=subtitle.to_string()>{body}</Panel> }
}
