//! `<SankeyCard>` (apps/desktop/src/screens/shell/SankeyCard.tsx): the one
//! Sankey presentation used across the app. A card with a title, a
//! weekly/monthly/yearly toggle and click-to-drill focus panels that open on
//! the side opposite the clicked node; with `editable`, an Edit mode that
//! rearranges the categories behind the diagram in place.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use serde::Serialize;
use vault_core::accounts::AccountListResponse;
use vault_core::bills::BillListResponse;
use vault_core::debt::DebtPlan;
use vault_core::giving::GivingListResponse;
use vault_core::goals::GoalListResponse;
use vault_core::money::{cents_to_fixed2, parse_amount_to_cents};
use vault_core::sankey::{Datum, LinkDatum, SankeyLink, SankeyNode, SankeySection};
use vault_core::sankey_card::{
    bill_editor, comparison_parts, debt_note, empty_text, giving_editor, goal_editor,
    is_income_side, jump_filter, kicker, manage_label, period_factor, section_target,
    transaction_query, transactions_filter, PERIODS,
};
use vault_core::transactions::{Transaction, TransactionListResponse};
use wasm_bindgen::JsValue;

use super::sankey::Sankey;
use super::sankey_arranger::SankeyArranger;
use super::sankey_order::use_sankey_order;
use super::{Button, Field, Spinner};
use crate::fmt;
use crate::host::{use_host, HostCtx};

#[component]
pub fn SankeyCard(
    #[prop(into)] nodes: Signal<Vec<SankeyNode>>,
    #[prop(into)] links: Signal<Vec<SankeyLink>>,
    /// "YYYY-MM".
    #[prop(into)]
    month: Signal<String>,
    /// Called after an inline edit so the page can refetch the diagram.
    #[prop(optional)]
    on_changed: Option<Callback<()>>,
    #[prop(into, default = "Cash flow".to_string())] title: String,
    #[prop(into, default = "Click a bar to drill in · drag it to rearrange".to_string())]
    hint: String,
    /// Side-by-side mode: drop the period toggle and hint so the card can halve.
    #[prop(optional)]
    compact: bool,
    /// Show dollars and cents. Budget figures always do.
    #[prop(optional)]
    precise: bool,
    /// Month-only figures: no weekly or yearly scaling to offer.
    #[prop(optional)]
    single_period: bool,
    /// Offer an Edit mode that rearranges the categories behind the diagram.
    #[prop(optional)]
    editable: bool,
) -> impl IntoView {
    let editing = RwSignal::new(false);
    let (sankey_order, save_sankey_order) = use_sankey_order();
    let focus = RwSignal::new(None::<String>);
    let period = RwSignal::new("monthly");
    let pf = Memo::new(move |_| {
        if single_period {
            1.0
        } else {
            period_factor(period.get())
        }
    });
    let money = move |cents: f64| {
        if precise {
            fmt::cents_f64(cents)
        } else {
            fmt::cents_whole_f64(cents)
        }
    };

    let focus_node = Memo::new(move |_| {
        let id = focus.get()?;
        nodes.with(|ns| ns.iter().find(|n| n.id == id).cloned())
    });

    let data = Memo::new(move |_| nodes.with(|ns| ns.iter().map(Datum::from).collect::<Vec<_>>()));
    let link_data =
        Memo::new(move |_| links.with(|ls| ls.iter().map(LinkDatum::from).collect::<Vec<_>>()));
    // Read inside the chart's render, so a period change redraws the captions.
    let format = Callback::new(move |v: f64| money(v * pf.get()));
    let aria = {
        let title = title.clone();
        Signal::derive(move || format!("{title} Sankey diagram for {}", month.get()))
    };
    let order = Signal::derive(move || sankey_order.get().unwrap_or_default());

    let head_right = (!compact || editable).then(|| {
        let hint = hint.clone();
        view! {
            <div class="row" style="gap: var(--space-4)">
                {(!compact).then(|| {
                    let hint = hint.clone();
                    move || (!editing.get()).then(|| view! { <span class="t-xs t-tertiary hide-narrow">{hint.clone()}</span> })
                })}
                {move || (editing.get() && sankey_order.with(|o| o.as_ref().is_some_and(|o| !o.is_empty()))).then(|| view! {
                    <Button variant="ghost" size="sm" title="Forget the dragged order and sort the bars by size again"
                        on_click=move || save_sankey_order.run(Vec::new())>
                        "Automatic order"
                    </Button>
                })}
                {editable.then_some(move || {
                    let on = editing.get();
                    view! {
                        <Button variant=if on { "primary" } else { "ghost" } size="sm" icon=if on { "check" } else { "edit" }
                            on_click=move || {
                                editing.update(|e| *e = !*e);
                                focus.set(None);
                            }>
                            {if on { "Done" } else { "Edit" }}
                        </Button>
                    }
                })}
                {(!compact && !single_period).then(|| view! {
                    <div class="seg">
                        {PERIODS.iter().map(|&p| view! {
                            <button type="button" class="seg-opt" on:click=move |_| period.set(p)
                                data-on=move || (period.get() == p).then_some("true")>
                                {p}
                            </button>
                        }).collect_view()}
                    </div>
                })}
            </div>
        }
    });

    let chart = view! {
        <Sankey nodes=data links=link_data format=format focus=focus
            on_focus=Callback::new(move |f| focus.set(f))
            aria_label=aria order=order on_reorder=save_sankey_order />
    };

    view! {
        <div class="panel panel-flush elev-md" style="position: relative">
            <div class="row-between wrap" style="padding: var(--card-pad) var(--card-pad) var(--space-2)">
                <div class="panel-title">{title.clone()}</div>
                {head_right}
            </div>

            <div class=move || editing.get().then_some("sankey-editing")>
                <div style="padding: 0 var(--space-1) var(--space-2); min-width: 0">
                    {chart}
                </div>
                {move || editing.get().then(|| view! { <SankeyArranger on_changed=on_changed.unwrap_or_else(|| Callback::new(|_| {})) /> })}
            </div>

            {move || focus_node.with(Option::is_some).then(|| view! {
                <FocusPanel month=month node=Signal::derive(move || focus_node.get())
                    period_factor=pf money=Callback::new(move |c: f64| money(c))
                    on_close=Callback::new(move |_| focus.set(None)) on_changed=on_changed />
            })}
        </div>
    }
}

#[component]
fn FocusPanel(
    month: Signal<String>,
    /// The focused node; the panel is only mounted while there is one.
    node: Signal<Option<SankeyNode>>,
    #[prop(into)] period_factor: Signal<f64>,
    money: Callback<f64, String>,
    on_close: Callback<()>,
    on_changed: Option<Callback<()>>,
) -> impl IntoView {
    let host = use_host();
    let txns = RwSignal::new(None::<Vec<Transaction>>);
    let generation = StoredValue::new(0_u32);
    let is_income = Memo::new(move |_| node.with(|n| n.as_ref().is_some_and(is_income_side)));
    let side = Memo::new(move |_| if is_income.get() { "right" } else { "left" });

    // What the transaction request depends on (node id, category, account,
    // section, month), so editing a figure doesn't refetch.
    let request = Memo::new(move |_| {
        let n = node.get()?;
        Some((n.id.clone(), transaction_query(&n, &month.get())))
    });
    {
        let host = host.clone();
        Effect::new(move |_| {
            let Some((_, query)) = request.get() else {
                return;
            };
            let income = is_income.get_untracked();
            let gen = generation.get_value() + 1;
            generation.set_value(gen);
            let Some(query) = query else {
                // "Other income" and the shortfall stub have no rows behind them.
                txns.set(Some(Vec::new()));
                return;
            };
            let host = host.clone();
            spawn_local(async move {
                let res = host
                    .call::<TransactionListResponse>("transactions", &[HostCtx::arg(&query)])
                    .await;
                if generation.get_value() != gen {
                    return;
                }
                txns.set(Some(match res {
                    Ok(r) => r
                        .transactions
                        .into_iter()
                        .filter(|t| {
                            if income {
                                t.amount_cents > 0
                            } else {
                                t.amount_cents < 0
                            }
                        })
                        .collect(),
                    Err(_) => Vec::new(),
                }));
            });
        });
    }

    let style = move || {
        let left = side.get() == "left";
        format!(
            "position: absolute; top: 0px; bottom: 0px; {}: 0px; width: 340px; max-width: 100%; \
             background: color-mix(in srgb, var(--color-surface) 92%, transparent); backdrop-filter: blur(14px); \
             {}; box-shadow: var(--shadow-lg); display: flex; flex-direction: column; animation: {} .25s both",
            if left { "left" } else { "right" },
            if left { "border-right: 1px solid var(--color-divider)" } else { "border-left: 1px solid var(--color-divider)" },
            if left { "slideInL" } else { "slideIn" },
        )
    };

    let header = move || {
        let n = node.get()?;
        let fig = match n.comparison {
            Some(c) => money.run(c.actual_cents as f64),
            None => money.run(n.value_cents as f64 * period_factor.get()),
        };
        let comparison = n.comparison.map(|c| {
            let (first, second, over) =
                comparison_parts(c.budgeted_cents, c.actual_cents, |v| money.run(v as f64));
            view! {
                <div class="t-sm t-tertiary" style="margin-top: var(--space-1)">
                    {first}
                    " · "
                    <span style=over.then_some("color: var(--color-negative)")>{second}</span>
                </div>
            }
        });
        Some(view! {
            <div style="display: flex; align-items: center; gap: 8px">
                <span aria-hidden="true" style=format!("width: 10px; height: 10px; border-radius: var(--radius-sm); background: {}; flex: none", n.color)></span>
                <span style="font-size: var(--text-2xs); letter-spacing: .05em; text-transform: uppercase; color: var(--content-tertiary); font-weight: 600">
                    {kicker(&n, is_income.get())}
                </span>
            </div>
            <h3 style="margin: 6px 0 2px; font-size: var(--text-xl); font-weight: 600">{n.label.clone()}</h3>
            <div style="font-family: var(--font-heading); font-weight: 600; font-size: var(--text-3xl); letter-spacing: -.02em">
                {fig}
            </div>
            {comparison}
        })
    };

    // Keyed on the row it edits, like React's useData deps.
    let editor_key = Memo::new(move |_| {
        node.with(|n| {
            n.as_ref()
                .and_then(|n| Some((n.section?, n.entity_id.clone()?)))
        })
    });
    let editor = move || {
        editor_key.get().map(|(section, entity_id)| {
            view! { <SectionEditor section=section entity_id=entity_id on_changed=on_changed /> }
        })
    };

    let target_button = {
        let host = host.clone();
        move || {
            let n = node.get()?;
            let target = section_target(n.section?);
            let filter = jump_filter(&n);
            let host = host.clone();
            Some(view! {
                <Button variant="secondary" size="sm" icon_end="arrowRight"
                    style="margin-top: var(--space-3); align-self: flex-start"
                    on_click=move || host.navigate(target.page, &filter)>
                    {manage_label(&n, target)}
                </Button>
            })
        }
    };

    let list = move || {
        let n = node.get()?;
        Some(match txns.get() {
            None => view! { <Spinner label="Loading transactions" /> }.into_any(),
            Some(ts) if !ts.is_empty() => {
                let host = use_host();
                let filter = transactions_filter(&n);
                view! {
                    <div style="display: flex; flex-direction: column">
                        {ts.into_iter().map(|t| view! {
                            <div style="display: flex; align-items: baseline; gap: 10px; padding: 7px 0px; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent); font-size: var(--text-sm)">
                                <span style="color: var(--content-tertiary); flex: none; width: 44px">{t.posted_at.get(5..).unwrap_or_default().to_string()}</span>
                                <span style="flex: 1; min-width: 0px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{t.merchant_name.clone()}</span>
                                <span style=format!("font-weight: 600; white-space: nowrap; color: {}", if t.amount_cents > 0 { "var(--color-positive)" } else { "var(--color-text)" })>
                                    {fmt::cents_signed(t.amount_cents)}
                                </span>
                            </div>
                        }).collect_view()}
                    </div>
                    <Button variant="ghost" style="margin-top: 12px"
                        on_click=move || host.navigate("transactions", &filter)>
                        "View in Transactions →"
                    </Button>
                }
                .into_any()
            }
            Some(_) => view! {
                <p style="font-size: var(--text-sm); color: var(--content-tertiary); line-height: 1.6">{empty_text(&n)}</p>
            }
            .into_any(),
        })
    };

    view! {
        <div style=style>
            <div style="padding: 12px 16px; border-bottom: 1px solid var(--color-divider)">
                <Button variant="ghost" on_click=move || on_close.run(())>"← All flows"</Button>
            </div>
            <div style="padding: 16px 18px; overflow: auto; flex: 1 1 0%; min-height: 0px">
                {header}
                {editor}
                {target_button}
                <div style="height: 1px; background: var(--color-divider); margin: 14px 0px"></div>
                {list}
            </div>
        </div>
    }
}

/// What the inline editor edits: the stored amount and how to save it.
#[derive(Clone, PartialEq)]
struct Entity {
    label: String,
    cents: i64,
    note: String,
    account_id: Option<String>,
    save: Save,
}

#[derive(Clone, PartialEq)]
enum Save {
    Bill,
    Goal,
    Giving,
    /// The whole plan goes back with this debt's minimum merged in.
    Debt(DebtPlan),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AmountBody {
    amount_cents: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MonthlyBody {
    monthly_cents: i64,
}

async fn load_entity(host: HostCtx, section: SankeySection, id: String) -> Option<Entity> {
    let whole = fmt::cents_whole;
    match section {
        SankeySection::Bills => {
            let bills = host.call::<BillListResponse>("bills", &[]).await.ok()?;
            let b = bills.bills.into_iter().find(|b| b.id == id)?;
            let (label, note) = bill_editor(&b);
            Some(Entity {
                label,
                cents: b.amount_cents,
                note,
                account_id: b.account_id,
                save: Save::Bill,
            })
        }
        SankeySection::Savings => {
            let goals = host.call::<GoalListResponse>("goals", &[]).await.ok()?;
            let g = goals.goals.into_iter().find(|g| g.id == id)?;
            let (label, note) = goal_editor(&g, whole);
            Some(Entity {
                label,
                cents: g.monthly_cents,
                note,
                account_id: g.linked_account_id,
                save: Save::Goal,
            })
        }
        SankeySection::Giving => {
            let giving = host.call::<GivingListResponse>("giving", &[]).await.ok()?;
            let f = giving.funds.into_iter().find(|f| f.id == id)?;
            let (label, note) = giving_editor(&f, whole);
            Some(Entity {
                label,
                cents: f.monthly_cents,
                note,
                account_id: f.account_id,
                save: Save::Giving,
            })
        }
        SankeySection::Debt => {
            let plan = host.call::<DebtPlan>("debtPlan", &[]).await.ok()?;
            let accounts = host
                .call::<AccountListResponse>("accounts", &[])
                .await
                .ok()?;
            let account = accounts.accounts.into_iter().find(|a| a.id == id);
            let over = plan.overrides.get(&id).cloned();
            if account.is_none() && over.is_none() {
                return None;
            }
            Some(Entity {
                label: "Minimum payment per month".into(),
                cents: over.and_then(|o| o.min_cents).unwrap_or(0),
                note: debt_note(
                    account.as_ref().map(|a| (a.name.as_str(), a.balance_cents)),
                    whole,
                ),
                account_id: Some(id),
                save: Save::Debt(plan),
            })
        }
        _ => None,
    }
}

/// Inline editor for the row behind a planned node: change a number without
/// losing your place in the diagram. Anything structural stays on the owning
/// page, reached by the button below it.
#[component]
fn SectionEditor(
    section: SankeySection,
    entity_id: String,
    on_changed: Option<Callback<()>>,
) -> impl IntoView {
    let host = use_host();
    let amount = RwSignal::new(String::new());
    // What's stored now: saving doesn't refetch the entity, so compare
    // against this rather than the fetched value.
    let baseline = RwSignal::new(None::<i64>);
    let busy = RwSignal::new(false);
    let saved = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let entity = {
        let id = entity_id.clone();
        LocalResource::new(move || load_entity(use_host(), section, id.clone()))
    };
    // Hydrate the field once the entity arrives.
    Effect::new(move |_| {
        if let Some(Some(e)) = entity.get() {
            amount.set(cents_to_fixed2(e.cents));
            baseline.set(Some(e.cents));
        }
    });
    // Typing clears the "Saved" note.
    Effect::new(move |_| {
        amount.track();
        saved.set(false);
    });
    let linked_id = Memo::new(move |_| entity.get().flatten().and_then(|e| e.account_id));
    let accounts = LocalResource::new(move || {
        let id = linked_id.get();
        let host = use_host();
        async move {
            match id {
                Some(_) => host.call::<AccountListResponse>("accounts", &[]).await.ok(),
                None => None,
            }
        }
    });
    let linked = Memo::new(move |_| {
        let id = linked_id.get()?;
        accounts
            .get()
            .flatten()?
            .accounts
            .into_iter()
            .find(|a| a.id == id)
    });

    let cents = Memo::new(move |_| parse_amount_to_cents(&amount.get()));
    let dirty = Memo::new(move |_| cents.get().is_some() && cents.get() != baseline.get());

    let save = {
        let entity_id = entity_id.clone();
        Callback::new(move |_| {
            let (Some(c), false) = (cents.get_untracked(), busy.get_untracked()) else {
                return;
            };
            let Some(Some(e)) = entity.get_untracked() else {
                return;
            };
            busy.set(true);
            error.set(None);
            let (host, id) = (host.clone(), entity_id.clone());
            spawn_local(async move {
                let id_arg = JsValue::from_str(&id);
                let res = match e.save {
                    Save::Bill => {
                        host.try_call::<IgnoredAny>(
                            "updateBill",
                            &[id_arg, HostCtx::arg(&AmountBody { amount_cents: c })],
                        )
                        .await
                    }
                    Save::Goal => {
                        host.try_call::<IgnoredAny>(
                            "updateGoal",
                            &[id_arg, HostCtx::arg(&MonthlyBody { monthly_cents: c })],
                        )
                        .await
                    }
                    Save::Giving => {
                        host.try_call::<IgnoredAny>(
                            "updateGivingFund",
                            &[id_arg, HostCtx::arg(&MonthlyBody { monthly_cents: c })],
                        )
                        .await
                    }
                    Save::Debt(mut plan) => {
                        // Overrides are one JSON blob: merge and send it whole.
                        plan.overrides.entry(id.clone()).or_default().min_cents = Some(c);
                        host.try_call::<IgnoredAny>("updateDebtPlan", &[HostCtx::arg(&plan)])
                            .await
                    }
                };
                match res {
                    Ok(_) => {
                        baseline.set(Some(c));
                        saved.set(true);
                        if let Some(f) = on_changed {
                            f.run(());
                        }
                    }
                    Err(e) => error.set(Some(e.message_or("Couldn't save that."))),
                }
                busy.set(false);
            });
        })
    };

    move || match entity.get() {
        None => view! { <Spinner label="Loading" /> }.into_any(),
        Some(None) => ().into_any(),
        Some(Some(e)) => {
            let host = use_host();
            view! {
                <div style="margin-top: var(--space-4); display: flex; flex-direction: column; gap: var(--space-2)">
                    <div class="t-sm t-tertiary">{e.note.clone()}</div>
                    <Field label=e.label.clone() value=amount input_mode="decimal" on_enter=save />
                    <div class="row" style="gap: var(--space-2); align-items: center">
                        <Button variant="primary" size="sm" on_click=move || save.run(())
                            disabled=Signal::derive(move || !dirty.get() || busy.get())>
                            {move || if busy.get() {
                                view! { <Spinner label="Saving" /> }.into_any()
                            } else {
                                "Save".into_any()
                            }}
                        </Button>
                        {move || (saved.get() && !dirty.get()).then(|| view! {
                            <span class="t-xs" style="color: var(--color-positive)">"Saved"</span>
                        })}
                    </div>
                    {move || linked.get().map(|a| {
                        let host = host.clone();
                        let id = a.id.clone();
                        view! {
                            <Button variant="ghost" size="sm" icon_end="arrowRight" title="View this account's transactions"
                                style="align-self: flex-start"
                                on_click=move || host.navigate("transactions", &vault_core::nav::NavFilter::account(&id))>
                                {format!("{} · {}", a.name, fmt::cents_whole(a.balance_cents))}
                            </Button>
                        }
                    })}
                    {move || error.get().map(|e| view! {
                        <div role="alert" class="t-xs" style="color: var(--color-negative)">{e}</div>
                    })}
                </div>
            }
            .into_any()
        }
    }
}
