//! Savings Goals: port of apps/desktop/src/screens/shell/GoalsPage.tsx, with
//! the Buckets tab (BucketsView.tsx) in [`buckets`].

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::accounts::{Account, AccountListResponse};
use vault_core::goals::{non_empty, Goal, GoalEta, GoalForm, GoalListResponse, GOAL_COLORS};
use vault_core::nav::NavFilter;
use wasm_bindgen::JsValue;

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{
    Button, DateField, Dialog, EmptyState, Field, ProgressBar, Select, SelectOption, Spinner, Tabs,
    Tag,
};

#[path = "goals_buckets.rs"]
mod buckets;

const GOAL_TABS: &[(&str, &str)] = &[("goals", "Goals"), ("buckets", "Buckets")];

/// Savings goals, and savings buckets (splitting an account's balance) one
/// tab over.
#[component]
pub fn GoalsPage() -> impl IntoView {
    let host = use_host();
    let initial = if host.filter.tab.as_deref() == Some("buckets") {
        "buckets"
    } else {
        "goals"
    };
    let tab = RwSignal::new(initial);
    view! {
        <div class="page">
            <Tabs items=GOAL_TABS value=tab aria_label="Savings views" />
            {move || if tab.get() == "goals" {
                view! { <GoalsList /> }.into_any()
            } else {
                view! { <buckets::BucketsView /> }.into_any()
            }}
        </div>
    }
}

/// `null` = closed; `Some(None)` = adding; `Some(Some(goal))` = editing.
type Editing = Option<Option<Goal>>;

#[component]
fn GoalsList() -> impl IntoView {
    let host = use_host();
    let data_version = host.data_version;
    // Bumped after a save, like useData's reload().
    let version = RwSignal::new(0_u32);
    let goals = LocalResource::new(move || {
        data_version.track();
        version.track();
        let host = use_host();
        async move { host.call::<GoalListResponse>("goals", &[]).await }
    });
    let accounts_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move {
            host.call::<AccountListResponse>("accounts", &[JsValue::TRUE])
                .await
        }
    });
    let accounts = Signal::derive(move || {
        accounts_res
            .get()
            .and_then(Result::ok)
            .map(|r| r.accounts)
            .unwrap_or_default()
    });
    let editing = RwSignal::new(None::<Option<Goal>>);

    let list = move || {
        // A failed load shows the empty state, as useData leaves data null.
        let Some(result) = goals.get() else {
            return view! { <Spinner label="Loading goals" /> }.into_any();
        };
        let goals = result.map(|r| r.goals).unwrap_or_default();
        let n = goals.len();
        let add = move || editing.set(Some(None));
        view! {
            <div style="display: flex; flex-direction: column; gap: var(--space-6)">
                <div class="page-head">
                    <div class="page-sub">
                        {(n > 0).then(|| format!("{n} goal{}", if n == 1 { "" } else { "s" }))}
                    </div>
                    <Button variant="primary" icon="plus" on_click=add>"Add goal"</Button>
                </div>
                {if goals.is_empty() {
                    view! {
                        <div class="panel">
                            <EmptyState icon="flag" title="No savings goals yet"
                                body="Set a target — an emergency fund, a trip, a down payment — and track progress here. Link a goal to a savings account and its balance becomes the progress automatically."
                                action=view! { <Button variant="primary" icon="plus" on_click=add>"Add your first goal"</Button> }.into_any() />
                        </div>
                    }.into_any()
                } else {
                    view! {
                        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; align-items: start">
                            {goals.into_iter().map(|g| {
                                let linked_name = move |id: String| {
                                    accounts.with(|a| a.iter().find(|a| a.id == id).map(|a| a.name.clone()))
                                };
                                view! { <GoalCard goal=g editing=editing linked_name=linked_name /> }
                            }).collect_view()}
                        </div>
                    }.into_any()
                }}
            </div>
        }
        .into_any()
    };

    view! {
        {list}
        {move || editing.get().map(|goal| view! {
            <GoalDialog goal=goal accounts=accounts
                on_close=move || editing.set(None)
                on_saved=move || {
                    editing.set(None);
                    version.update(|v| *v += 1);
                } />
        })}
    }
}

#[component]
fn GoalCard(
    goal: Goal,
    editing: RwSignal<Editing>,
    linked_name: impl Fn(String) -> Option<String> + Send + Sync + 'static,
) -> impl IntoView {
    let host = use_host();
    let pct = goal.progress();
    let funded = goal.funded();
    let eta = match goal.eta() {
        GoalEta::Funded => "funded 🎉".to_string(),
        GoalEta::Projected(m) => format!("~{}", fmt::month_short_year(&m)),
        GoalEta::Target(d) => format!("target {d}"),
        GoalEta::NoTimeline => "no timeline".to_string(),
    };
    let monthly = if goal.monthly_cents > 0 {
        format!("{} a month", fmt::cents_whole(goal.monthly_cents))
    } else {
        "no monthly plan — not on the cash-flow diagram".to_string()
    };
    let note = non_empty(&goal.note).map(str::to_string);
    let linked = goal.linked_account().map(str::to_string);
    let open = {
        let goal = goal.clone();
        move || editing.set(Some(Some(goal.clone())))
    };
    let open_key = open.clone();
    view! {
        <div class="panel clickable" role="button" tabindex="0" style="text-align: left; width: 100%"
            on:click=move |_| open()
            on:keydown=move |e| {
                if e.key() == "Enter" || e.key() == " " {
                    open_key();
                }
            }>
            <div class="row-baseline">
                <div class="panel-title truncate">{goal.name.clone()}</div>
                <Tag variant=if funded { "positive" } else { "neutral" }>{eta}</Tag>
            </div>
            <div class="stat-value" style="margin-top: var(--space-3)">
                {fmt::cents_whole(goal.saved_cents)}
            </div>
            <div class="t-sm t-tertiary">
                "of "{fmt::cents_whole(goal.target_cents)}" · "{goal.percent()}"% funded"
            </div>
            <div class="t-xs t-tertiary" style="margin-top: 2px">{monthly}</div>
            <div style="margin: var(--space-3) 0px">
                <ProgressBar value=pct color=goal.color.clone() label=goal.name.clone() />
            </div>
            {note.map(|n| view! { <div class="t-sm t-tertiary">{n}</div> })}
            {linked.map(|id| {
                let label = move || linked_name(id.clone()).unwrap_or_else(|| "Linked account".into());
                let id = goal.linked_account_id.clone().unwrap_or_default();
                view! {
                    <Button variant="secondary" size="sm" icon_end="arrowRight"
                        title="View the linked account's transactions"
                        style="margin-top: var(--space-2); align-self: flex-start"
                        stop_propagation=true
                        on_click=move || host.navigate("transactions", &NavFilter::account(&id))>
                        {label}
                    </Button>
                }
            })}
        </div>
    }
}

#[component]
fn GoalDialog(
    goal: Option<Goal>,
    #[prop(into)] accounts: Signal<Vec<Account>>,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_saved: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let start = GoalForm::new(goal.as_ref());
    let name = RwSignal::new(start.name);
    let target = RwSignal::new(start.target);
    let linked_account_id = RwSignal::new(start.linked_account_id);
    let saved = RwSignal::new(start.saved);
    let monthly = RwSignal::new(start.monthly);
    let target_date = RwSignal::new(start.target_date);
    let color = RwSignal::new(start.color);
    let note = RwSignal::new(start.note);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let form = move || GoalForm {
        name: name.get(),
        target: target.get(),
        linked_account_id: linked_account_id.get(),
        saved: saved.get(),
        monthly: monthly.get(),
        target_date: target_date.get(),
        color: color.get(),
        note: note.get(),
    };
    let valid = Signal::derive(move || form().payload().is_some());
    let goal_id = goal.as_ref().map(|g| g.id.clone());
    let editing = goal_id.is_some();

    let save = {
        let (host, goal_id) = (host.clone(), goal_id.clone());
        move || {
            let Some(payload) = form().payload() else {
                return;
            };
            if busy.get_untracked() {
                return;
            }
            busy.set(true);
            error.set(None);
            let (host, goal_id) = (host.clone(), goal_id.clone());
            spawn_local(async move {
                let body = HostCtx::arg(&payload);
                let result = match goal_id {
                    Some(id) => {
                        host.try_call::<IgnoredAny>("updateGoal", &[id.into(), body])
                            .await
                    }
                    None => host.try_call::<IgnoredAny>("createGoal", &[body]).await,
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
        let (host, goal_id) = (host.clone(), goal_id.clone());
        move || {
            let Some(id) = goal_id.clone() else { return };
            if busy.get_untracked() {
                return;
            }
            busy.set(true);
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<IgnoredAny>("deleteGoal", &[id.into()])
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

    let account_options = Signal::derive(move || {
        let mut o = vec![SelectOption::new("", "Not linked — track manually")];
        o.extend(
            accounts
                .get()
                .into_iter()
                .map(|a| SelectOption::new(a.id, a.name)),
        );
        o
    });
    let actions = move || {
        let (save, remove) = (save.clone(), remove.clone());
        view! {
            {editing.then(|| view! {
                <Button variant="ghost" disabled=busy on_click=remove.clone()>"Delete"</Button>
            })}
            <Button variant="secondary" disabled=busy on_click=move || on_close.run(())>"Cancel"</Button>
            <Button variant="primary" disabled=Signal::derive(move || !valid.get() || busy.get())
                on_click=save.clone()>
                {move || if busy.get() {
                    view! { <Spinner label="Saving" /> }.into_any()
                } else {
                    "Save".into_any()
                }}
            </Button>
        }
    };

    view! {
        <Dialog title=if editing { "Edit goal" } else { "Add savings goal" }.to_string()
            on_close=on_close actions=ToChildren::to_children(actions)>
            <div style="display: flex; flex-direction: column; gap: 12px">
                <Field label="Goal" value=name autofocus=!editing placeholder="Emergency fund" />
                <div style="display: flex; gap: 10px">
                    <div style="flex: 1">
                        <Field label="Target amount" value=target input_mode="decimal" placeholder="15000.00" />
                    </div>
                    <div style="width: 180px">
                        <DateField label="Target date (optional)" value=target_date placeholder="No deadline" />
                    </div>
                </div>
                <Field label="Contribution per month" value=monthly input_mode="decimal" placeholder="250.00"
                    hint="Shows up as its own flow on the cash-flow diagram. Leave at 0 to track the balance only.".to_string() />
                <Select label="Linked account (optional)" value=linked_account_id options=account_options />
                {move || if linked_account_id.get().is_empty() {
                    view! { <Field label="Saved so far" value=saved input_mode="decimal" /> }.into_any()
                } else {
                    view! {
                        <p class="text-muted" style="font-size: var(--text-xs); margin: 0px; line-height: 1.6">
                            "Progress follows this account's balance automatically, and the timeline is projected from its recent growth."
                        </p>
                    }.into_any()
                }}
                <div class="field">
                    <label>"Color"</label>
                    <div style="display: flex; gap: 8px">
                        {GOAL_COLORS.map(|c| view! {
                            <button type="button" aria-label=format!("Color {c}") on:click=move |_| color.set(c.to_string())
                                style=move || format!(
                                    "width: 26px; height: 26px; border-radius: 50%; background: {c}; cursor: pointer; border: {}",
                                    if color.get() == c { "2px solid var(--color-text)" } else { "2px solid transparent" })>
                            </button>
                        })}
                    </div>
                </div>
                <Field label="Note (optional)" value=note placeholder="3 months of expenses" />
                {move || error.get().map(|e| view! {
                    <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative)">{e}</div>
                })}
            </div>
        </Dialog>
    }
}
