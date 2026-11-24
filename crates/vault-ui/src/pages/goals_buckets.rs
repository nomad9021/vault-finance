//! The Buckets tab of Savings Goals: port of
//! apps/desktop/src/screens/shell/BucketsView.tsx.
//!
//! Savings buckets split an account's real balance into named parts
//! (Emergency, Vacation…). Amounts are an allocation, not separate money;
//! what isn't allocated shows as Unassigned, and moving money between buckets
//! is just changing the split. A bucket can stand behind a savings goal.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::buckets::{Bucket, BucketAccount, BucketBody, BucketListResponse, MoveBody};
use vault_core::goals::{non_empty, trim_js, Goal, GoalListResponse};
use vault_core::money::{cents_to_fixed0, cents_to_fixed2, parse_amount_to_cents};

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{Banner, Button, Dialog, EmptyState, Field, Select, SelectOption, Spinner, Tag};

#[component]
pub fn BucketsView() -> impl IntoView {
    let host = use_host();
    let data_version = host.data_version;
    let version = RwSignal::new(0_u32);
    let data = LocalResource::new(move || {
        data_version.track();
        version.track();
        let host = use_host();
        async move { host.call::<BucketListResponse>("buckets", &[]).await }
    });
    let goals_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move { host.call::<GoalListResponse>("goals", &[]).await }
    });
    let goals = Signal::derive(move || {
        goals_res
            .get()
            .and_then(Result::ok)
            .map(|r| r.goals)
            .unwrap_or_default()
    });
    let show_all = RwSignal::new(false);
    let editing = RwSignal::new(None::<(BucketAccount, Option<Bucket>)>);
    let moving = RwSignal::new(None::<BucketAccount>);
    let reload = move || version.update(|v| *v += 1);

    let body = move || {
        let Some(result) = data.get() else {
            return view! { <Spinner label="Loading buckets" /> }.into_any();
        };
        let data = result.unwrap_or(BucketListResponse { accounts: vec![] });
        if data.accounts.is_empty() {
            return view! {
                <div class="panel">
                    <EmptyState icon="wallet" title="No savings accounts yet"
                        body="Add or link a savings account on the Accounts page, then divide it into buckets here." />
                </div>
            }
            .into_any();
        }
        let shown = move || {
            let accounts: Vec<BucketAccount> =
                data.shown(show_all.get()).into_iter().cloned().collect();
            view! {
                {accounts.is_empty().then(|| view! {
                    <p class="card-meta">"No savings accounts — tick \"Show checking accounts too\" to use buckets on one."</p>
                })}
                {accounts.into_iter().map(|a| view! {
                    <AccountBuckets account=a goals=goals editing=editing moving=moving />
                }).collect_view()}
            }
        };
        view! {
            <div style="display: flex; flex-direction: column; gap: 16px">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap">
                    <p class="card-meta" style="margin: 0px; max-width: 560px">
                        "Divide a savings account into buckets — an emergency fund, a trip, a car — without opening more accounts. The buckets split the real balance; whatever isn't in one is Unassigned."
                    </p>
                    <label class="radio" style="font-size: var(--text-sm)">
                        <input type="checkbox" prop:checked=move || show_all.get()
                            on:change=move |e| show_all.set(event_target_checked(&e)) />
                        <span class="dot" style="border-radius: var(--radius-sm)"></span>
                        "Show checking accounts too"
                    </label>
                </div>
                {shown}
            </div>
        }
        .into_any()
    };

    view! {
        {body}
        {move || editing.get().map(|(account, bucket)| view! {
            <BucketDialog account=account bucket=bucket goals=goals
                on_close=move || editing.set(None)
                on_saved=move || { editing.set(None); reload(); } />
        })}
        {move || moving.get().map(|account| view! {
            <MoveDialog account=account
                on_close=move || moving.set(None)
                on_moved=move || { moving.set(None); reload(); } />
        })}
    }
}

#[component]
fn AccountBuckets(
    account: BucketAccount,
    goals: Signal<Vec<Goal>>,
    editing: RwSignal<Option<(BucketAccount, Option<Bucket>)>>,
    moving: RwSignal<Option<BucketAccount>>,
) -> impl IntoView {
    let over = account.over();
    let has_buckets = !account.buckets.is_empty();
    let on_move = {
        let a = account.clone();
        move || moving.set(Some(a.clone()))
    };
    let on_add = {
        let a = account.clone();
        move || editing.set(Some((a.clone(), None)))
    };
    let bar = account
        .buckets
        .iter()
        .map(|b| {
            let style = format!(
                "width: {}%; background: {}",
                account.bar_percent(b),
                b.color
            );
            let title = format!("{}: {}", b.name, fmt::cents(b.allocated_cents));
            view! { <div title=title style=style></div> }
        })
        .collect_view();
    let rows = account
        .buckets
        .iter()
        .map(|b| {
            let a = account.clone();
            let edit = b.clone();
            let goal_id = non_empty(&b.goal_id).map(str::to_string);
            let goal_tag = move || {
                let id = goal_id.clone()?;
                let name = goals.with(|g| g.iter().find(|g| g.id == id).map(|g| g.name.clone()))?;
                // `goalName.get(b.goalId) &&`: an empty name shows nothing.
                (!name.is_empty()).then(|| view! {
                    <Tag style="margin-left: 8px; font-size: var(--text-3xs)">{format!("goal: {name}")}</Tag>
                })
            };
            view! {
                <button on:click=move |_| editing.set(Some((a.clone(), Some(edit.clone()))))
                    style="display: flex; align-items: center; gap: 10px; padding: 8px 2px; border: 0px; border-top: 1px solid var(--color-divider); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer">
                    <span style=format!("width: 10px; height: 10px; border-radius: 3px; background: {}; flex: none", b.color)></span>
                    <span style="flex: 1; min-width: 0px">{b.name.clone()}{goal_tag}</span>
                    {b.target_percent().map(|(pct, target)| view! {
                        <span class="card-meta" style="white-space: nowrap">
                            {format!("{pct}% of {}", fmt::cents_whole(target))}
                        </span>
                    })}
                    <strong style="min-width: 90px; text-align: right">{fmt::cents(b.allocated_cents)}</strong>
                </button>
            }
        })
        .collect_view();

    view! {
        <div class="panel" style="display: flex; flex-direction: column; gap: 12px">
            <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap">
                <div>
                    <div style="font-weight: 600">{account.account_name.clone()}</div>
                    <div class="card-meta">{format!("{} balance", fmt::cents_whole(account.balance_cents))}</div>
                </div>
                <div style="display: flex; gap: 8px">
                    {has_buckets.then(|| view! {
                        <Button variant="secondary" size="sm" on_click=on_move.clone()>"Move money"</Button>
                    })}
                    <Button variant="primary" size="sm" icon="plus" on_click=on_add>"Add bucket"</Button>
                </div>
            </div>

            // The split, as one bar: each bucket, then Unassigned.
            <div style="display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--color-divider); gap: 2px" aria-hidden="true">
                {bar}
            </div>
            {over.then(|| view! {
                <Banner tone="warning">
                    {format!(
                        "The buckets add up to {} more than the balance — take some out of a bucket to rebalance.",
                        fmt::cents_whole(-account.unassigned_cents)
                    )}
                </Banner>
            })}

            <div style="display: flex; flex-direction: column">
                {rows}
                <div style="display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-top: 1px solid var(--color-divider)">
                    <span style="width: 10px; height: 10px; border-radius: 3px; background: var(--color-divider); flex: none"></span>
                    <span style="flex: 1; color: var(--content-secondary)">"Unassigned"</span>
                    <strong style=if over { "min-width: 90px; text-align: right; color: var(--color-negative)" } else { "min-width: 90px; text-align: right" }>
                        {fmt::cents(account.unassigned_cents)}
                    </strong>
                </div>
            </div>
        </div>
    }
}

#[component]
fn BucketDialog(
    account: BucketAccount,
    bucket: Option<Bucket>,
    goals: Signal<Vec<Goal>>,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_saved: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let name = RwSignal::new(bucket.as_ref().map(|b| b.name.clone()).unwrap_or_default());
    let amount = RwSignal::new(
        bucket
            .as_ref()
            .map(|b| cents_to_fixed2(b.allocated_cents))
            .unwrap_or_default(),
    );
    let target = RwSignal::new(
        bucket
            .as_ref()
            .and_then(|b| b.target_cents.filter(|&t| t != 0))
            .map(cents_to_fixed0)
            .unwrap_or_default(),
    );
    let goal_id = RwSignal::new(
        bucket
            .as_ref()
            .and_then(|b| b.goal_id.clone())
            .unwrap_or_default(),
    );
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let linked_elsewhere = account.goals_linked_elsewhere(bucket.as_ref().map(|b| b.id.as_str()));
    let bucket_id = bucket.as_ref().map(|b| b.id.clone());
    let account_id = account.account_id.clone();

    let save = {
        let (host, bucket_id) = (host.clone(), bucket_id.clone());
        move || {
            busy.set(true);
            error.set(None);
            let (host, bucket_id, account_id) =
                (host.clone(), bucket_id.clone(), account_id.clone());
            let (n, a, t, g) = (
                name.get_untracked(),
                amount.get_untracked(),
                target.get_untracked(),
                goal_id.get_untracked(),
            );
            spawn_local(async move {
                let result = match bucket_id {
                    Some(id) => {
                        let body = HostCtx::arg(&BucketBody::from_form(None, &n, &a, &t, &g));
                        host.try_call::<IgnoredAny>("updateBucket", &[id.into(), body])
                            .await
                    }
                    None => {
                        let body =
                            HostCtx::arg(&BucketBody::from_form(Some(account_id), &n, &a, &t, &g));
                        host.try_call::<IgnoredAny>("createBucket", &[body]).await
                    }
                };
                match result {
                    Ok(_) => on_saved.run(()),
                    Err(e) => error.set(Some(if e.is_api_request() {
                        e.message
                    } else {
                        "Couldn't save the bucket.".into()
                    })),
                }
                // `finally { setBusy(false) }`; the dialog may be gone by now.
                busy.try_set(false);
            });
        }
    };
    let remove = {
        let (host, bucket_id) = (host.clone(), bucket_id.clone());
        move || {
            let Some(id) = bucket_id.clone() else { return };
            busy.set(true);
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<IgnoredAny>("deleteBucket", &[id.into()])
                    .await
                {
                    Ok(_) => on_saved.run(()),
                    Err(e) => {
                        error.set(Some(if e.is_api_request() {
                            e.message
                        } else {
                            "Couldn't delete the bucket.".into()
                        }));
                        busy.set(false);
                    }
                }
            });
        }
    };

    let title = match &bucket {
        Some(b) => format!("Edit \"{}\"", b.name),
        None => format!("New bucket in {}", account.account_name),
    };
    let hint = format!(
        "{} available in {}",
        fmt::cents(account.available_for(bucket.as_ref())),
        account.account_name
    );
    let goal_options = Signal::derive(move || {
        let mut o = vec![SelectOption::new("", "None")];
        o.extend(goals.get().into_iter().map(|g| {
            let taken = linked_elsewhere.contains(&g.id);
            SelectOption {
                label: format!("{}{}", g.name, if taken { " (has a bucket)" } else { "" }),
                value: g.id,
                disabled: taken,
            }
        }));
        o
    });
    let editing = bucket_id.is_some();
    let actions = move || {
        let (save, remove) = (save.clone(), remove.clone());
        view! {
            {editing.then(|| view! {
                <Button variant="danger" disabled=busy on_click=remove.clone()>"Delete"</Button>
            })}
            <Button variant="ghost" on_click=move || on_close.run(())>"Cancel"</Button>
            <Button variant="primary" disabled=Signal::derive(move || busy.get() || trim_js(&name.get()).is_empty())
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
        <Dialog title=title on_close=on_close actions=ToChildren::to_children(actions)>
            <Field label="Name" value=name placeholder="Emergency fund" />
            <Field label="Amount in this bucket" input_mode="decimal" value=amount placeholder="0.00" hint=hint.clone() />
            <Field label="Target (optional)" input_mode="decimal" value=target placeholder="5,000" />
            <Select label="Savings goal (optional)" value=goal_id options=goal_options />
            {move || error.get().map(|e| view! {
                <p role="alert" style="color: var(--color-negative); font-size: var(--text-sm)">{e}</p>
            })}
        </Dialog>
    }
}

#[component]
fn MoveDialog(
    account: BucketAccount,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_moved: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let from = RwSignal::new(String::new());
    let to = RwSignal::new(
        account
            .buckets
            .first()
            .map(|b| b.id.clone())
            .unwrap_or_default(),
    );
    let amount = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let label = |id: &str| -> String {
        if id.is_empty() {
            format!("Unassigned ({})", fmt::cents(account.unassigned_cents))
        } else {
            let b = account.bucket(id);
            format!(
                "{} ({})",
                b.map_or("undefined", |b| b.name.as_str()),
                fmt::cents(b.map_or(0, |b| b.allocated_cents))
            )
        }
    };
    let options: Vec<SelectOption> = std::iter::once(String::new())
        .chain(account.buckets.iter().map(|b| b.id.clone()))
        .map(|id| SelectOption::new(id.clone(), label(&id)))
        .collect();

    let parsed = move || parse_amount_to_cents(&amount.get()).unwrap_or(0);
    let do_move = move || {
        busy.set(true);
        error.set(None);
        let host = host.clone();
        let (f, t) = (from.get_untracked(), to.get_untracked());
        let body = MoveBody {
            from_bucket_id: (!f.is_empty()).then_some(f),
            to_bucket_id: (!t.is_empty()).then_some(t),
            amount_cents: parse_amount_to_cents(&amount.get_untracked()).unwrap_or(0),
        };
        spawn_local(async move {
            match host
                .try_call::<IgnoredAny>("moveBucketMoney", &[HostCtx::arg(&body)])
                .await
            {
                Ok(_) => on_moved.run(()),
                Err(e) => {
                    error.set(Some(if e.is_api_request() {
                        e.message
                    } else {
                        "Couldn't move that.".into()
                    }));
                    busy.set(false);
                }
            }
        });
    };
    let actions = move || {
        let do_move = do_move.clone();
        view! {
            <Button variant="ghost" on_click=move || on_close.run(())>"Cancel"</Button>
            <Button variant="primary"
                disabled=Signal::derive(move || busy.get() || from.get() == to.get() || parsed() == 0)
                on_click=do_move>
                {move || if busy.get() {
                    view! { <Spinner label="Moving" /> }.into_any()
                } else {
                    "Move".into_any()
                }}
            </Button>
        }
    };

    view! {
        <Dialog title=format!("Move money in {}", account.account_name) on_close=on_close
            actions=ToChildren::to_children(actions)>
            <Select label="From" value=from options=options.clone() />
            <Select label="To" value=to options=options.clone() />
            <Field label="Amount" input_mode="decimal" value=amount placeholder="0.00" />
            <p class="card-meta">"This only changes how the balance is split — no money leaves the account."</p>
            {move || error.get().map(|e| view! {
                <p role="alert" style="color: var(--color-negative); font-size: var(--text-sm)">{e}</p>
            })}
        </Dialog>
    }
}
