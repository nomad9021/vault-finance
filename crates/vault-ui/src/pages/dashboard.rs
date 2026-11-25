//! Dashboard (the home screen): port of
//! apps/desktop/src/screens/shell/DashboardPage.tsx. Every card is a widget
//! the person can move, hide or resize (edit mode); the layout is saved to
//! their account. The figures and layout rules are in `vault_core::home`,
//! arranging in [`crate::ui::HomeArrange`].

use std::collections::HashMap;
use std::time::Duration;

use leptos::html;
use leptos::prelude::*;
use vault_core::accounts::{Account, AccountListResponse};
use vault_core::balance_view::{available_cents, shown_balance};
use vault_core::bills::{due_label, Bill, BillListResponse, DueTone};
use vault_core::budget_period::shift_month;
use vault_core::budget_sankey::{
    build_budget_sankey, build_budget_vs_actual, pre_income_branches, with_gross_branch,
    with_tax_branch,
};
use vault_core::budgets::{BudgetListResponse, BudgetPlan, PreIncome};
use vault_core::cashflow::{TrendPoint, TrendsResponse};
use vault_core::categories::{Category, CategoryKind, CategoryListResponse};
use vault_core::dashboard::{ResolvedWidget, SankeyView, DASHBOARD_WIDGETS};
use vault_core::goals::{Goal, GoalListResponse};
use vault_core::home::{
    available_views, commit_order, days_left_in_month, default_month, edit_items, effective_view,
    gain_pct_label, goal_plan_line, goal_progress, home_layout, next_span, parse_sankey_view,
    patch_widget, plan_off, ranked_budgets, safe_to_spend, savings_rate, span_label, to_saved,
    top_goals, trend_summary, view_items, SANKEY_VIEWS,
};
use vault_core::investments::InvestmentsResponse;
use vault_core::nav::NavFilter;
use vault_core::preferences::Preferences;
use vault_core::sankey::{SankeyGraph, SankeyResponse};
use vault_core::taxes::TaxProfileResponse;
use vault_core::transactions::{Transaction, TransactionListResponse, TransactionQuery};
use vault_core::trend_chart::project;

use crate::balance_view::use_show_actual_balances;
use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::pages::budgets::last_ok;
use crate::storage;
use crate::ui::{
    use_narrow, Button, Card, Dialog, EmptyState, GuiltFreeCard, HomeArrange, Icon, ListRow,
    MetricCard, Money, Panel, PanelLink, PreIncomeDialog, ProgressBar, SankeyCard, SegmentedOf,
    Sheet, Skeleton, TrendChart,
};

const SANKEY_VIEW_KEY: &str = "dashboard-sankey-view";
const FROM_GROSS_KEY: &str = "vault.dashboard.from-gross";

/// `new Date().toISOString().slice(0, 7)`.
fn current_month() -> String {
    crate::pages::budgets::current_month()
}

/// `daysLeftInMonth()` for today (UTC).
fn days_left() -> u32 {
    let d = js_sys::Date::new_0();
    days_left_in_month(
        d.get_utc_full_year() as i32,
        d.get_utc_month() + 1,
        d.get_utc_date(),
    )
}

/// `useCountUp`: glides to a new value in 300ms (at once with Reduced Motion).
fn use_count_up(target: Memo<i64>) -> ReadSignal<f64> {
    let (shown, set_shown) = signal(target.get_untracked() as f64);
    let from = StoredValue::new(0.0_f64);
    let raf = StoredValue::new_local(None::<AnimationFrameRequestHandle>);
    Effect::new(move || {
        let target = target.get() as f64;
        if let Some(h) = raf.try_update_value(|r| r.take()).flatten() {
            h.cancel();
        }
        let reduce = window()
            .match_media("(prefers-reduced-motion: reduce)")
            .ok()
            .flatten()
            .is_some_and(|m| m.matches());
        if reduce {
            from.set_value(target);
            set_shown.set(target);
            return;
        }
        let start_from = from.get_value();
        let now = || window().performance().map(|p| p.now()).unwrap_or(0.0);
        let start = now();
        fn step(
            start: f64,
            a: f64,
            b: f64,
            from: StoredValue<f64>,
            set: WriteSignal<f64>,
            raf: StoredValue<Option<AnimationFrameRequestHandle>, LocalStorage>,
        ) {
            let t_now = window().performance().map(|p| p.now()).unwrap_or(0.0);
            let t = ((t_now - start) / 300.0).min(1.0);
            let v = a + (b - a) * (1.0 - (1.0 - t).powi(4));
            from.set_value(v);
            set.set(v);
            if t < 1.0 {
                let h =
                    request_animation_frame_with_handle(move || step(start, a, b, from, set, raf))
                        .ok();
                raf.set_value(h);
            }
        }
        let h = request_animation_frame_with_handle(move || {
            step(start, start_from, target, from, set_shown, raf)
        })
        .ok();
        raf.set_value(h);
    });
    shown
}

/// "November".
fn month_long(month: &str) -> String {
    fmt::month_long(month)
}

/// The `"YYYY-MM"` of a goal date: "Sep 2027".
fn month_year(month: &str) -> String {
    fmt::month_short_year(month)
}

fn tone_color(tone: DueTone) -> &'static str {
    match tone {
        DueTone::Over => "var(--color-negative)",
        DueTone::Soon => "var(--color-warning)",
        DueTone::Ok => "var(--content-tertiary)",
    }
}

/// A resource that keeps its last good value (useData's `data`).
macro_rules! fetch {
    ($ver:expr, $ty:ty, $method:literal $(, $arg:expr)* ) => {{
        let ver = $ver;
        let data_version = use_host().data_version;
        let res = LocalResource::new(move || {
            data_version.track();
            ver.track();
            let host = use_host();
            async move { host.call::<$ty>($method, &[$($arg.into()),*]).await }
        });
        last_ok(res)
    }};
}

/// Everything the cards read, all `Copy`.
#[derive(Clone, Copy)]
struct Dash {
    month: Memo<String>,
    picked_month: RwSignal<Option<String>>,
    is_current: Memo<bool>,
    accounts: Memo<Vec<Account>>,
    net_worth: Memo<i64>,
    income: Memo<i64>,
    spending: Memo<i64>,
    savings_rate: Memo<Option<i64>>,
    points: Memo<Vec<TrendPoint>>,
    budget: Memo<Option<BudgetListResponse>>,
    categories: Memo<Vec<Category>>,
    bills: Memo<Vec<Bill>>,
    invest: Memo<Option<InvestmentsResponse>>,
    txns: Memo<Vec<Transaction>>,
    goals: Memo<Vec<Goal>>,
    planned_income: Memo<i64>,
    go: Callback<(&'static str, NavFilter)>,
    sankey: Sankey,
}

#[derive(Clone, Copy)]
struct Sankey {
    loading: Memo<bool>,
    has_data: Memo<bool>,
    has_plan: Memo<bool>,
    sankey_month: Memo<String>,
    actual: Memo<SankeyGraph>,
    plan: Memo<SankeyGraph>,
    combined: Memo<SankeyGraph>,
    views: Memo<Vec<SankeyView>>,
    view: Memo<SankeyView>,
    set_view: Callback<SankeyView>,
    has_branches: Memo<bool>,
    from_gross: RwSignal<bool>,
    toggle_gross: Callback<bool>,
    has_pre_income: Memo<bool>,
    editing_pre_income: RwSignal<bool>,
    reload: Callback<()>,
}

impl Dash {
    fn nav(self, page: &'static str) -> impl Fn() + Copy + 'static {
        move || self.go.run((page, NavFilter::default()))
    }
}

#[component]
pub fn DashboardPage() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let phone = use_narrow();
    let week_start = Memo::new(move |_| app.with(|a| a.review_prefs.week_starts_on.clone()));
    // Settings → General → Home screen can hide the cash-flow diagram (per device).
    let hide_sankey = Memo::new(move |_| app.with(|a| !a.show_sankey.unwrap_or(true)));
    let ai_visible = Memo::new(move |_| app.with(|a| a.ai_visible));

    let go = {
        let host = host.clone();
        Callback::new(move |(page, filter): (&'static str, NavFilter)| host.navigate(page, &filter))
    };

    // Trends come first: six months of income/spending choose the default month.
    let none = RwSignal::new(0_u32);
    let trends = fetch!(none, TrendsResponse, "trends", 6);
    let points = Memo::new(move |_| trends.get().map(|t| t.points).unwrap_or_default());
    let picked_month = RwSignal::new(None::<String>);
    let month = Memo::new(move |_| {
        picked_month
            .get()
            .unwrap_or_else(|| points.with(|p| default_month(p, &current_month())))
    });
    let is_current = Memo::new(move |_| month.get() == current_month());

    let accounts_v = RwSignal::new(0_u32);
    let sankey_v = RwSignal::new(0_u32);
    let txns_v = RwSignal::new(0_u32);
    let pre_v = RwSignal::new(0_u32);

    let account_data = fetch!(accounts_v, AccountListResponse, "accounts");
    let data_version = host.data_version;
    let sankey_res = LocalResource::new(move || {
        data_version.track();
        sankey_v.track();
        let m = month.get();
        let host = use_host();
        async move { host.call::<SankeyResponse>("sankey", &[m.into()]).await }
    });
    let sankey_data = last_ok(sankey_res);
    let txn_res = LocalResource::new(move || {
        data_version.track();
        txns_v.track();
        let host = use_host();
        async move {
            let q = HostCtx::arg(&TransactionQuery {
                limit: Some(6),
                ..Default::default()
            });
            host.call::<TransactionListResponse>("transactions", &[q])
                .await
        }
    });
    let txn_data = last_ok(txn_res);
    let goal_data = fetch!(none, GoalListResponse, "goals");
    let budget_res = LocalResource::new(move || {
        data_version.track();
        let (m, w) = (month.get(), week_start.get());
        let host = use_host();
        async move {
            host.call::<BudgetListResponse>("budgets", &[m.into(), w.into()])
                .await
        }
    });
    let budget_data = last_ok(budget_res);
    let category_data = fetch!(none, CategoryListResponse, "categories");
    let bill_data = fetch!(none, BillListResponse, "bills");
    let invest_data = fetch!(none, InvestmentsResponse, "investments");
    let plan_data = fetch!(none, BudgetPlan, "budgetPlan");
    // The person's own arrangement, saved to their account.
    let saved_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move {
            Ok::<_, String>(
                host.call::<Preferences>("preferences", &[])
                    .await
                    .unwrap_or_default(),
            )
        }
    });
    let saved_prefs = last_ok(saved_res);
    let prefs = RwSignal::new(None::<Preferences>);
    Effect::new(move || {
        if let Some(p) = saved_prefs.get() {
            prefs.set(Some(p));
        }
    });
    let editing = RwSignal::new(false);

    // Before income: the tax estimate and/or the user's own taxes and deductions.
    let tax_data = fetch!(none, TaxProfileResponse, "taxProfile");
    let tax_estimate = Memo::new(move |_| tax_data.get().and_then(|t| t.estimate));
    let pre_res =
        LocalResource::new(move || {
            data_version.track();
            pre_v.track();
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
    let from_gross = RwSignal::new(storage::get(FROM_GROSS_KEY).as_deref() != Some("off"));
    let toggle_gross = Callback::new(move |on: bool| {
        from_gross.set(on);
        storage::set(FROM_GROSS_KEY, if on { "on" } else { "off" });
    });

    // Which diagram leads: saved to the account, this device's old choice as fallback.
    let sankey_view = Memo::new(move |_| {
        prefs
            .with(|p| p.as_ref().and_then(|p| p.sankey_view))
            .unwrap_or_else(|| parse_sankey_view(storage::get(SANKEY_VIEW_KEY).as_deref()))
    });
    let set_view = {
        let host = host.clone();
        Callback::new(move |v: SankeyView| {
            prefs.update(|p| p.get_or_insert_with(Default::default).sankey_view = Some(v));
            host.fire(
                "savePreferences",
                &[HostCtx::arg(&Preferences {
                    sankey_view: Some(v),
                    ..Default::default()
                })],
            );
            storage::set(SANKEY_VIEW_KEY, v.as_str());
        })
    };

    // Poll so bank auto-sync / webhook imports show up without a refresh.
    if let Ok(h) = set_interval_with_handle(
        move || {
            sankey_v.update(|v| *v += 1);
            accounts_v.update(|v| *v += 1);
            txns_v.update(|v| *v += 1);
        },
        Duration::from_secs(90),
    ) {
        on_cleanup(move || h.clear());
    }

    let accounts = Memo::new(move |_| account_data.get().map(|a| a.accounts).unwrap_or_default());
    let net_worth = Memo::new(move |_| accounts.with(|a| a.iter().map(|a| a.balance_cents).sum()));
    let income =
        Memo::new(move |_| sankey_data.with(|s| s.as_ref().map_or(0, |s| s.total_income_cents)));
    let spending =
        Memo::new(move |_| sankey_data.with(|s| s.as_ref().map_or(0, |s| s.total_spending_cents)));
    let rate = Memo::new(move |_| savings_rate(income.get(), spending.get()));
    let has_data =
        Memo::new(move |_| sankey_data.with(|s| s.as_ref().is_some_and(|s| !s.links.is_empty())));
    let categories = Memo::new(move |_| {
        category_data
            .get()
            .map(|c| c.categories)
            .unwrap_or_default()
    });

    // The planned diagram, built like the Budgets planner's.
    let planned_income =
        Memo::new(move |_| plan_data.with(|p| p.as_ref().map_or(0, |p| p.planned_income_cents)));
    let branches = Memo::new(move |_| {
        let est = tax_estimate.get();
        pre_income.with(|p| pre_income_branches(est.as_ref(), p.as_ref()))
    });
    let gross = Memo::new(move |_| from_gross.get() && branches.with(|b| !b.is_empty()));
    let plan_base = Memo::new(move |_| {
        let by_cat: HashMap<String, i64> = budget_data.with(|b| {
            b.as_ref()
                .map(|b| {
                    b.budgets
                        .iter()
                        .map(|b| (b.category_id.clone(), b.amount_cents))
                        .collect()
                })
                .unwrap_or_default()
        });
        let cats: Vec<Category> = categories.with(|c| {
            c.iter()
                .filter(|c| c.kind == CategoryKind::Expense)
                .cloned()
                .collect()
        });
        build_budget_sankey(planned_income.get(), &cats, &by_cat)
    });
    let plan = Memo::new(move |_| {
        let base = plan_base.get().graph;
        if gross.get() && planned_income.get() > 0 {
            branches.with(|b| with_tax_branch(base, b))
        } else {
            base
        }
    });
    let actual = Memo::new(move |_| {
        let g: SankeyGraph = sankey_data.get().map(Into::into).unwrap_or_default();
        if gross.get() {
            branches.with(|b| with_gross_branch(g, b))
        } else {
            g
        }
    });
    let has_plan =
        Memo::new(move |_| planned_income.get() > 0 || plan_base.with(|p| p.allocated > 0));
    let vs_actual = Memo::new(move |_| {
        let (budgets, unbudgeted) = budget_data.with(|b| {
            b.as_ref()
                .map(|b| {
                    (
                        b.budgets.clone(),
                        b.unbudgeted_spending.clone().unwrap_or_default(),
                    )
                })
                .unwrap_or_default()
        });
        categories.with(|c| build_budget_vs_actual(&budgets, &unbudgeted, c, fmt::cents))
    });
    let views = Memo::new(move |_| {
        available_views(
            has_data.get(),
            has_plan.get(),
            vs_actual.with(|v| !v.rows.is_empty()),
        )
    });
    let view = Memo::new(move |_| views.with(|v| effective_view(sankey_view.get(), v)));

    let d = Dash {
        month,
        picked_month,
        is_current,
        accounts,
        net_worth,
        income,
        spending,
        savings_rate: rate,
        points,
        budget: budget_data,
        categories,
        bills: Memo::new(move |_| bill_data.get().map(|b| b.bills).unwrap_or_default()),
        invest: invest_data,
        txns: Memo::new(move |_| txn_data.get().map(|t| t.transactions).unwrap_or_default()),
        goals: Memo::new(move |_| goal_data.get().map(|g| g.goals).unwrap_or_default()),
        planned_income,
        go,
        sankey: Sankey {
            loading: Memo::new(move |_| {
                sankey_res.get().is_none() && sankey_data.with(Option::is_none)
            }),
            has_data,
            has_plan,
            sankey_month: Memo::new(move |_| {
                sankey_data.with(|s| s.as_ref().map(|s| s.month.clone()).unwrap_or_default())
            }),
            actual,
            plan,
            combined: Memo::new(move |_| vs_actual.with(|v| v.graph.clone())),
            views,
            view,
            set_view,
            has_branches: Memo::new(move |_| branches.with(|b| !b.is_empty())),
            from_gross,
            toggle_gross,
            has_pre_income: Memo::new(move |_| pre_income.with(Option::is_some)),
            editing_pre_income,
            reload: Callback::new(move |_| sankey_v.update(|v| *v += 1)),
        },
    };

    // ── Layout ──
    let save_layout = {
        let host = host.clone();
        Callback::new(move |next: Option<Vec<ResolvedWidget>>| {
            let dashboard = to_saved(next.as_deref());
            prefs.update(|p| {
                p.get_or_insert_with(Default::default).dashboard = Some(dashboard.clone())
            });
            host.fire(
                "savePreferences",
                &[HostCtx::arg(&Preferences {
                    dashboard: Some(dashboard),
                    ..Default::default()
                })],
            );
        })
    };
    let layout = Memo::new(move |_| {
        let p = phone.get();
        prefs.with(|pr| home_layout(p, pr.as_ref().and_then(|p| p.dashboard.as_deref())))
    });
    let view_list =
        Memo::new(move |_| layout.with(|l| view_items(l, hide_sankey.get(), phone.get())));
    let first_metric = Memo::new(move |_| view_list.with(|v| v.1.clone()));
    let items = Memo::new(move |_| {
        if editing.get() {
            layout.with(|l| edit_items(l))
        } else {
            view_list.with(|v| v.0.clone())
        }
    });
    let hidden = Memo::new(move |_| {
        layout.with(|l| l.iter().filter(|w| w.hidden).cloned().collect::<Vec<_>>())
    });
    let set_widget =
        move |id: String, hide: Option<bool>, span: Option<vault_core::dashboard::Span>| {
            save_layout.run(Some(
                layout.with_untracked(|l| patch_widget(l, &id, hide, span)),
            ));
        };
    let grid = NodeRef::<html::Div>::new();
    let arrange = HomeArrange::new(
        grid,
        Signal::derive(move || items.with(|i| i.iter().map(|w| w.id.clone()).collect())),
        editing.into(),
        Callback::new(move |_| editing.set(true)),
        // The visible cards in their new order; hidden ones keep their place after.
        Callback::new(move |ids: Vec<String>| {
            save_layout.run(Some(layout.with_untracked(|l| commit_order(l, &ids))));
        }),
    );
    let add_open = RwSignal::new(false);
    let label_of = |id: &str| {
        DASHBOARD_WIDGETS
            .iter()
            .find(|w| w.id == id)
            .map_or(id.to_string(), |w| w.label.to_string())
    };

    let order = {
        let arrange = arrange.clone();
        move || arrange.order()
    };
    let card = {
        let arrange = arrange.clone();
        move |id: String| {
            let arrange = arrange.clone();
            let label = label_of(&id);
            let span = {
                let id = id.clone();
                Memo::new(move |_| items.with(|i| i.iter().find(|w| w.id == id).map(|w| w.span)))
            };
            let is_first_metric = {
                let id = id.clone();
                Memo::new(move |_| first_metric.with(|f| f.as_deref() == Some(id.as_str())))
            };
            let dragging = {
                let id = id.clone();
                let drag = arrange.drag_id;
                move || {
                    drag.with(|dr| dr.as_deref() == Some(id.as_str()))
                        .then_some("true")
                }
            };
            let (down, key, ctx) = {
                let (a, b, c) = (arrange.clone(), arrange.clone(), arrange.clone());
                let (i1, i2) = (id.clone(), id.clone());
                (
                    move |e: web_sys::PointerEvent| a.on_pointer_down(&i1, &e),
                    move |e: web_sys::KeyboardEvent| b.on_key_down(&i2, &e),
                    move |e: web_sys::MouseEvent| c.on_context_menu(&e),
                )
            };
            let aria = {
                let label = label.clone();
                move || {
                    editing
                        .get()
                        .then(|| format!("{label}. Arrow keys move it."))
                }
            };
            let body = {
                let id = id.clone();
                let label = label.clone();
                move || {
                    if editing.get() {
                        let (hide_id, size_id) = (id.clone(), id.clone());
                        let label = label.clone();
                        let current = move || span.get().map(span_label).unwrap_or_default();
                        view! {
                            <button type="button" class="home-card-remove" data-no-drag="" aria-label=format!("Hide {label}")
                                title=format!("Hide {label}")
                                on:click=move |_| set_widget(hide_id.clone(), Some(true), None)>
                                <span aria-hidden="true"></span>
                            </button>
                            <div class="home-card-body" inert=true>{widget(&id, d, ai_visible)}</div>
                            {move || (!phone.get()).then(|| {
                                let size_id = size_id.clone();
                                let label = label.clone();
                                view! {
                                    <button type="button" class="home-card-size" data-no-drag="" title="Change the width"
                                        aria-label=move || format!("Width of {label}: {}. Change it.", current())
                                        on:click=move |_| {
                                            if let Some(s) = span.get_untracked() {
                                                set_widget(size_id.clone(), None, Some(next_span(s)));
                                            }
                                        }>
                                        {current}
                                    </button>
                                }
                            })}
                        }
                        .into_any()
                    } else if phone.get() && is_first_metric.get() {
                        view! { <PhoneSummary d=d /> }.into_any()
                    } else {
                        widget(&id, d, ai_visible)
                    }
                }
            };
            view! {
                <div class=move || format!("col-{} home-card", if phone.get() { 12 } else { span.get().map_or(12, |s| s.cols()) })
                    data-arrange-id=id.clone()
                    data-editing=move || editing.get().then_some("true")
                    data-dragging=dragging
                    tabindex=move || editing.get().then_some("0")
                    aria-label=aria
                    on:pointerdown=down on:keydown=key on:contextmenu=ctx>
                    {body}
                </div>
            }
        }
    };

    let add_body = move || {
        view! {
            <div class="stack">
                {move || if hidden.with(Vec::is_empty) {
                    view! { <p class="t-sm t-tertiary">"Every card is already on your home screen."</p> }.into_any()
                } else {
                    hidden.get().into_iter().map(|w| {
                        let id = w.id.clone();
                        view! {
                            <ListRow title=label_of(&w.id) chevron=false
                                trailing=view! { <Icon name="plus" size=16 /> }.into_any()
                                on_click=Callback::new(move |_| {
                                    let last = hidden.with_untracked(|h| h.len() == 1);
                                    set_widget(id.clone(), Some(false), None);
                                    if last {
                                        add_open.set(false);
                                    }
                                }) />
                        }
                    }).collect_view().into_any()
                }}
                <Button variant="ghost" size="sm" on_click=move || {
                    save_layout.run(None);
                    add_open.set(false);
                }>"Reset to the standard layout"</Button>
            </div>
        }
    };

    view! {
        <div class="page">
            {move || if editing.get() {
                view! {
                    <div class="home-edit-bar" role="toolbar" aria-label="Editing your home screen">
                        <Button variant="secondary" size="sm" icon="plus" aria_label="Add a card" on_click=move || add_open.set(true)>
                            {move || if phone.get() { "" } else { "Add card" }}
                        </Button>
                        <span class="home-edit-hint t-xs t-tertiary">
                            {move || format!("Drag cards to move them{}", if phone.get() { "" } else { ", tap the size to resize" })}
                        </span>
                        <Button variant="primary" size="sm" on_click=move || editing.set(false)>"Done"</Button>
                    </div>
                }.into_any()
            } else {
                view! {
                    <div class="row-between wrap" style="margin-bottom: -8px">
                        <span class="t-xs t-tertiary">{move || if phone.get() { "" } else { "Tip: hold a card to rearrange" }}</span>
                        <Button variant="ghost" size="sm" icon="edit" on_click=move || editing.set(true)>"Edit home screen"</Button>
                    </div>
                }.into_any()
            }}
            <div class="grid home-grid" node_ref=grid data-editing=move || editing.get().then_some("true")
                on:click=move |e| {
                    // Tapping empty space finishes editing, like the iPhone.
                    if editing.get_untracked() && e.target() == e.current_target() {
                        editing.set(false);
                    }
                }>
                <For each=order key=|id| id.clone() children=card />
            </div>
            {move || add_open.get().then(|| if phone.get_untracked() {
                view! { <Sheet title="Add a card" on_close=move || add_open.set(false)>{add_body()}</Sheet> }.into_any()
            } else {
                view! { <Dialog title="Add a card" on_close=move || add_open.set(false)>{add_body()}</Dialog> }.into_any()
            })}
            {move || {
                // Opened once per click: a background refetch mustn't reset what's typed.
                if !editing_pre_income.get() || !d.sankey.has_pre_income.get() {
                    return None;
                }
                let value = pre_income.get_untracked()?;
                Some(view! {
                    <PreIncomeDialog value=value has_estimate=tax_estimate.with_untracked(Option::is_some)
                        on_close=move || editing_pre_income.set(false)
                        on_saved=move |_| {
                            editing_pre_income.set(false);
                            toggle_gross.run(true);
                            pre_v.update(|v| *v += 1);
                        } />
                })
            }}
        </div>
    }
}

/// One widget's content.
fn widget(id: &str, d: Dash, ai_visible: Memo<bool>) -> AnyView {
    let month_label = move || month_long(&d.month.get());
    match id {
        "metric-networth" => view! {
            <MetricCard label="Net worth" icon="bank" hint="Across all accounts"
                value=Signal::derive(move || fmt::cents_whole(d.net_worth.get()))
                on_click=Callback::new(move |_| d.nav("accounts")()) />
        }
        .into_any(),
        "metric-income" => (move || {
            view! {
                <MetricCard label=format!("Income · {}", month_label()) icon="income"
                    value=Signal::derive(move || fmt::cents_whole(d.income.get()))
                    on_click=Callback::new(move |_| d.nav("income")()) />
            }
        })
        .into_any(),
        "metric-spending" => (move || {
            view! {
                <MetricCard label=format!("Spending · {}", month_label()) icon="card"
                    value=Signal::derive(move || fmt::cents_whole(d.spending.get()))
                    on_click=Callback::new(move |_| d.nav("reports")()) />
            }
        })
        .into_any(),
        "metric-savings" => (move || {
            let rate = d.savings_rate.get();
            view! {
                <MetricCard label="Savings rate" icon="target" hint="of income kept"
                    value=rate.map_or("—".to_string(), |r| format!("{r}%"))
                    delta_tone={if rate.is_some_and(|r| r >= 0) { "up" } else { "down" }} />
            }
        })
        .into_any(),
        "sankey" => view! { <SankeySection d=d ai_visible=ai_visible /> }.into_any(),
        "this-month" => view! { <ThisMonth d=d /> }.into_any(),
        "accounts" => view! { <AccountsCard d=d /> }.into_any(),
        "trend-networth" => view! {
            <TrendCard label="Net worth" d=d pick=|p| p.net_worth_cents color="var(--viz-2)" good_when_up=true page="accounts" />
        }
        .into_any(),
        "trend-income" => view! {
            <TrendCard label="Income" d=d pick=|p| p.income_cents color="var(--viz-3)" good_when_up=true page="income" />
        }
        .into_any(),
        "trend-spending" => view! {
            <TrendCard label="Spending" d=d pick=|p| p.spending_cents color="var(--viz-1)" good_when_up=false page="reports" />
        }
        .into_any(),
        "budgets" => view! { <BudgetOverview d=d /> }.into_any(),
        "bills" => view! { <UpcomingBills d=d /> }.into_any(),
        "investments" => view! { <InvestmentsCard d=d /> }.into_any(),
        "recent" => view! { <RecentActivity d=d /> }.into_any(),
        "goals" => view! { <TopGoals d=d /> }.into_any(),
        "guilt-free" => view! { <GuiltFreeCard /> }.into_any(),
        _ => ().into_any(),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum SankeyMode {
    Loading,
    Diagram,
    GetStarted,
}

#[component]
fn SankeySection(d: Dash, ai_visible: Memo<bool>) -> impl IntoView {
    let s = d.sankey;
    let mode = Memo::new(move |_| {
        if s.loading.get() {
            SankeyMode::Loading
        } else if s.has_data.get() || s.has_plan.get() {
            SankeyMode::Diagram
        } else {
            SankeyMode::GetStarted
        }
    });
    let nodes = |g: Memo<SankeyGraph>| Signal::derive(move || g.with(|g| g.nodes.clone()));
    let links = |g: Memo<SankeyGraph>| Signal::derive(move || g.with(|g| g.links.clone()));
    let month: Signal<String> = d.month.into();
    let sankey_month: Signal<String> = s.sankey_month.into();
    let options = Signal::derive(move || {
        s.views.with(|vs| {
            SANKEY_VIEWS
                .iter()
                .filter(|(v, _)| vs.contains(v))
                .map(|(v, l)| (v.as_str().to_string(), l.to_string()))
                .collect::<Vec<_>>()
        })
    });
    let diagram = move || {
        let view_now = s.view.get();
        match view_now {
            SankeyView::Both => view! {
                <div class="grid">
                    <div class="col-6">
                        <SankeyCard compact=true title="Actual".to_string() nodes=nodes(s.actual) links=links(s.actual)
                            month=sankey_month on_changed=s.reload />
                    </div>
                    <div class="col-6">
                        <SankeyCard compact=true title="Planned".to_string() nodes=nodes(s.plan) links=links(s.plan) month=month />
                    </div>
                </div>
            }
            .into_any(),
            SankeyView::Combined => view! {
                <SankeyCard editable=true single_period=true title="Budget vs actual".to_string()
                    hint="Budget flows in on the left, spending out on the right".to_string()
                    nodes=nodes(s.combined) links=links(s.combined) month=month />
            }
            .into_any(),
            SankeyView::Planned => view! {
                <SankeyCard editable=true title="Budget plan".to_string()
                    hint="Click a category to see this month's actual spending".to_string()
                    nodes=nodes(s.plan) links=links(s.plan) month=month />
            }
            .into_any(),
            SankeyView::Actual => view! {
                <SankeyCard editable=true nodes=nodes(s.actual) links=links(s.actual)
                    month=sankey_month on_changed=s.reload />
            }
            .into_any(),
        }
    };
    move || {
        match mode.get() {
        SankeyMode::Loading => view! { <Panel><Skeleton height=360 /></Panel> }.into_any(),
        SankeyMode::GetStarted => view! { <GetStarted d=d ai_visible=ai_visible /> }.into_any(),
        SankeyMode::Diagram => view! {
            <div class="stack">
                <div class="row-between wrap">
                    <div class="row" style="gap: var(--space-1)">
                        <Button variant="ghost" size="sm" icon="chevronLeft" aria_label="Previous month"
                            on_click=move || d.picked_month.set(Some(shift_month(&d.month.get_untracked(), -1))) />
                        <span class="eyebrow" style="min-width: 108px; text-align: center">{move || month_long(&d.month.get())}</span>
                        <Button variant="ghost" size="sm" icon="chevronRight" aria_label="Next month"
                            disabled=Signal::derive(move || d.month.get() >= current_month())
                            on_click=move || d.picked_month.set(Some(shift_month(&d.month.get_untracked(), 1))) />
                        // Says plainly why you're not looking at the current month.
                        {move || (!d.is_current.get()).then(|| view! {
                            <button class="panel-link" on:click=move |_| d.picked_month.set(Some(current_month()))>
                                {format!("{} has no activity yet — jump to it", month_long(&current_month()))}
                            </button>
                        })}
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
                        {move || s.has_branches.get().then(|| view! {
                            <label class="radio" style="font-size: var(--text-sm)" title="Show taxes and deductions coming off gross pay before income">
                                <input type="checkbox" prop:checked=move || s.from_gross.get()
                                    on:change=move |e| s.toggle_gross.run(event_target_checked(&e)) />
                                <span class="dot" style="border-radius: var(--radius-sm)"></span>
                                "From gross pay"
                            </label>
                        })}
                        <Button variant="ghost" size="sm" icon="edit" disabled=Signal::derive(move || !s.has_pre_income.get())
                            on_click=move || s.editing_pre_income.set(true)>
                            "Before income"
                        </Button>
                        <SegmentedOf options=options aria_label="Which cash-flow diagram to show"
                            value=Signal::derive(move || s.view.get().as_str().to_string())
                            on_change=move |v: String| s.set_view.run(parse_sankey_view(Some(&v))) />
                    </div>
                </div>
                {diagram}
            </div>
        }
        .into_any(),
    }
    }
}

/// Where the plan meets the bank, and what's safe to spend.
#[component]
fn ThisMonth(d: Dash) -> impl IntoView {
    let title = move || format!("{}: plan vs actual", month_long(&d.month.get()));
    let subtitle = Signal::derive(move || {
        if d.is_current.get() {
            format!("{} days left", days_left())
        } else {
            "Past month".into()
        }
    });
    let safe = Memo::new(move |_| {
        let budgets = d
            .budget
            .with(|b| b.as_ref().map(|b| b.budgets.clone()).unwrap_or_default());
        d.categories
            .with(|c| d.bills.with(|bills| safe_to_spend(&budgets, c, bills)))
    });
    let safe_view = move || {
        let s = safe.get();
        if s.budgeted_cents > 0 {
            let per_day = (d.is_current.get() && s.left_cents > 0)
                .then(|| s.left_cents.div_euclid(days_left() as i64));
            view! {
                <div class="stat-value" style=(s.left_cents < 0).then_some("color: var(--color-negative)")>
                    {fmt::cents_whole(s.left_cents)}
                </div>
                <div class="t-xs t-tertiary" style="margin-top: var(--space-1)">
                    "Left in your spending budgets"
                    {per_day.map(|p| format!(" · {}/day", fmt::cents_whole(p)))}
                </div>
                <div class="t-2xs t-tertiary" style="margin-top: var(--space-2)">
                    {format!("{} of {} spent · bills and savings aren't counted",
                        fmt::cents_whole(s.spent_cents), fmt::cents_whole(s.budgeted_cents))}
                </div>
            }
            .into_any()
        } else {
            view! {
                <div class="stat-value t-tertiary">"—"</div>
                <button type="button" class="panel-link" style="margin-top: var(--space-1)" on:click=move |_| d.nav("budgets")()>
                    "Set spending budgets to see this"
                </button>
            }
            .into_any()
        }
    };
    let rows = move || {
        let budgeted = d
            .budget
            .with(|b| b.as_ref().map_or(0, |b| b.total_budgeted_cents));
        let spent = d
            .budget
            .with(|b| b.as_ref().map(|b| b.total_spent_cents))
            .unwrap_or_else(|| d.spending.get());
        [
            ("Income", d.planned_income.get(), d.income.get(), true, "income"),
            // Only categories with a budget — unbudgeted spending has nothing to compare against.
            ("Budgeted spending", budgeted, spent, false, "budgets"),
        ]
        .into_iter()
        .map(|(label, planned, actual, good_when_over, page)| {
            let (off, good) = plan_off(actual, planned, good_when_over);
            view! {
                <button class="tap-target" type="button" on:click=move |_| d.nav(page)()
                    style="background: none; border: 0px; padding: 0px; font: inherit; color: inherit; text-align: left; cursor: pointer">
                    <div class="row-between t-sm" style="margin-bottom: var(--space-1)">
                        <span class="t-medium">{label}</span>
                        <span class="num t-tertiary">
                            {fmt::cents_whole(actual)}
                            {(planned > 0).then(|| format!(" / {}", fmt::cents_whole(planned)))}
                        </span>
                    </div>
                    {if planned > 0 {
                        view! {
                            <ProgressBar value={actual as f64 / planned as f64} over={!good_when_over && actual > planned}
                                label=format!("{label}: actual vs plan") />
                        }.into_any()
                    } else {
                        view! { <div class="t-2xs t-tertiary">"No plan yet — set one in Budgets"</div> }.into_any()
                    }}
                    {(planned > 0).then(|| view! {
                        <div class="t-2xs" style=format!("margin-top: 2px; color: {}", if good { "var(--content-tertiary)" } else { "var(--color-negative)" })>
                            {if off == 0 { "On plan".to_string() } else {
                                format!("{} {} plan", fmt::cents_whole(off.abs()), if off > 0 { "over" } else { "under" })
                            }}
                        </div>
                    })}
                </button>
            }
        })
        .collect_view()
    };
    view! {
        <Panel title_view=view! { {title} }.into_any() subtitle=subtitle>
            <div class="grid">
                <div class="col-5">
                    <div class="eyebrow">"Safe to spend"</div>
                    {safe_view}
                </div>
                <div class="col-7 stack">{rows}</div>
            </div>
        </Panel>
    }
}

/// Balances at a glance — free to use by default, the bank's number on request.
#[component]
fn AccountsCard(d: Dash) -> impl IntoView {
    let (show_actual, set_show_actual) = use_show_actual_balances();
    let rows = Memo::new(move |_| {
        d.accounts.with(|a| {
            a.iter()
                .filter(|a| a.archived_at.is_none() && a.balance_cents != 0)
                .take(6)
                .cloned()
                .collect::<Vec<_>>()
        })
    });
    let any_set_aside = Memo::new(move |_| {
        d.accounts
            .with(|a| a.iter().any(|a| a.set_aside_cents.unwrap_or(0) > 0))
    });
    let subtitle = Signal::derive(move || {
        if show_actual.get() {
            "Bank balances"
        } else {
            "Free to use"
        }
        .to_string()
    });
    view! {
        <Panel title="Accounts" subtitle=subtitle
            actions=view! {
                <span class="row" style="gap: var(--space-2)">
                    {move || any_set_aside.get().then(|| view! {
                        <button class="panel-link" on:click=move |_| set_show_actual.run(!show_actual.get_untracked())>
                            {move || if show_actual.get() { "Show available" } else { "Show actual" }}
                        </button>
                    })}
                    <PanelLink on_click=d.nav("accounts") />
                </span>
            }.into_any()>
            {move || if rows.with(Vec::is_empty) {
                view! {
                    <EmptyState compact=true icon="bank" title="No accounts yet" body="Add an account to see balances here."
                        action=view! { <Button variant="secondary" size="sm" on_click=d.nav("accounts")>"Add an account"</Button> }.into_any() />
                }.into_any()
            } else {
                let actual = show_actual.get();
                view! {
                    <div class="list list-divided">
                        {rows.get().into_iter().map(|a| {
                            let aside = a.set_aside_cents.unwrap_or(0);
                            let sub = (aside > 0).then(|| if actual {
                                format!("{} available", fmt::cents_whole(available_cents(&a)))
                            } else {
                                format!("{} set aside", fmt::cents_whole(aside))
                            });
                            view! {
                                <ListRow chevron=false title=a.name.clone()
                                    subtitle=sub.map(IntoAny::into_any).unwrap_or_else(|| ().into_any())
                                    trailing=view! { <Money cents=shown_balance(&a, actual) whole=true /> }.into_any() />
                            }
                        }).collect_view()}
                    </div>
                }.into_any()
            }}
        </Panel>
    }
}

/// A metric's history + 3-month projection, with current value and change.
#[component]
fn TrendCard(
    label: &'static str,
    d: Dash,
    pick: fn(&TrendPoint) -> i64,
    color: &'static str,
    good_when_up: bool,
    page: &'static str,
) -> impl IntoView {
    let history = Memo::new(move |_| d.points.with(|p| p.iter().map(pick).collect::<Vec<_>>()));
    let projected = Memo::new(move |_| history.with(|h| project(h, 3)));
    let summary = Memo::new(move |_| history.with(|h| trend_summary(h)));
    let span_label = Signal::derive(move || {
        d.points.with(|p| match (p.first(), p.last()) {
            (Some(a), Some(b)) => format!(
                "{}–{} · +3 mo",
                fmt::month_short(&a.month),
                fmt::month_short(&b.month)
            ),
            _ => String::new(),
        })
    });
    view! {
        <Panel title=label subtitle=span_label actions=view! { <PanelLink on_click=d.nav(page) /> }.into_any()>
            <div class="row-baseline">
                <span class="stat-value" style="font-size: var(--text-xl)">{move || fmt::cents_whole(summary.get().current)}</span>
                {move || (history.with(Vec::len) >= 2).then(|| {
                    let s = summary.get();
                    let good = if good_when_up { s.delta >= 0 } else { s.delta <= 0 };
                    view! {
                        <span class=format!("stat-delta {}", if good { "pos" } else { "neg" })>
                            <Icon name={if s.delta >= 0 { "arrowUp" } else { "arrowDown" }} size=12 />
                            {fmt::cents_whole(s.delta.abs())}
                            {s.pct}
                        </span>
                    }
                })}
            </div>
            <div style="margin-top: var(--space-3)">
                <TrendChart history=history projected=projected color=color.to_string() />
            </div>
            <div class="row-between t-2xs t-tertiary" style="margin-top: var(--space-1)">
                <span>{move || d.points.with(|p| p.first().map(|p| fmt::month_short(&p.month)).unwrap_or_default())}</span>
                <span>{move || {
                    let end = projected.with(|p| p.last().copied()).unwrap_or_else(|| summary.get().current);
                    format!("projected {}", fmt::cents_whole(end))
                }}</span>
            </div>
        </Panel>
    }
}

/// The budget at a glance: what's left this month, then the few categories
/// closest to or over their limit (weekly ones judged on this week).
#[component]
fn BudgetOverview(d: Dash) -> impl IntoView {
    let subtitle = Signal::derive(move || month_long(&d.month.get()));
    let body = move || {
        let (budgeted, spent, budgets) = d.budget.with(|b| {
            b.as_ref().map_or((0, 0, vec![]), |b| {
                (
                    b.total_budgeted_cents,
                    b.total_spent_cents,
                    b.budgets.clone(),
                )
            })
        });
        if budgeted == 0 {
            return view! {
                <EmptyState compact=true icon="target" title="No budgets this month"
                    body="Set a weekly or monthly limit per category to track spending against a plan."
                    action=view! { <Button variant="secondary" size="sm" on_click=d.nav("budgets")>"Set budgets"</Button> }.into_any() />
            }
            .into_any();
        }
        let left = budgeted - spent;
        let over = left < 0;
        let days = if d.is_current.get() { days_left() } else { 0 };
        let cats = d.categories.get();
        view! {
            <div class="row-baseline" style="margin-bottom: var(--space-1)">
                <span class="stat-value num" style=format!("font-size: var(--text-xl){}", if over { "; color: var(--color-negative)" } else { "" })>
                    {fmt::cents_whole(left.abs())}
                </span>
                <span class="t-sm t-tertiary">{if over { "over budget" } else { "left to spend" }}</span>
            </div>
            <div class="t-xs t-tertiary" style="margin-bottom: var(--space-3)">
                {format!("{} of {}", fmt::cents_whole(spent), fmt::cents_whole(budgeted))}
                {(days > 0).then(|| format!(" · {days} day{} left", if days == 1 { "" } else { "s" }))}
                {(days > 0 && left > 0).then(|| format!(" · {} a day", fmt::cents_whole(left.div_euclid(days as i64))))}
            </div>
            <ProgressBar value={spent as f64 / budgeted as f64} over=over label="Total budget used" />
            <div class="stack" style="margin-top: var(--space-4)">
                {ranked_budgets(&budgets).into_iter().map(|(b, f)| {
                    let cat = cats.iter().find(|c| c.id == b.category_id);
                    let cat_left = f.limit - f.spent;
                    let color = cat.map(|c| c.color.clone());
                    view! {
                        <div>
                            <div class="row-between t-xs" style="margin-bottom: var(--space-1)">
                                <span class="row" style="gap: var(--space-2); min-width: 0px">
                                    <span aria-hidden="true" class="dot-swatch"
                                        style=format!("background: {}", color.clone().unwrap_or_else(|| "var(--color-accent)".into()))></span>
                                    <span class="truncate">{cat.map_or("Category".to_string(), |c| c.name.clone())}</span>
                                    {f.weekly.then(|| view! { <span class="t-tertiary" style="flex: none">"this week"</span> })}
                                </span>
                                <span class="num" style=format!("color: {}; flex: none",
                                    if cat_left < 0 { "var(--color-negative)" } else { "var(--content-tertiary)" })>
                                    {if cat_left < 0 { format!("{} over", fmt::cents_whole(-cat_left)) } else { format!("{} left", fmt::cents_whole(cat_left)) }}
                                </span>
                            </div>
                            {match color {
                                Some(c) => view! { <ProgressBar small=true value={f.spent as f64 / f.limit as f64} over={cat_left < 0} color=c /> }.into_any(),
                                None => view! { <ProgressBar small=true value={f.spent as f64 / f.limit as f64} over={cat_left < 0} /> }.into_any(),
                            }}
                        </div>
                    }
                }).collect_view()}
            </div>
        }
        .into_any()
    };
    view! {
        <Panel title="Budgets" subtitle=subtitle actions=view! { <PanelLink on_click=d.nav("budgets") /> }.into_any()>
            {body}
        </Panel>
    }
}

/// Phone: the four headline numbers in one card. Each part opens its page.
#[component]
fn PhoneSummary(d: Dash) -> impl IntoView {
    let shown = use_count_up(d.net_worth);
    let history = Memo::new(move |_| {
        d.points
            .with(|p| p.iter().map(|p| p.net_worth_cents).collect::<Vec<_>>())
    });
    let projected = Memo::new(move |_| history.with(|h| project(h, 3)));
    let figures = move || {
        let rate = d.savings_rate.get();
        [
            ("Income", fmt::cents_whole(d.income.get()), Some("income")),
            (
                "Spending",
                fmt::cents_whole(d.spending.get()),
                Some("reports"),
            ),
            (
                "Saved",
                rate.map_or("—".to_string(), |r| format!("{r}%")),
                None,
            ),
        ]
        .into_iter()
        .map(|(label, value, page)| {
            view! {
                <button type="button" class="phone-summary-figure" disabled={page.is_none()}
                    on:click=move |_| if let Some(p) = page { d.nav(p)() }>
                    <span class="t-xs t-tertiary">{label}</span>
                    <span class="num t-medium">{value}</span>
                </button>
            }
        })
        .collect_view()
    };
    view! {
        <div class="panel phone-summary">
            <button type="button" class="phone-summary-hero" on:click=move |_| d.nav("networth")()>
                <span class="t-sm t-tertiary">"Net worth"</span>
                <span class="phone-summary-value num">{move || fmt::cents_whole(vault_core::money::js_round(shown.get()))}</span>
                {move || (history.with(Vec::len) >= 2).then(|| {
                    let s = history.with(|h| trend_summary(h));
                    let since = d.points.with(|p| p.first().map(|p| fmt::month_short(&p.month)));
                    view! {
                        <span class=format!("stat-delta {}", if s.delta >= 0 { "pos" } else { "neg" }) style="align-self: flex-start">
                            <Icon name={if s.delta >= 0 { "arrowUp" } else { "arrowDown" }} size=12 />
                            {fmt::cents_whole(s.delta.abs())}
                            {s.pct}
                            {since.map(|m| view! { <span class="t-tertiary" style="font-weight: 400">{format!("\u{a0}since {m}")}</span> })}
                        </span>
                    }
                })}
            </button>
            // Six months of net worth, dashed three months ahead.
            <div class="phone-summary-chart">
                <TrendChart history=history projected=projected color="var(--viz-2)".to_string() height=72 />
            </div>
            <div class="phone-summary-month t-xs t-tertiary">{move || month_long(&d.month.get())}</div>
            <div class="phone-summary-figures">{figures}</div>
        </div>
    }
}

/// The next few bills due, soonest first (the server sorts).
#[component]
fn UpcomingBills(d: Dash) -> impl IntoView {
    let next = Memo::new(move |_| {
        d.bills
            .with(|b| b.iter().take(4).cloned().collect::<Vec<_>>())
    });
    view! {
        <Panel title="Upcoming bills" subtitle=Signal::stored("Soonest first".to_string())
            actions=view! { <PanelLink on_click=d.nav("bills") /> }.into_any()>
            {move || if next.with(Vec::is_empty) {
                view! {
                    <EmptyState compact=true icon="receipt" title="No bills tracked" body="Add recurring bills to see what's due next."
                        action=view! { <Button variant="secondary" size="sm" on_click=d.nav("bills")>"Add a bill"</Button> }.into_any() />
                }.into_any()
            } else {
                view! {
                    <div class="list list-divided">
                        {next.get().into_iter().map(|b| {
                            let (text, tone) = due_label(b.days_until_due);
                            view! {
                                <ListRow chevron=false title=b.name.clone()
                                    leading=view! { <span aria-hidden="true" class="sq-swatch" style=format!("background: {}", b.color)></span> }.into_any()
                                    subtitle=view! { <span style=format!("color: {}; font-weight: 600", tone_color(tone))>{text}</span> }.into_any()
                                    trailing=view! { <Money cents=b.amount_cents whole=true /> }.into_any() />
                            }
                        }).collect_view()}
                    </div>
                }.into_any()
            }}
        </Panel>
    }
}

/// Portfolio value + unrealized gain/loss + the largest holding.
#[component]
fn InvestmentsCard(d: Dash) -> impl IntoView {
    let body = move || {
        let (value, cost, top) = d.invest.with(|i| {
            i.as_ref().map_or((0, 0, None), |i| {
                (
                    i.total_value_cents,
                    i.total_cost_basis_cents,
                    i.allocation.first().cloned(),
                )
            })
        });
        if value == 0 {
            return view! {
                <EmptyState compact=true icon="invest" title="No holdings yet" body="Track positions to see portfolio value and allocation."
                    action=view! { <Button variant="secondary" size="sm" on_click=d.nav("investments")>"Add holdings"</Button> }.into_any() />
            }
            .into_any();
        }
        let gain = value - cost;
        view! {
            <div class="stat-value">{fmt::cents_whole(value)}</div>
            <div class=format!("stat-delta {}", if gain >= 0 { "pos" } else { "neg" })>
                <Icon name={if gain >= 0 { "trendUp" } else { "trendDown" }} size=13 />
                {format!("{} {}", fmt::cents_whole(gain.abs()), gain_pct_label(value, cost))}
            </div>
            {top.map(|t| view! {
                <div class="t-xs t-tertiary" style="margin-top: var(--space-3)">
                    "Largest holding · "
                    <b style="color: var(--content-primary)">{t.symbol.clone()}</b>
                    {format!(" {}%", vault_core::money::js_round(t.share * 100.0))}
                </div>
            })}
        }
        .into_any()
    };
    view! {
        <Panel title="Investments" subtitle=Signal::stored("Portfolio value".to_string())
            actions=view! { <PanelLink on_click=d.nav("investments") /> }.into_any()>
            {body}
        </Panel>
    }
}

#[component]
fn RecentActivity(d: Dash) -> impl IntoView {
    view! {
        <Panel title="Recent activity" actions=view! { <PanelLink on_click=d.nav("transactions") /> }.into_any()>
            {move || if d.txns.with(Vec::is_empty) {
                view! {
                    <EmptyState compact=true icon="card" title="No transactions yet" body="Import a statement or add one by hand to get started."
                        action=view! { <Button variant="secondary" size="sm" on_click=d.nav("transactions")>"Open Transactions"</Button> }.into_any() />
                }.into_any()
            } else {
                let accounts = d.accounts.get();
                view! {
                    <div class="list list-divided">
                        {d.txns.get().into_iter().map(|t| {
                            let account = accounts.iter().find(|a| a.id == t.account_id).map_or("—".to_string(), |a| a.name.clone());
                            let sub = format!("{} · {account}", t.posted_at.get(5..).unwrap_or(""));
                            view! {
                                <ListRow chevron=false title=t.merchant_name.clone() subtitle=sub.into_any()
                                    trailing=view! { <Money cents=t.amount_cents signed=true tone="auto" /> }.into_any() />
                            }
                        }).collect_view()}
                    </div>
                }.into_any()
            }}
        </Panel>
    }
}

/// Savings goals: progress toward each, and when it's on track to land.
#[component]
fn TopGoals(d: Dash) -> impl IntoView {
    let top = Memo::new(move |_| d.goals.with(|g| top_goals(g)));
    view! {
        <Panel title="Savings goals" actions=view! { <PanelLink on_click=d.nav("goals") /> }.into_any()>
            {move || if top.with(Vec::is_empty) {
                view! {
                    <EmptyState compact=true icon="flag" title="No savings goals" body="Name what you're saving for and track progress toward it."
                        action=view! { <Button variant="secondary" size="sm" on_click=d.nav("goals")>"Add a goal"</Button> }.into_any() />
                }.into_any()
            } else {
                view! {
                    <div class="stack-lg">
                        {top.get().into_iter().map(|g| {
                            let pct = goal_progress(&g);
                            view! {
                                <div>
                                    <div class="row-between t-sm" style="margin-bottom: var(--space-1)">
                                        <span class="t-medium truncate">{g.name.clone()}</span>
                                        <span class="num t-tertiary" style="flex: none">
                                            {format!("{} of {}", fmt::cents_whole(g.saved_cents), fmt::cents_whole(g.target_cents))}
                                        </span>
                                    </div>
                                    <ProgressBar value=pct color=g.color.clone() label=g.name.clone() />
                                    <div class="t-xs t-tertiary" style="margin-top: var(--space-1)">
                                        {goal_plan_line(&g, pct, fmt::cents_whole, month_year)}
                                    </div>
                                </div>
                            }
                        }).collect_view()}
                    </div>
                }.into_any()
            }}
        </Panel>
    }
}

#[component]
fn GetStarted(d: Dash, ai_visible: Memo<bool>) -> impl IntoView {
    let has_accounts = Memo::new(move |_| d.accounts.with(|a| !a.is_empty()));
    view! {
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--grid-gap)">
            {move || {
                let has = has_accounts.get();
                view! {
                    <Card kicker="Get started" title=Signal::stored(if has { "Record transactions" } else { "Add your first account" }.to_string())>
                        <p class="card-body">
                            {if has {
                                "Add or import this month's income and spending — the cash-flow diagram appears here as soon as there's a flow to draw."
                            } else {
                                "Checking, savings, credit cards, loans — accounts are where every transaction lives."
                            }}
                        </p>
                        <div>
                            <Button variant="primary" on_click=d.nav(if has { "transactions" } else { "accounts" })>
                                {if has { "Open Transactions" } else { "Open Accounts" }}
                            </Button>
                        </div>
                    </Card>
                }
            }}
            {move || if ai_visible.get() {
                view! {
                    <Card kicker="Anytime" title=Signal::stored("Ask the assistant".to_string())>
                        <p class="card-body">"Your assistant can explain spending, forecast cash flow, and summarize your month."</p>
                        <div>
                            <Button variant="secondary" icon="sparkle" on_click=d.nav("assistant")>"Open AI Assistant"</Button>
                        </div>
                    </Card>
                }.into_any()
            } else {
                view! {
                    <Card kicker="Optional" title=Signal::stored("Add an AI assistant".to_string())>
                        <p class="card-body">
                            "Off by default. Connect OpenAI, Anthropic, or a local Ollama in Settings to get spending explanations and monthly summaries."
                        </p>
                        <div>
                            <Button variant="secondary" on_click=move || d.go.run(("settings", NavFilter { tab: Some("ai".into()), ..Default::default() }))>
                                "Open AI settings"
                            </Button>
                        </div>
                    </Card>
                }.into_any()
            }}
        </div>
    }
}
