//! `<GuiltFreeCard>` (apps/desktop/src/screens/shell/GuiltFreeCard.tsx).
//!
//! Guilt-free spending on the home screen: everyone's weekly amount side by
//! side, what's left of it this week, and a quick way to log a purchase —
//! typed in, or picked from what the bank already brought in. It resets every
//! week by itself (it's a weekly budget), and shows on the Sankeys as its own
//! category with a branch per person.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::accounts::AccountListResponse;
use vault_core::guilt_free::{
    active_people, parse_allowances, pickable, spend_accounts, spent_share, weekly_input,
    GuiltFreePerson, GuiltFreeResponse, NewPurchase, UpdateGuiltFreeRequest,
};
use vault_core::money::parse_amount_to_cents;
use vault_core::transactions::{
    SetCategoryBody, Transaction, TransactionListResponse, TransactionQuery,
};

use super::listen::use_id;
use super::{
    Avatar, Button, Dialog, EmptyState, Field, Panel, ProgressBar, SegmentedOf, Select,
    SelectOption, Skeleton, Spinner,
};
use crate::fmt;
use crate::host::{use_host, HostCtx};

const NEW_OR_EXISTING: &[(&str, &str)] = &[
    ("new", "New purchase"),
    ("existing", "Already in transactions"),
];

#[component]
pub fn GuiltFreeCard() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let week_start = Memo::new(move |_| app.with(|a| a.review_prefs.week_starts_on.clone()));
    let data_version = host.data_version;
    let version = RwSignal::new(0_u32);
    let res = LocalResource::new(move || {
        data_version.track();
        version.track();
        let w = week_start.get();
        let host = use_host();
        async move {
            host.call::<GuiltFreeResponse>("guiltFree", &[w.into()])
                .await
        }
    });
    let data = Memo::new(
        move |prev: Option<&Option<GuiltFreeResponse>>| match res.get() {
            Some(Ok(v)) => Some(v),
            _ => prev.cloned().flatten(),
        },
    );
    let failed = Memo::new(move |_| matches!(res.get(), Some(Err(_))));
    let setup = RwSignal::new(false);
    let adding = RwSignal::new(None::<GuiltFreePerson>);

    // Changing it changes budgets and the Sankeys too: refresh every open view.
    let changed = {
        let host = host.clone();
        Callback::new(move |_: ()| {
            version.update(|v| *v += 1);
            host.refresh_data();
        })
    };

    let loaded = Memo::new(move |_| data.with(Option::is_some));
    move || {
        if !loaded.get() {
            return view! {
                <Panel title="Guilt-free spending">
                    {move || if failed.get() {
                        view! { <div class="t-sm t-tertiary">"Couldn't load guilt-free spending."</div> }.into_any()
                    } else {
                        view! { <Skeleton height=140 /> }.into_any()
                    }}
                </Panel>
            }
            .into_any();
        }
        let people = Memo::new(move |_| {
            data.with(|d| d.as_ref().map(|d| d.people.clone()).unwrap_or_default())
        });
        let active = Memo::new(move |_| people.with(|p| active_people(p)));
        let has_active = Memo::new(move |_| active.with(|a| !a.is_empty()));
        let resets = Signal::derive(move || {
            data.with(|d| {
                d.as_ref()
                    .map(|d| format!("This week · resets {}", fmt::weekday_long(&d.week_end)))
                    .unwrap_or_default()
            })
        });
        let host = use_host();
        view! {
            <Panel title="Guilt-free spending" subtitle=resets
                actions=view! {
                    <Button variant="ghost" size="sm" icon="edit" on_click=move || setup.set(true)>
                        {move || if has_active.get() { "Amounts" } else { "Set up" }}
                    </Button>
                }.into_any()>
                {move || if has_active.get() {
                    view! {
                        <div class="gf-grid">
                            // Keyed by person, like React's `key={p.userId}`, so a tile's
                            // "Show all" and remove prompt survive a refetch.
                            <For each=move || active.with(|a| a.iter().map(|p| p.user_id.clone()).collect::<Vec<_>>())
                                key=|id| id.clone()
                                children=move |id| {
                                    let person = Memo::new(move |_| active.with(|a| a.iter().find(|p| p.user_id == id).cloned()));
                                    view! { <PersonTile person=person adding=adding on_changed=changed /> }
                                } />
                        </div>
                    }.into_any()
                } else {
                    view! {
                        <EmptyState compact=true icon="gift" title="Money to spend on anything"
                            body="Give each person a weekly amount that's theirs, no questions asked. It resets every week and shows on your budget and actual Sankeys."
                            action=view! {
                                <Button variant="secondary" size="sm" on_click=move || setup.set(true)>"Set weekly amounts"</Button>
                            }.into_any() />
                    }.into_any()
                }}
                {move || setup.get().then(|| {
                    let host = host.clone();
                    view! {
                        <SetupDialog people=people.get_untracked() on_close=move || setup.set(false)
                            on_save=Callback::new(move |body: UpdateGuiltFreeRequest| {
                                let host = host.clone();
                                let w = week_start.get_untracked();
                                // The dialog shows the error and stays open on failure.
                                SaveFuture::new(async move {
                                    host.call::<IgnoredAny>("saveGuiltFree", &[HostCtx::arg(&body), w.into()]).await?;
                                    setup.set(false);
                                    changed.run(());
                                    Ok(())
                                })
                            }) />
                    }
                })}
                {move || adding.get().map(|initial| {
                    let week = data.with_untracked(|d| d.as_ref().map(|d| d.week_start.clone()).unwrap_or_default());
                    view! {
                        <AddPurchaseDialog people=active.get_untracked() initial=initial week_start=week
                            on_close=move || adding.set(None)
                            on_added=move || {
                                adding.set(None);
                                changed.run(());
                            } />
                    }
                })}
            </Panel>
        }
        .into_any()
    }
}

/// The save action handed to the setup dialog: resolves to the error to show.
pub struct SaveFuture(std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>>>>);

impl SaveFuture {
    fn new(f: impl std::future::Future<Output = Result<(), String>> + 'static) -> Self {
        SaveFuture(Box::pin(f))
    }
}

#[component]
fn PersonTile(
    person: Memo<Option<GuiltFreePerson>>,
    adding: RwSignal<Option<GuiltFreePerson>>,
    on_changed: Callback<()>,
) -> impl IntoView {
    let confirming = RwSignal::new(None::<String>);
    let show_all = RwSignal::new(false);
    move || {
        person.get().map(|p| {
            let pick = p.clone();
            view! {
                <PersonTileView person=p on_add=move || adding.set(Some(pick.clone()))
                    on_changed=on_changed confirming=confirming show_all=show_all />
            }
        })
    }
}

#[component]
fn PersonTileView(
    person: GuiltFreePerson,
    on_add: impl Fn() + 'static,
    on_changed: Callback<()>,
    confirming: RwSignal<Option<String>>,
    show_all: RwSignal<bool>,
) -> impl IntoView {
    let host = use_host();
    let left = person.weekly_cents - person.spent_cents;
    let over = left < 0;
    let purchases = StoredValue::new(person.purchases.clone());
    let count = person.purchases.len();

    let remove = move |id: String, manual: bool| {
        let host = host.clone();
        spawn_local(async move {
            // Typed in here: delete it. From the bank: just take it out of guilt-free.
            if manual {
                let _ = host
                    .call::<IgnoredAny>("deleteTransaction", &[id.into()])
                    .await;
            } else {
                let body = SetCategoryBody { category_id: None };
                let _ = host
                    .call::<IgnoredAny>("updateTransaction", &[id.into(), HostCtx::arg(&body)])
                    .await;
            }
            confirming.set(None);
            on_changed.run(());
        });
    };

    let rows = move || {
        let all = purchases.get_value();
        let shown: Vec<_> = if show_all.get() {
            all
        } else {
            all.into_iter().take(3).collect()
        };
        (!shown.is_empty()).then(|| {
            view! {
                <div class="list list-divided" style="margin-top: var(--space-2)">
                    {shown.into_iter().map(|t| {
                        let remove = remove.clone();
                        let id = t.id.clone();
                        let id2 = t.id.clone();
                        let manual = t.manual;
                        let name = t.merchant_name.clone();
                        view! {
                            <div class="row t-sm" style="gap: var(--space-2); padding: 6px 0px">
                                <span class="t-tertiary" style="width: 52px; flex: none" title=t.posted_at.clone()>
                                    {fmt::weekday_short(&t.posted_at)}
                                </span>
                                <span class="truncate" style="flex: 1; min-width: 0px">{t.merchant_name.clone()}</span>
                                <span class="num">{fmt::cents(t.amount_cents)}</span>
                                {move || if confirming.get().as_deref() == Some(id.as_str()) {
                                    let remove = remove.clone();
                                    let id = id.clone();
                                    view! {
                                        <button type="button" class="panel-link" style="color: var(--color-negative)"
                                            on:click=move |_| remove(id.clone(), manual)>"Remove"</button>
                                    }.into_any()
                                } else {
                                    let id2 = id2.clone();
                                    view! {
                                        <button type="button" class="gf-x" aria-label=format!("Remove {name}")
                                            title=if manual { "Delete this purchase" } else { "Take it out of guilt-free (the transaction stays)" }
                                            on:click=move |_| confirming.set(Some(id2.clone()))>"×"</button>
                                    }.into_any()
                                }}
                            </div>
                        }
                    }).collect_view()}
                </div>
            }
        })
    };

    view! {
        <div class="gf-person">
            <div class="row" style="gap: var(--space-3)">
                <Avatar name=person.display_name.clone() color=person.avatar_color.clone()
                    image=person.avatar_image.clone() size=34 />
                <div style="min-width: 0px; flex: 1">
                    <div class="t-sm t-medium truncate">
                        {person.display_name.clone()}
                        {person.is_me.then(|| view! { <span class="t-tertiary" style="font-weight: 400">" · you"</span> })}
                    </div>
                    <div class="t-xs t-tertiary">
                        {if person.weekly_cents > 0 { format!("{} a week", fmt::cents_whole(person.weekly_cents)) } else { "No weekly amount".into() }}
                    </div>
                </div>
            </div>
            <div class="row-baseline" style="margin-top: var(--space-3)">
                <span class="stat-value num" style=format!("font-size: var(--text-2xl){}", if over { "; color: var(--color-negative)" } else { "" })>
                    {fmt::cents(left.abs())}
                </span>
                <span class="t-sm t-tertiary">{if over { "over" } else { "left" }}</span>
            </div>
            <ProgressBar value=spent_share(&person) over=over
                label=format!("{}'s guilt-free spending this week", person.display_name) />
            <div class="t-xs t-tertiary" style="margin-top: var(--space-1)">
                {format!("{} spent", fmt::cents(person.spent_cents))}
            </div>
            {rows}
            {(count > 3).then(|| view! {
                <button type="button" class="panel-link" style="margin-top: 4px" on:click=move |_| show_all.update(|v| *v = !*v)>
                    {move || if show_all.get() { "Show fewer".to_string() } else { format!("Show all {count}") }}
                </button>
            })}
            <Button variant="secondary" size="sm" icon="plus" style="margin-top: var(--space-3); align-self: flex-start"
                disabled=person.category_id.is_none() on_click=on_add>
                "Add purchase"
            </Button>
        </div>
    }
}

#[component]
fn SetupDialog(
    people: Vec<GuiltFreePerson>,
    #[prop(into)] on_close: Callback<()>,
    on_save: Callback<UpdateGuiltFreeRequest, SaveFuture>,
) -> impl IntoView {
    let fields: Vec<(GuiltFreePerson, RwSignal<String>)> = people
        .into_iter()
        .map(|p| {
            let v = RwSignal::new(weekly_input(p.weekly_cents));
            (p, v)
        })
        .collect();
    let fields = StoredValue::new(fields);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let parsed = Memo::new(move |_| {
        fields.with_value(|f| {
            parse_allowances(
                &f.iter()
                    .map(|(p, v)| (p.user_id.clone(), v.get()))
                    .collect::<Vec<_>>(),
            )
        })
    });
    let save = move || {
        let Some(people) = parsed.get_untracked() else {
            return;
        };
        busy.set(true);
        error.set(None);
        let fut = on_save.run(UpdateGuiltFreeRequest { people });
        spawn_local(async move {
            if let Err(e) = fut.0.await {
                error.set(Some(e));
                busy.set(false);
            }
        });
    };
    view! {
        <Dialog title="Weekly guilt-free spending" on_close=on_close
            actions=ToChildren::to_children(move || view! {
                <Button variant="ghost" on_click=move || on_close.run(())>"Cancel"</Button>
                <Button variant="primary" on_click=save
                    disabled=Signal::derive(move || busy.get() || parsed.with(Option::is_none))>
                    {move || if busy.get() { view! { <Spinner label="Saving" /> }.into_any() } else { "Save".into_any() }}
                </Button>
            }.into_any())>
            <p class="t-sm t-tertiary" style="margin-top: 0px">
                "Each person's own money for the week. It starts over every week and is a weekly budget under “Guilt-free spending”, so it's on your budget and actual Sankeys. Leave one empty for none."
            </p>
            <div class="stack">
                {fields.get_value().into_iter().map(|(p, v)| view! {
                    <Field label=format!("{}{} — per week", p.display_name, if p.is_me { " (you)" } else { "" })
                        input_mode="decimal" placeholder="0.00" value=v />
                }).collect_view()}
            </div>
            {move || error.get().map(|e| view! {
                <div role="alert" class="t-sm" style="color: var(--color-negative); margin-top: 8px">{e}</div>
            })}
        </Dialog>
    }
}

#[component]
fn AddPurchaseDialog(
    people: Vec<GuiltFreePerson>,
    initial: GuiltFreePerson,
    week_start: String,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_added: Callback<()>,
) -> impl IntoView {
    let host = use_host();
    let people = StoredValue::new(people);
    let who = RwSignal::new(initial.user_id.clone());
    let initial = StoredValue::new(initial);
    let person = Memo::new(move |_| {
        let w = who.get();
        people
            .with_value(|ps| ps.iter().find(|p| p.user_id == w).cloned())
            .unwrap_or_else(|| initial.get_value())
    });
    let mode = RwSignal::new("new");
    let amount = RwSignal::new(String::new());
    let what = RwSignal::new(String::new());
    let today = fmt::today_utc();
    let date = RwSignal::new(today.clone());
    let account_id = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let acct_res = LocalResource::new(move || {
        let host = use_host();
        async move { host.call::<AccountListResponse>("accounts", &[]).await }
    });
    let accounts = Memo::new(move |_| match acct_res.get() {
        Some(Ok(r)) => spend_accounts(&r.accounts),
        _ => vec![],
    });
    Effect::new(move || {
        if account_id.with(String::is_empty) {
            if let Some(a) = accounts.with(|a| a.first().map(|a| a.id.clone())) {
                account_id.set(a);
            }
        }
    });

    // Already at the bank? Pick it instead of typing it twice.
    let query = TransactionQuery {
        from: Some(week_start),
        to: Some(today.clone()),
        limit: Some(60),
        ..Default::default()
    };
    let recent_res = LocalResource::new(move || {
        let host = use_host();
        let q = HostCtx::arg(&query);
        let q = send_wrapper::SendWrapper::new(q);
        async move {
            host.call::<TransactionListResponse>("transactions", &[q.take()])
                .await
        }
    });
    let recent = Memo::new(move |_| match recent_res.get() {
        Some(Ok(r)) => people.with_value(|ps| pickable(&r.transactions, ps)),
        _ => vec![],
    });

    let cents = Memo::new(move |_| amount.with(|a| parse_amount_to_cents(a)));
    let can_save = Memo::new(move |_| {
        mode.get() == "new"
            && cents.get().is_some_and(|c| c > 0)
            && !what.with(|w| w.trim().is_empty())
            && !account_id.with(String::is_empty)
            && person.with(|p| p.category_id.is_some())
    });

    let add_new = {
        let host = host.clone();
        move || {
            if !can_save.get_untracked() {
                return;
            }
            busy.set(true);
            error.set(None);
            let body = NewPurchase {
                account_id: account_id.get_untracked(),
                category_id: person.with_untracked(|p| p.category_id.clone()),
                posted_at: date.get_untracked(),
                amount_cents: -cents.get_untracked().unwrap_or(0),
                merchant_name: what.with_untracked(|w| w.trim().to_string()),
                pending: false,
            };
            let host = host.clone();
            spawn_local(async move {
                match host
                    .try_call::<IgnoredAny>("createTransaction", &[HostCtx::arg(&body)])
                    .await
                {
                    Ok(_) => on_added.run(()),
                    Err(e) => {
                        error.set(Some(e.message_or("Couldn't add that purchase.")));
                        busy.set(false);
                    }
                }
            });
        }
    };
    let pick = move |t: Transaction| {
        busy.set(true);
        error.set(None);
        let body = SetCategoryBody {
            category_id: person.with_untracked(|p| p.category_id.clone()),
        };
        let host = use_host();
        spawn_local(async move {
            match host
                .try_call::<IgnoredAny>("updateTransaction", &[t.id.into(), HostCtx::arg(&body)])
                .await
            {
                Ok(_) => on_added.run(()),
                Err(e) => {
                    error.set(Some(e.message_or("Couldn't move that purchase.")));
                    busy.set(false);
                }
            }
        });
    };

    let many = people.with_value(|p| p.len() > 1);
    let who_options = Signal::stored(people.with_value(|ps| {
        ps.iter()
            .map(|p| {
                let label = if p.is_me {
                    format!("{} (you)", p.display_name)
                } else {
                    p.display_name.clone()
                };
                (p.user_id.clone(), label)
            })
            .collect::<Vec<_>>()
    }));
    let account_options = Signal::derive(move || {
        let a = accounts.get();
        if a.is_empty() {
            vec![SelectOption::new("", "Add an account first")]
        } else {
            a.into_iter()
                .map(|a| SelectOption::new(a.id, a.name))
                .collect()
        }
    });
    let date_id = StoredValue::new(use_id());
    let today_s = StoredValue::new(today.clone());

    let add_new = StoredValue::new_local(add_new);
    view! {
        <Dialog title="Add a guilt-free purchase" on_close=on_close
            // Reactive inside: the Dialog draws its actions once.
            actions=ToChildren::to_children(move || (move || {
                if mode.get() == "new" {
                    view! {
                        <Button variant="ghost" on_click=move || on_close.run(())>"Cancel"</Button>
                        <Button variant="primary" on_click=move || add_new.with_value(|f| f())
                            disabled=Signal::derive(move || busy.get() || !can_save.get())>
                            {move || if busy.get() { view! { <Spinner label="Adding" /> }.into_any() } else { "Add".into_any() }}
                        </Button>
                    }.into_any()
                } else {
                    view! { <Button variant="ghost" on_click=move || on_close.run(())>"Cancel"</Button> }.into_any()
                }
            }).into_any())>
            <div class="stack">
                {many.then(|| view! {
                    <SegmentedOf aria_label="Whose purchase" options=who_options value=who
                        on_change=move |v| who.set(v) />
                })}
                <div class="t-xs t-tertiary">
                    {move || person.with(|p| format!("{} left of {} this week",
                        fmt::cents((p.weekly_cents - p.spent_cents).max(0)), fmt::cents_whole(p.weekly_cents)))}
                </div>
                <SegmentedOf aria_label="New or from the bank"
                    options=Signal::stored(NEW_OR_EXISTING.iter().map(|(v, l)| (v.to_string(), l.to_string())).collect::<Vec<_>>())
                    value=Signal::derive(move || mode.get().to_string())
                    on_change=move |v: String| mode.set(if v == "new" { "new" } else { "existing" }) />
                {move || if mode.get() == "new" {
                    let today = today_s.get_value();
                    let date_id = date_id.get_value();
                    view! {
                        <Field label="Amount" input_mode="decimal" placeholder="0.00" value=amount autofocus=true />
                        <Field label="What was it?" placeholder="Coffee, book, game…" value=what max_length=200 />
                        <div class="field">
                            <label for=date_id.clone()>"Date"</label>
                            <input id=date_id class="input" type="date" max=today.clone() prop:value=move || date.get()
                                on:input=move |e| {
                                    let v = event_target_value(&e);
                                    date.set(if v.is_empty() { today.clone() } else { v });
                                } />
                        </div>
                        <Select label="Paid from" value=account_id options=account_options />
                        <div class="t-2xs t-tertiary">
                            "If your bank also brings this purchase in later, pick it under “Already in transactions” instead so it isn't counted twice."
                        </div>
                    }.into_any()
                } else if recent.with(Vec::is_empty) {
                    view! { <div class="t-sm t-tertiary">"No other purchases this week yet."</div> }.into_any()
                } else {
                    view! {
                        <div class="list list-divided" style="max-height: 320px; overflow: auto">
                            {recent.get().into_iter().map(|t| {
                                let tt = t.clone();
                                view! {
                                    <button type="button" class="gf-pick" disabled=move || busy.get()
                                        on:click=move |_| pick(tt.clone())>
                                        <span class="t-tertiary" style="width: 92px; flex: none">{fmt::weekday_date(&t.posted_at)}</span>
                                        <span class="truncate" style="flex: 1; min-width: 0px; text-align: left">{t.merchant_name.clone()}</span>
                                        <span class="num">{fmt::cents(-t.amount_cents)}</span>
                                    </button>
                                }
                            }).collect_view()}
                        </div>
                    }.into_any()
                }}
                {move || error.get().map(|e| view! {
                    <div role="alert" class="t-sm" style="color: var(--color-negative)">{e}</div>
                })}
            </div>
        </Dialog>
    }
}
