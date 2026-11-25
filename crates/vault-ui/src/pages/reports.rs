//! Reports: port of apps/desktop/src/screens/shell/ReportsPage.tsx.
//!
//! The review launcher, the year-to-date totals with a CSV export, the
//! monthly table and a month drill-in (categories, goals, AI summary).

use leptos::prelude::*;
use leptos::task::spawn_local;
use vault_core::dates::Month;
use vault_core::goals::{Goal, GoalListResponse};
use vault_core::nav::NavFilter;
use vault_core::reports::{
    goal_track, months_with_data, rate_text, MonthlyReport, ReviewPeriod, YearlyReport,
};
use wasm_bindgen::{JsCast, JsValue};

use super::review_presenter::ReviewPresenter;
use crate::fmt;
use crate::host::use_host;
use crate::ui::{Button, PieChart, PieSlice, Segmented, Spinner, Tag};

const ROW_BORDER: &str =
    "border-top: 1px solid color-mix(in srgb, var(--color-text) 7%, transparent)";

/// `monthLabel("2026-11")`: "November 2026".
fn month_label(month: &str) -> String {
    let mut parts = month.split('-').map(|p| p.parse::<i32>().unwrap_or(0));
    let (year, m) = (parts.next().unwrap_or(0), parts.next().unwrap_or(1));
    fmt::month_long_year(Month {
        year,
        month: m.max(0) as u32,
    })
}

fn current_utc_year() -> i32 {
    js_sys::Date::new_0().get_utc_full_year() as i32
}

/// Save `csv` as vault-transactions.csv (Blob + a clicked link).
fn download_csv(csv: &str) {
    let parts = js_sys::Array::of1(&JsValue::from_str(csv));
    let opts = web_sys::BlobPropertyBag::new();
    opts.set_type("text/csv");
    let Ok(blob) = web_sys::Blob::new_with_str_sequence_and_options(&parts, &opts) else {
        return;
    };
    let Ok(url) = web_sys::Url::create_object_url_with_blob(&blob) else {
        return;
    };
    if let Some(a) = document()
        .create_element("a")
        .ok()
        .and_then(|e| e.dyn_into::<web_sys::HtmlAnchorElement>().ok())
    {
        a.set_href(&url);
        a.set_download("vault-transactions.csv");
        a.click();
    }
    let _ = web_sys::Url::revoke_object_url(&url);
}

#[component]
pub fn ReportsPage() -> impl IntoView {
    let host = use_host();
    let version = host.data_version;
    let year = current_utc_year();
    let yearly = LocalResource::new(move || {
        version.track();
        let host = use_host();
        async move {
            host.call::<YearlyReport>("yearlyReport", &[JsValue::from(year)])
                .await
        }
    });
    let selected = RwSignal::new(None::<String>);
    let exporting = RwSignal::new(false);

    let stored = StoredValue::new(host.clone());
    let export_csv = move || {
        exporting.set(true);
        let host = stored.get_value();
        spawn_local(async move {
            if let Ok(csv) = host.call::<String>("exportCsv", &[]).await {
                download_csv(&csv);
            }
            exporting.set(false);
        });
    };

    move || {
        // useData: an error leaves no data, which reads as zeros.
        let data = match yearly.get() {
            None => return view! { <Spinner label="Loading reports" /> }.into_any(),
            Some(r) => r.ok(),
        };
        let current_month = fmt::today_utc()[..7].to_string();
        let rows: Vec<_> = data
            .as_ref()
            .map(|y| {
                months_with_data(&y.months, &current_month)
                    .into_iter()
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let total = |f: fn(&YearlyReport) -> i64| fmt::cents_whole(data.as_ref().map_or(0, f));
        let rate = rate_text(data.as_ref().and_then(|y| y.savings_rate));
        view! {
            <div class="page">
                <ReviewLauncher />
                <div style="background: linear-gradient(160deg, var(--color-surface) 0%, color-mix(in srgb, var(--color-section) 45%, var(--color-surface)) 140%); border: 1px solid var(--color-divider); border-radius: var(--radius-lg); padding: 18px; box-shadow: var(--shadow-sm)">
                    <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px">
                        <div style="font-size: var(--text-2xs); letter-spacing: .04em; text-transform: uppercase; color: var(--content-tertiary); font-weight: 600">
                            {year}" year to date"
                        </div>
                        <Button variant="secondary" on_click=export_csv disabled=Signal::derive(move || exporting.get())>
                            {move || if exporting.get() {
                                view! { <Spinner label="Exporting" /> }.into_any()
                            } else {
                                "Export all transactions (CSV)".into_any()
                            }}
                        </Button>
                    </div>
                    <div style="display: flex; flex-wrap: wrap; gap: 28px; margin-top: 10px">
                        <Ytd value=total(|y| y.total_income_cents) label="income" />
                        <Ytd value=total(|y| y.total_spending_cents) label="spending" />
                        <Ytd value=total(|y| y.total_saved_cents) label="saved" />
                        <Ytd value=rate label="savings rate" />
                    </div>
                </div>

                <div style="background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); overflow-x: auto">
                    <div style="padding: 14px 18px 6px; font-family: var(--font-heading); font-weight: 600; font-size: var(--text-base)">
                        "Monthly reports"
                    </div>
                    <table style="width: 100%; border-collapse: collapse; font-size: var(--text-sm)">
                        <thead>
                            <tr style="text-align: left">
                                <Th label="Month" />
                                <Th label="Income" right=true />
                                <Th label="Spending" right=true />
                                <Th label="Saved" right=true />
                                <Th label="Savings rate" right=true />
                            </tr>
                        </thead>
                        <tbody>
                            {if rows.is_empty() {
                                view! {
                                    <tr>
                                        <td colspan="5" class="text-muted" style="padding: 20px; text-align: center">
                                            "No activity recorded in "{year}" yet."
                                        </td>
                                    </tr>
                                }
                                .into_any()
                            } else {
                                rows.into_iter().map(|m| {
                                    let month = m.month.clone();
                                    let net_color = if m.net_cents >= 0 { "var(--color-positive)" } else { "var(--color-negative)" };
                                    view! {
                                        <tr on:click=move |_| selected.set(Some(month.clone()))
                                            style=format!("{ROW_BORDER}; cursor: pointer")>
                                            <td style="padding: 9px 18px; font-weight: 500">{month_label(&m.month)}</td>
                                            <td style="padding: 9px 18px; text-align: right">{fmt::cents_whole(m.income_cents)}</td>
                                            <td style="padding: 9px 18px; text-align: right">{fmt::cents_whole(m.spending_cents)}</td>
                                            <td style=format!("padding: 9px 18px; text-align: right; color: {net_color}; font-weight: 600")>
                                                {fmt::cents_whole(m.net_cents)}
                                            </td>
                                            <td style="padding: 9px 18px; text-align: right; color: var(--content-tertiary)">
                                                {rate_text(m.savings_rate)}
                                            </td>
                                        </tr>
                                    }
                                }).collect_view().into_any()
                            }}
                        </tbody>
                    </table>
                </div>

                <Show when=move || selected.with(Option::is_some)>
                    <MonthDetail selected />
                </Show>
            </div>
        }
        .into_any()
    }
}

/// Start a weekly / monthly review — windowed or straight into full screen.
#[component]
fn ReviewLauncher() -> impl IntoView {
    let prefs = use_host().app().review_prefs;
    let start_fullscreen = prefs.start_fullscreen;
    let period = RwSignal::new(prefs.default_period.as_str());
    // Some(fullscreen) while presenting.
    let presenting = RwSignal::new(None::<bool>);
    view! {
        <div class="card elev-sm">
            <div class="card-kicker">"Finance review"</div>
            <div class="card-title">
                {move || if period.get() == "week" { "Weekly review" } else { "Monthly review" }}
            </div>
            <p class="card-body">
                "A slide-by-slide look at the "{move || period.get()}": what came in, where it went, budgets, bills and goals. Choose the slides in Settings → Finance reviews."
            </p>
            <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center">
                <Segmented aria_label="Review period" options=&[("week", "Weekly"), ("month", "Monthly")] value=period />
                <div style="flex: 1"></div>
                <Button variant="secondary" icon="expand" on_click=move || presenting.set(Some(true))>
                    "Full screen"
                </Button>
                <Button variant="primary" icon="play" on_click=move || presenting.set(Some(start_fullscreen))>
                    "Present"
                </Button>
            </div>
            {move || presenting.get().map(|fullscreen| view! {
                <ReviewPresenter
                    initial_period=ReviewPeriod::parse(period.get_untracked())
                    fullscreen
                    on_close=Callback::new(move |_| presenting.set(None)) />
            })}
        </div>
    }
}

#[component]
fn Ytd(#[prop(into)] value: String, label: &'static str) -> impl IntoView {
    view! {
        <div>
            <div style="font-family: var(--font-heading); font-weight: 600; font-size: var(--text-2xl)">{value}</div>
            <div style="font-size: var(--text-xs); color: var(--content-tertiary)">{label}</div>
        </div>
    }
}

#[component]
fn Th(label: &'static str, #[prop(optional)] right: bool) -> impl IntoView {
    let align = if right { "right" } else { "left" };
    view! {
        <th style=format!("padding: 8px 18px; font-size: var(--text-2xs); letter-spacing: .05em; text-transform: uppercase; color: var(--content-tertiary); text-align: {align}; font-weight: 600")>
            {label}
        </th>
    }
}

/// Month drill-in: top categories + AI commentary (cached server-side).
#[component]
fn MonthDetail(selected: RwSignal<Option<String>>) -> impl IntoView {
    let host = use_host();
    let version = host.data_version;
    let month = move || selected.get().unwrap_or_default();
    // Like useData, the last report stays up while another month loads.
    let report = LocalResource::new(move || {
        version.track();
        let month = month();
        let host = use_host();
        async move {
            host.call::<MonthlyReport>("monthlyReport", &[JsValue::from_str(&month)])
                .await
        }
    });
    view! {
        <div class="card elev-sm">
            <div class="card-kicker">{move || month_label(&month())}</div>
            <div class="card-title">"Month in detail"</div>
            {move || match report.get() {
                None => view! { <Spinner label="Loading report" /> }.into_any(),
                Some(Err(_)) => ().into_any(),
                Some(Ok(r)) => view! { <MonthBody report=r label=month_label(&month()) /> }.into_any(),
            }}
            <div>
                <Button variant="ghost" on_click=move || selected.set(None)>"Close"</Button>
            </div>
        </div>
    }
}

#[component]
fn MonthBody(report: MonthlyReport, label: String) -> impl IntoView {
    let host = use_host();
    let cats = report.top_categories.clone();
    view! {
        <div style="display: flex; flex-wrap: wrap; gap: 24px">
            <Ytd value=fmt::cents_whole(report.income_cents) label="income" />
            <Ytd value=fmt::cents_whole(report.spending_cents) label="spending" />
            <Ytd value=fmt::cents_whole(report.saved_cents) label="saved" />
        </div>
        {(!cats.is_empty()).then(|| {
            let slices = cats.iter().map(|c| PieSlice {
                label: c.name.clone(),
                value: c.spent_cents,
                color: c.color.clone(),
            }).collect::<Vec<_>>();
            view! {
                <div style="margin-top: 10px">
                    <div style="font-size: var(--text-sm); font-weight: 600; margin-bottom: 8px">"Spending breakdown"</div>
                    <PieChart data=slices format=fmt::cents_whole center_label="spent"
                        aria_label=format!("{label} spending by category") />
                    <div style="display: flex; flex-direction: column; margin-top: 8px">
                        {cats.into_iter().map(|c| {
                            let host = host.clone();
                            let id = c.category_id.clone().unwrap_or_else(|| "none".into());
                            view! {
                                <button title="View this category's transactions"
                                    on:click=move |_| host.navigate("transactions", &NavFilter {
                                        category_id: Some(id.clone()),
                                        ..Default::default()
                                    })
                                    style=format!("display: flex; align-items: center; gap: 8px; padding: 6px 4px; border: 0; {ROW_BORDER}; background: none; font: inherit; color: inherit; cursor: pointer; text-align: left; width: 100%")>
                                    <span aria-hidden="true"
                                        style=format!("width: 9px; height: 9px; border-radius: var(--radius-sm); background: {}; flex: none", c.color)></span>
                                    <span style="flex: 1; min-width: 0; font-size: var(--text-sm)">{c.name}</span>
                                    <span style="font-size: var(--text-sm); font-weight: 600">{fmt::cents_whole(c.spent_cents)}</span>
                                    <span style="font-size: var(--text-xs); color: var(--content-tertiary)">"→"</span>
                                </button>
                            }
                        }).collect_view()}
                    </div>
                </div>
            }
        })}
        <GoalsTracker />
        {match report.ai_summary.filter(|s| !s.is_empty()) {
            Some(summary) => view! {
                <div style="margin-top: 10px; padding: 12px 14px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-accent) 8%, transparent); font-size: var(--text-sm); line-height: 1.6">
                    <Tag variant="accent" style="font-size: var(--text-3xs); margin-bottom: 6px">"✦ AI summary"</Tag>
                    <div style="white-space: pre-line">{summary}</div>
                </div>
            }
            .into_any(),
            None => view! {
                <p class="card-meta" style="margin-top: 8px">
                    "AI commentary appears here for closed months when the assistant is online."
                </p>
            }
            .into_any(),
        }}
    }
}

/// Goal progress with an on-track / behind read, driven by projected completion.
#[component]
fn GoalsTracker() -> impl IntoView {
    let version = use_host().data_version;
    let goals = LocalResource::new(move || {
        version.track();
        let host = use_host();
        async move { host.call::<GoalListResponse>("goals", &[]).await }
    });
    move || {
        let goals = match goals.get() {
            Some(Ok(r)) if !r.goals.is_empty() => r.goals,
            _ => return ().into_any(),
        };
        view! {
            <div style="margin-top: 14px">
                <div style="font-size: var(--text-sm); font-weight: 600; margin-bottom: 8px">"Goals — on track?"</div>
                <div style="display: flex; flex-direction: column; gap: 10px">
                    {goals.into_iter().map(|g| view! { <GoalRow goal=g /> }).collect_view()}
                </div>
            </div>
        }
        .into_any()
    }
}

#[component]
fn GoalRow(goal: Goal) -> impl IntoView {
    let t = goal_track(&goal);
    let mut meta = format!(
        "{} of {} ({}%)",
        fmt::cents_whole(goal.saved_cents),
        fmt::cents_whole(goal.target_cents),
        t.pct
    );
    if let Some(m) = &t.target_month {
        meta.push_str(&format!(" · target {m}"));
    }
    if let Some(p) = goal.projected_completion.as_ref().filter(|p| !p.is_empty()) {
        meta.push_str(&format!(" · projected {p}"));
    }
    view! {
        <div>
            <div style="display: flex; justify-content: space-between; font-size: var(--text-sm); margin-bottom: 3px">
                <span style="display: flex; gap: 7px; align-items: center">
                    <span style=format!("width: 7px; height: 7px; border-radius: 50%; background: {}", goal.color)></span>
                    {goal.name.clone()}
                </span>
                <span style=format!("color: {}; font-weight: 600", t.color)>{t.label}</span>
            </div>
            <div style="height: 5px; border-radius: 99px; background: var(--color-neutral-900); overflow: hidden">
                <div style=format!("height: 100%; width: {}%; background: {}; border-radius: 99px", t.pct, goal.color)></div>
            </div>
            <div style="font-size: var(--text-xs); color: var(--content-tertiary); margin-top: 3px">{meta}</div>
        </div>
    }
}
