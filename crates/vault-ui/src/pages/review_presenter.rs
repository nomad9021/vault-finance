//! The weekly / monthly finance review: port of
//! apps/desktop/src/screens/shell/ReviewPresenter.tsx.
//!
//! A full-window slideshow on `<body>`. Which slides appear (and in what
//! order) comes from Settings → Finance reviews (`host.app().reviewPrefs`).
//! Keys: ← → / Space to move, F for full screen, Esc to leave.

use std::future::Future;
use std::pin::Pin;
use std::task::Poll;

use leptos::portal::Portal;
use leptos::prelude::*;
use leptos::task::spawn_local;
use vault_core::bills::{Bill, BillListResponse};
use vault_core::budgets::BudgetListResponse;
use vault_core::categories::{Category, CategoryListResponse};
use vault_core::goals::{Goal, GoalListResponse};
use vault_core::reports::{
    bar_height, bar_width, budget_pct, busiest, daily_stats, delta, due_in, goal_slide_status,
    headline, month_tick, period_start, rank_max, safe_index, share_of, shift_period,
    sorted_budgets, step_index, upcoming_bills, visible_slides, week_end, MonthlyReport,
    PeriodReview, ReviewPeriod, SlideId,
};
use wasm_bindgen::{JsCast, JsValue};

use crate::fmt;
use crate::host::use_host;
use crate::ui::{on_document, on_window, Button, PieChart, PieSlice, Segmented, Spinner};

const ROW_BORDER: &str =
    "border-top: 1px solid color-mix(in srgb, var(--color-text) 7%, transparent)";

/// `Promise.all` for four requests: poll them together so they run at once.
async fn join4<A: Future, B: Future, C: Future, D: Future>(
    a: A,
    b: B,
    c: C,
    d: D,
) -> (A::Output, B::Output, C::Output, D::Output) {
    let (mut a, mut b, mut c, mut d) = (Box::pin(a), Box::pin(b), Box::pin(c), Box::pin(d));
    let (mut ra, mut rb, mut rc, mut rd) = (None, None, None, None);
    std::future::poll_fn(move |cx| {
        fn step<F: Future>(
            f: &mut Pin<Box<F>>,
            out: &mut Option<F::Output>,
            cx: &mut std::task::Context<'_>,
        ) {
            if out.is_none() {
                if let Poll::Ready(v) = f.as_mut().poll(cx) {
                    *out = Some(v);
                }
            }
        }
        step(&mut a, &mut ra, cx);
        step(&mut b, &mut rb, cx);
        step(&mut c, &mut rc, cx);
        step(&mut d, &mut rd, cx);
        if ra.is_some() && rb.is_some() && rc.is_some() && rd.is_some() {
            Poll::Ready((
                ra.take().unwrap(),
                rb.take().unwrap(),
                rc.take().unwrap(),
                rd.take().unwrap(),
            ))
        } else {
            Poll::Pending
        }
    })
    .await
}

/// Budgets, categories, bills and goals for the slides (each `null` on failure).
#[derive(Debug, Clone, PartialEq, Default)]
struct Extras {
    budgets: Option<BudgetListResponse>,
    categories: Vec<Category>,
    bills: Vec<Bill>,
    goals: Vec<Goal>,
}

/// Everything a slide draws.
#[derive(Clone)]
struct SlideData {
    review: PeriodReview,
    label: String,
    prev_word: &'static str,
    compare: bool,
    extras: Extras,
    ai_summary: Option<String>,
}

fn whole(c: i64) -> String {
    fmt::cents_whole(c)
}

#[component]
pub fn ReviewPresenter(
    initial_period: ReviewPeriod,
    /// Open straight into full screen.
    fullscreen: bool,
    on_close: Callback<()>,
) -> impl IntoView {
    let start_fullscreen = fullscreen;
    let host = use_host();
    // Presenting counts as activity (slides can auto-advance untouched).
    host.keep_unlocked();
    let app = host.app();
    let prefs = app.review_prefs.clone();
    let monday = prefs.week_starts_monday();
    let auto_secs = prefs.auto_advance_seconds;
    let compare = prefs.compare;
    let version = host.data_version;

    let period = RwSignal::new(initial_period);
    let start = RwSignal::new(period_start(initial_period, &fmt::today_utc(), monday));
    let index = RwSignal::new(0_usize);
    let playing = RwSignal::new(auto_secs > 0.0);
    let fullscreen = RwSignal::new(false);

    let is_current = move || start.get() >= period_start(period.get(), &fmt::today_utc(), monday);
    let review_month = Memo::new(move |_| start.get().chars().take(7).collect::<String>());

    let review = LocalResource::new(move || {
        version.track();
        let (p, s) = (period.get(), start.get());
        let host = use_host();
        async move {
            host.call::<PeriodReview>(
                "periodReview",
                &[JsValue::from_str(p.as_str()), JsValue::from_str(&s)],
            )
            .await
        }
    });
    let extras = LocalResource::new(move || {
        version.track();
        let month = review_month.get();
        let host = use_host();
        async move {
            let m = JsValue::from_str(&month);
            let (budgets, cats, bills, goals) = join4(
                host.call::<BudgetListResponse>("budgets", std::slice::from_ref(&m)),
                host.call::<CategoryListResponse>("categories", &[]),
                host.call::<BillListResponse>("bills", &[]),
                host.call::<GoalListResponse>("goals", &[]),
            )
            .await;
            Extras {
                budgets: budgets.ok(),
                categories: cats.map(|c| c.categories).unwrap_or_default(),
                bills: bills.map(|b| b.bills).unwrap_or_default(),
                goals: goals.map(|g| g.goals).unwrap_or_default(),
            }
        }
    });
    let wants_ai = {
        let ai_on = app.ai_visible && prefs.ai_slide_enabled();
        Memo::new(move |_| ai_on && period.get() == ReviewPeriod::Month)
    };
    let monthly = LocalResource::new(move || {
        version.track();
        let (month, wants) = (review_month.get(), wants_ai.get());
        let host = use_host();
        async move {
            if !wants {
                return None;
            }
            host.call::<MonthlyReport>("monthlyReport", &[JsValue::from_str(&month)])
                .await
                .ok()
        }
    });
    // Stale-while-loading values, compared so slides only redraw on change.
    let extras_v = Memo::new(move |_| extras.get());
    let ai_summary = Memo::new(move |_| {
        monthly
            .get()
            .flatten()
            .and_then(|m| m.ai_summary)
            .filter(|s| !s.is_empty())
    });

    // Enabled slides, minus any with nothing to show for this period.
    let slides = {
        let prefs = prefs.clone();
        Memo::new(move |_| {
            let ex = extras_v.get();
            visible_slides(
                &prefs,
                ai_summary.with(Option::is_some),
                ex.as_ref()
                    .and_then(|e| e.budgets.as_ref())
                    .map_or(0, |b| b.budgets.len()),
                ex.as_ref().map_or(0, |e| e.goals.len()),
            )
        })
    };
    let count = move || slides.with(Vec::len);
    let safe = Memo::new(move |_| safe_index(index.get(), count()));
    let go = move |by: i64| {
        let n = count();
        index.update(|i| *i = step_index(*i, by, n));
    };

    // Event handlers run outside the owner tree: no use_host() there.
    let stored = StoredValue::new(host.clone());
    let toggle_fullscreen = move || {
        let next = !fullscreen.get_untracked();
        let host = stored.get_value();
        spawn_local(async move {
            match host.set_fullscreen(next).await {
                Ok(()) => fullscreen.set(next),
                Err(e) => web_sys::console::error_2(&"full screen toggle failed".into(), &e.into()),
            }
        });
    };
    let close = move || {
        let was = fullscreen.get_untracked();
        let host = stored.get_value();
        spawn_local(async move {
            if was {
                let _ = host.set_fullscreen(false).await;
            }
            on_close.run(());
        });
    };

    // Once, on open.
    if start_fullscreen {
        toggle_fullscreen();
    }

    // The browser leaves full screen on its own Esc; keep our state honest.
    let browser = app.platform == "browser";
    on_document("fullscreenchange", false, move |_| {
        if document().fullscreen_element().is_none() && browser {
            fullscreen.set(false);
        }
    });

    on_window("keydown", false, move |e| {
        let Some(e) = e.dyn_ref::<web_sys::KeyboardEvent>() else {
            return;
        };
        if let Some(t) = e.target() {
            if t.has_type::<web_sys::HtmlInputElement>()
                || t.has_type::<web_sys::HtmlSelectElement>()
            {
                return;
            }
        }
        match e.key().as_str() {
            "ArrowRight" | "PageDown" | " " => {
                e.prevent_default();
                go(1);
            }
            "ArrowLeft" | "PageUp" => {
                e.prevent_default();
                go(-1);
            }
            "Home" => index.set(0),
            // `setIndex(count - 1)`; safe_index clamps an empty deck.
            "End" => index.set(count().saturating_sub(1)),
            k if k.to_lowercase() == "f" => toggle_fullscreen(),
            "Escape" => close(),
            _ => {}
        }
    });

    // Auto-advance; stops on the last slide.
    let timer = StoredValue::new_local(None::<TimeoutHandle>);
    Effect::new(move |_| {
        if let Some(t) = timer.get_value() {
            t.clear();
            timer.set_value(None);
        }
        let (n, i) = (count(), safe.get());
        if !playing.get() || auto_secs <= 0.0 || i + 1 >= n {
            return;
        }
        let ms = (auto_secs * 1000.0) as u64;
        if let Ok(h) = set_timeout_with_handle(move || go(1), std::time::Duration::from_millis(ms))
        {
            timer.set_value(Some(h));
        }
    });
    on_cleanup(move || {
        if let Some(t) = timer.try_get_value().flatten() {
            t.clear();
        }
    });

    // Segmented drives the period: re-anchor the start and go to slide 1.
    let seg = RwSignal::new(initial_period.as_str());
    Effect::watch(
        move || seg.get(),
        move |p, _, _| {
            let p = ReviewPeriod::parse(p);
            if p == period.get_untracked() {
                return;
            }
            let s = start.get_untracked();
            period.set(p);
            start.set(period_start(p, &s, monday));
            index.set(0);
        },
        false,
    );
    let step_period = move |by: i64| {
        let p = period.get_untracked();
        start.update(|s| *s = shift_period(p, s, by));
        index.set(0);
    };

    let label = Memo::new(move |_| {
        let s = start.get();
        let week = period.get() == ReviewPeriod::Week;
        fmt::period_label(week, &s, &week_end(&s))
    });
    let prev_word = move || {
        if period.get() == ReviewPeriod::Week {
            "last week"
        } else {
            "last month"
        }
    };
    let period_word = move || period.get().as_str();

    // What the stage shows: an error, the spinner, "no slides", or a slide
    // (re-mounted when the slide or period changes, like React's key).
    let review_v = Memo::new(move |_| review.get());
    let stage = move || {
        let s = start.get();
        let review = match review_v.get() {
            Some(Err(e)) => {
                return view! {
                    <SlideFrame kicker=label.get() title="Couldn't load this review">
                        <p class="text-muted">{e}</p>
                    </SlideFrame>
                }
                .into_any()
            }
            Some(Ok(r)) if r.start == s => r,
            _ => {
                return view! {
                    <div style="display: grid; place-items: center; min-height: 240px">
                        <Spinner label="Loading review" />
                    </div>
                }
                .into_any()
            }
        };
        if count() == 0 {
            return view! {
                <SlideFrame kicker=label.get() title="No slides selected">
                    <p class="text-muted">"Turn some on in Settings → Finance reviews."</p>
                </SlideFrame>
            }
            .into_any();
        }
        let Some(id) = slides.with(|v| v.get(safe.get()).copied()) else {
            return ().into_any();
        };
        let data = SlideData {
            review,
            label: label.get(),
            prev_word: prev_word(),
            compare,
            extras: extras_v.get().unwrap_or_default(),
            ai_summary: ai_summary.get(),
        };
        slide(id, data)
    };

    view! {
        <Portal>
            <div role="dialog" aria-modal="true"
                aria-label=move || format!("{} finance review", if period.get() == ReviewPeriod::Week { "Weekly" } else { "Monthly" })
                style="position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; background: linear-gradient(160deg, var(--color-bg) 0%, color-mix(in srgb, var(--color-section) 35%, var(--color-bg)) 120%); color: var(--content-primary); font-family: var(--font-body)">
                // Top bar
                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 20px; border-bottom: 1px solid var(--color-divider)">
                    <Segmented aria_label="Review period" options=&[("week", "Weekly"), ("month", "Monthly")] value=seg />
                    <div style="display: flex; align-items: center; gap: 4px">
                        {move || view! {
                            <Button variant="ghost" size="sm" icon="chevronLeft" aria_label=format!("Previous {}", period_word())
                                on_click=move || step_period(-1) />
                        }}
                        <span style="font-weight: 600; min-width: 0">{move || label.get()}</span>
                        {move || view! {
                            <Button variant="ghost" size="sm" icon="chevronRight" aria_label=format!("Next {}", period_word())
                                disabled=Signal::derive(is_current) on_click=move || step_period(1) />
                        }}
                    </div>
                    <div style="flex: 1"></div>
                    {(auto_secs > 0.0).then_some(move || {
                        let on = playing.get();
                        view! {
                            <Button variant="ghost" size="sm" icon=if on { "pause" } else { "play" }
                                on_click=move || playing.update(|p| *p = !*p)>
                                {if on { "Pause" } else { "Play" }}
                            </Button>
                        }
                    })}
                    {move || {
                        let on = fullscreen.get();
                        view! {
                            <Button variant="ghost" size="sm" icon=if on { "shrink" } else { "expand" } on_click=toggle_fullscreen>
                                {if on { "Exit full screen" } else { "Full screen" }}
                            </Button>
                        }
                    }}
                    <Button variant="secondary" size="sm" icon="close" on_click=close>"Close"</Button>
                </div>

                // Slide
                <div style="flex: 1; min-height: 0; overflow-y: auto; display: flex; padding: clamp(16px, 4vw, 48px)"
                    on:click=move |e| {
                        // Click the empty stage to advance, like a deck.
                        if e.target() == e.current_target() {
                            go(1);
                        }
                    }>
                    <div style="margin: auto; width: 100%; max-width: 1040px">{stage}</div>
                </div>

                // Bottom bar
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--color-divider)">
                    <Button variant="secondary" icon="arrowLeft" disabled=Signal::derive(move || safe.get() == 0) on_click=move || go(-1)>
                        "Back"
                    </Button>
                    <div style="display: flex; gap: 6px; align-items: center"
                        aria-label=move || format!("Slide {} of {}", safe.get() + 1, count())>
                        {move || (0..count()).map(|i| {
                            let on = move || safe.get() == i;
                            view! {
                                <button aria-label=format!("Go to slide {}", i + 1)
                                    aria-current=move || on().to_string()
                                    on:click=move |_| index.set(i)
                                    style=move || format!(
                                        "width: {}px; height: 8px; padding: 0; border: 0; border-radius: 99px; cursor: pointer; background: {}; transition: width .2s",
                                        if on() { 22 } else { 8 },
                                        if on() { "var(--color-accent)" } else { "var(--color-divider)" },
                                    )></button>
                            }
                        }).collect_view()}
                    </div>
                    <Button variant="primary" icon_end="arrowRight" disabled=Signal::derive(move || safe.get() + 1 >= count())
                        on_click=move || go(1)>
                        "Next"
                    </Button>
                </div>
            </div>
        </Portal>
    }
}

// ── Slides ──────────────────────────────────────────────────────────────

fn slide(id: SlideId, d: SlideData) -> AnyView {
    let label = d.label.clone();
    let period = d.review.period.as_str();
    match id {
        SlideId::Overview => overview_slide(d),
        SlideId::Categories => categories_slide(d),
        SlideId::Daily => view! {
            <SlideFrame kicker=label title="Day by day"><DailyBars review=d.review /></SlideFrame>
        }
        .into_any(),
        SlideId::Merchants => {
            let r = &d.review;
            let body = if r.top_merchants.is_empty() {
                empty(format!("No spending this {period}."))
            } else {
                rank_list(
                    r.top_merchants
                        .iter()
                        .map(|m| Rank {
                            name: m.name.clone(),
                            meta: format!("{} {}", m.count, if m.count == 1 { "charge" } else { "charges" }),
                            cents: m.spent_cents,
                            color: None,
                        })
                        .collect(),
                    Some(r.spending_cents),
                )
            };
            view! { <SlideFrame kicker=label title="Top merchants">{body}</SlideFrame> }.into_any()
        }
        SlideId::Largest => {
            let r = &d.review;
            let body = if r.largest_purchases.is_empty() {
                empty(format!("No purchases this {period}."))
            } else {
                rank_list(
                    r.largest_purchases
                        .iter()
                        .map(|t| Rank {
                            name: t.merchant_name.clone(),
                            meta: format!("{} · {}", short_date(&t.posted_at), t.category_name),
                            cents: -t.amount_cents,
                            color: Some(t.color.clone()),
                        })
                        .collect(),
                    Some(r.spending_cents),
                )
            };
            view! { <SlideFrame kicker=label title="Largest purchases">{body}</SlideFrame> }.into_any()
        }
        SlideId::Budgets => budgets_slide(d),
        SlideId::Bills => bills_slide(d),
        SlideId::Goals => goals_slide(d),
        SlideId::Ai => view! {
            <SlideFrame kicker=label title="AI summary">
                <div style="font-size: clamp(1.05rem, 2vw, 1.4rem); line-height: 1.65; white-space: pre-line; max-width: 760px">
                    {d.ai_summary}
                </div>
            </SlideFrame>
        }
        .into_any(),
    }
}

fn overview_slide(d: SlideData) -> AnyView {
    let r = d.review;
    let p = r.previous.clone();
    let compare = d.compare;
    let prev = move |c: i64| compare.then_some(c);
    let title = if r.period == ReviewPeriod::Week {
        "Your week in money"
    } else {
        "Your month in money"
    };
    let line = headline(&r, d.compare.then_some(&p), d.prev_word, &whole);
    let stats = [
        big_stat(
            "Income",
            r.income_cents,
            prev(p.income_cents),
            d.prev_word,
            true,
            false,
        ),
        big_stat(
            "Spending",
            r.spending_cents,
            prev(p.spending_cents),
            d.prev_word,
            false,
            false,
        ),
        big_stat(
            "Saved",
            r.saved_cents,
            prev(p.saved_cents),
            d.prev_word,
            true,
            true,
        ),
    ];
    view! {
        <SlideFrame kicker=d.label title=title>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px">
                {stats.into_iter().collect_view()}
            </div>
            <p style="margin-top: 22px; font-size: var(--text-base); color: var(--content-secondary)">{line}</p>
        </SlideFrame>
    }
    .into_any()
}

fn categories_slide(d: SlideData) -> AnyView {
    let top: Vec<_> = d.review.categories.iter().take(7).cloned().collect();
    let body = if top.is_empty() {
        empty(format!("No spending this {}.", d.review.period.as_str()))
    } else {
        let slices = top
            .iter()
            .map(|c| PieSlice {
                label: c.name.clone(),
                value: c.spent_cents,
                color: c.color.clone(),
            })
            .collect::<Vec<_>>();
        view! {
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 28px; align-items: center">
                <PieChart data=slices format=fmt::cents_whole center_label="spent"
                    aria_label=format!("{} spending by category", d.label) />
                <div style="display: flex; flex-direction: column">
                    {top.into_iter().map(|c| view! {
                        <div style=format!("display: flex; align-items: center; gap: 10px; padding: 9px 2px; {ROW_BORDER}")>
                            <span aria-hidden="true" style=format!("width: 10px; height: 10px; border-radius: var(--radius-sm); background: {}; flex: none", c.color)></span>
                            <span style="flex: 1; min-width: 0">{c.name}</span>
                            {d.compare.then(|| delta_view(c.spent_cents, c.previous_spent_cents, d.prev_word, false, true))}
                            <span style="font-weight: 600; min-width: 80px; text-align: right">{fmt::cents_whole(c.spent_cents)}</span>
                        </div>
                    }).collect_view()}
                </div>
            </div>
        }
        .into_any()
    };
    view! { <SlideFrame kicker=d.label title="Spending by category">{body}</SlideFrame> }.into_any()
}

/// Single-series bar chart: one bar per day, hover for the figure.
#[component]
fn DailyBars(review: PeriodReview) -> impl IntoView {
    let hover = RwSignal::new(None::<usize>);
    let days = review.daily_spending.clone();
    let (max, avg) = daily_stats(&review);
    let week = review.period == ReviewPeriod::Week;
    let gap = if week { 10 } else { 2 };
    let busiest_text = busiest(&days)
        .map(|d| format!("{} · {}", short_date(&d.date), whole(d.spent_cents)))
        .unwrap_or_else(|| "—".into());
    let shown = {
        let days = days.clone();
        move || hover.get().and_then(|i| days.get(i).cloned())
    };
    let shown2 = shown.clone();
    view! {
        <div>
            <div style="display: flex; gap: 24px; margin-bottom: 14px; flex-wrap: wrap">
                {mini_stat("daily average".into(), whole(avg))}
                {mini_stat("busiest day".into(), busiest_text)}
                {move || mini_stat(
                    shown().map_or_else(|| "hover a bar".into(), |d| fmt::weekday_date(&d.date)),
                    shown2().map_or_else(|| "—".into(), |d| whole(d.spent_cents)),
                )}
            </div>
            <div role="img" aria-label=format!("Spending per day, {} to {}", review.start, review.end)
                style=format!("display: flex; align-items: flex-end; gap: {gap}px; height: clamp(180px, 38vh, 340px); border-bottom: 1px solid var(--color-divider)")>
                {days.iter().enumerate().map(|(i, d)| {
                    let h = bar_height(d.spent_cents, max);
                    view! {
                        <div on:mouseenter=move |_| hover.set(Some(i)) on:mouseleave=move |_| hover.set(None)
                            title=format!("{}: {}", fmt::weekday_date(&d.date), whole(d.spent_cents))
                            style="flex: 1; height: 100%; display: flex; align-items: flex-end; cursor: default">
                            <div style=move || format!(
                                "width: 100%; height: {h}%; background: var(--color-accent); opacity: {}; border-radius: 4px 4px 0 0; transition: opacity .12s",
                                match hover.get() { None => "1", Some(j) if j == i => "1", _ => "0.45" },
                            )></div>
                        </div>
                    }
                }).collect_view()}
            </div>
            <div style=format!("display: flex; gap: {gap}px; margin-top: 6px")>
                {days.iter().enumerate().map(|(i, d)| {
                    let text = if week {
                        fmt::weekday_short(&d.date)
                    } else if month_tick(i) {
                        d.date.get(8..).and_then(|s| s.parse::<u32>().ok()).map(|n| n.to_string()).unwrap_or_default()
                    } else {
                        String::new()
                    };
                    view! {
                        <div style="flex: 1; text-align: center; font-size: var(--text-2xs); color: var(--content-tertiary)">{text}</div>
                    }
                }).collect_view()}
            </div>
        </div>
    }
}

fn budgets_slide(d: SlideData) -> AnyView {
    let Some(budgets) = d.extras.budgets.clone() else {
        return ().into_any();
    };
    let names = d.extras.categories;
    let rows = sorted_budgets(&budgets);
    let month_name = fmt::period_label(
        false,
        &format!("{}-01", budgets.month),
        &format!("{}-01", budgets.month),
    );
    let kicker = if d.review.period == ReviewPeriod::Week {
        format!("{} · {month_name} budgets", d.label)
    } else {
        d.label
    };
    view! {
        <SlideFrame kicker=kicker title="Budgets">
            <p style="margin-top: 0; color: var(--content-secondary)">
                {fmt::cents(budgets.total_spent_cents)}" spent of "{fmt::cents(budgets.total_budgeted_cents)}" budgeted"
            </p>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 28px">
                {rows.into_iter().take(10).map(|b| {
                    let cat = names.iter().find(|c| c.id == b.category_id);
                    let pct = budget_pct(&b);
                    let over = pct > 1.0;
                    let color = if over {
                        "var(--color-negative)".to_string()
                    } else {
                        cat.map_or_else(|| "var(--color-accent)".into(), |c| c.color.clone())
                    };
                    view! {
                        <div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 4px">
                                <span>{cat.map_or_else(|| "Category".to_string(), |c| c.name.clone())}</span>
                                <span style=if over { "font-weight: 600; color: var(--color-negative)" } else { "font-weight: 600" }>
                                    {fmt::cents(b.spent_cents)}" / "{fmt::cents(b.amount_cents)}
                                    {over.then_some(" · over")}
                                </span>
                            </div>
                            {bar(pct, color, false)}
                        </div>
                    }
                }).collect_view()}
            </div>
        </SlideFrame>
    }
    .into_any()
}

fn bills_slide(d: SlideData) -> AnyView {
    let week = d.review.period == ReviewPeriod::Week;
    let upcoming = upcoming_bills(&d.extras.bills, d.review.period);
    let total: i64 = upcoming.iter().map(|b| b.amount_cents).sum();
    let kicker = format!("Next {} days", if week { "7" } else { "31" });
    let body = if upcoming.is_empty() {
        empty(format!(
            "Nothing due in the next {}. 🎉",
            d.review.period.as_str()
        ))
    } else {
        let n = upcoming.len();
        let rows = upcoming
            .into_iter()
            .map(|b| Rank {
                meta: format!(
                    "{} · {}{}",
                    due_in(b.days_until_due),
                    short_date(&b.next_due_date),
                    if b.autopay { " · autopay" } else { "" }
                ),
                name: b.name,
                cents: b.amount_cents,
                color: Some(b.color),
            })
            .collect();
        view! {
            <p style="margin-top: 0; color: var(--content-secondary)">
                {format!("{n} {} · {} due", if n == 1 { "bill" } else { "bills" }, whole(total))}
            </p>
            {rank_list(rows, None)}
        }
        .into_any()
    };
    view! { <SlideFrame kicker=kicker title="Upcoming bills">{body}</SlideFrame> }.into_any()
}

fn goals_slide(d: SlideData) -> AnyView {
    view! {
        <SlideFrame kicker=d.label title="Savings goals">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px 28px">
                {d.extras.goals.into_iter().map(|g| {
                    let (pct, status) = goal_slide_status(&g);
                    let mut meta = format!(
                        "{} of {} ({}%)",
                        whole(g.saved_cents),
                        whole(g.target_cents),
                        vault_core::money::js_round(pct * 100.0).min(100)
                    );
                    if let Some(p) = g.projected_completion.as_ref().filter(|p| !p.is_empty()) {
                        meta.push_str(&format!(" · projected {p}"));
                    }
                    view! {
                        <div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 4px">
                                <span style="font-weight: 600">{g.name.clone()}</span>
                                {status.map(|s| {
                                    let color = if s == "Behind" { "var(--color-negative)" } else { "var(--color-positive)" };
                                    view! { <span style=format!("color: {color}; font-weight: 600")>{s}</span> }
                                })}
                            </div>
                            {bar(pct, g.color.clone(), false)}
                            <div style="font-size: var(--text-xs); color: var(--content-tertiary); margin-top: 4px">{meta}</div>
                        </div>
                    }
                }).collect_view()}
            </div>
        </SlideFrame>
    }
    .into_any()
}

// ── Building blocks ─────────────────────────────────────────────────────

const TITLE_STYLE: &str = "font-family: var(--font-heading); font-weight: 600; font-size: clamp(1.6rem, 3.6vw, 2.6rem); margin: 6px 0 24px; line-height: 1.15";

#[component]
fn SlideFrame(
    #[prop(into)] kicker: String,
    title: &'static str,
    children: Children,
) -> impl IntoView {
    view! {
        <section style="animation: fadeIn .25s ease">
            <div style="font-size: var(--text-xs); letter-spacing: .06em; text-transform: uppercase; color: var(--content-tertiary); font-weight: 600">
                {kicker}
            </div>
            <h2 style=TITLE_STYLE>{title}</h2>
            {children()}
        </section>
    }
}

fn big_stat(
    label: &'static str,
    cents: i64,
    prev: Option<i64>,
    prev_word: &'static str,
    good_when_up: bool,
    signed: bool,
) -> AnyView {
    let color = if signed {
        if cents >= 0 {
            "; color: var(--color-positive)"
        } else {
            "; color: var(--color-negative)"
        }
    } else {
        ""
    };
    view! {
        <div style="background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); padding: 18px 20px">
            <div style="font-size: var(--text-sm); color: var(--content-tertiary)">{label}</div>
            <div style=format!("font-family: var(--font-heading); font-weight: 600; font-size: clamp(1.8rem, 4vw, 2.8rem); margin: 4px 0 6px{color}")>
                {whole(cents)}
            </div>
            {prev.map(|p| delta_view(cents, p, prev_word, good_when_up, false))}
        </div>
    }
    .into_any()
}

/// "▲ 12% vs last month" — coloured by whether the change is good, with the
/// arrow so it's never colour alone.
fn delta_view(
    now: i64,
    prev: i64,
    prev_word: &'static str,
    good_when_up: bool,
    compact: bool,
) -> AnyView {
    let (text, good) = delta(now, prev, prev_word, good_when_up, compact, &whole);
    let color = match good {
        None => "var(--content-tertiary)",
        Some(true) => "var(--color-positive)",
        Some(false) => "var(--color-negative)",
    };
    view! {
        <span title=format!("{prev_word}: {}", whole(prev))
            style=format!("font-size: var(--text-xs); font-weight: 600; color: {color}")>
            {text}
        </span>
    }
    .into_any()
}

struct Rank {
    name: String,
    meta: String,
    cents: i64,
    color: Option<String>,
}

fn rank_list(rows: Vec<Rank>, total: Option<i64>) -> AnyView {
    let max = rank_max(&rows.iter().map(|r| r.cents).collect::<Vec<_>>());
    let total = total.filter(|t| *t != 0);
    view! {
        <div style="display: flex; flex-direction: column; gap: 14px">
            {rows.into_iter().enumerate().map(|(i, r)| view! {
                <div style="display: grid; grid-template-columns: 28px 1fr auto; gap: 4px 12px; align-items: center">
                    <span style="color: var(--content-tertiary); font-weight: 600">{i + 1}</span>
                    <div style="min-width: 0">
                        <div style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{r.name}</div>
                        <div style="font-size: var(--text-xs); color: var(--content-tertiary)">{r.meta}</div>
                    </div>
                    <div style="text-align: right">
                        <div style="font-weight: 600; font-size: var(--text-lg)">{whole(r.cents)}</div>
                        {total.map(|t| view! {
                            <div style="font-size: var(--text-2xs); color: var(--content-tertiary)">
                                {share_of(r.cents, t)}"% of spending"
                            </div>
                        })}
                    </div>
                    <div style="grid-column: 2 / 4">
                        {bar(r.cents as f64 / max as f64, r.color.unwrap_or_else(|| "var(--color-accent)".into()), true)}
                    </div>
                </div>
            }).collect_view()}
        </div>
    }
    .into_any()
}

fn bar(pct: f64, color: String, thin: bool) -> AnyView {
    let h = if thin { 4 } else { 7 };
    view! {
        <div style=format!("height: {h}px; border-radius: 99px; background: var(--color-neutral-900); overflow: hidden")>
            <div style=format!("height: 100%; width: {}%; background: {color}; border-radius: 99px", bar_width(pct))></div>
        </div>
    }
    .into_any()
}

fn mini_stat(label: String, value: String) -> AnyView {
    view! {
        <div>
            <div style="font-family: var(--font-heading); font-weight: 600; font-size: var(--text-xl)">{value}</div>
            <div style="font-size: var(--text-xs); color: var(--content-tertiary)">{label}</div>
        </div>
    }
    .into_any()
}

fn empty(text: String) -> AnyView {
    view! { <p style="color: var(--content-tertiary); font-size: var(--text-base)">{text}</p> }
        .into_any()
}

/// `shortDate`: "Nov 18" from a day or an ISO timestamp.
fn short_date(day: &str) -> String {
    fmt::day_short(day.get(..10).unwrap_or(day))
}
