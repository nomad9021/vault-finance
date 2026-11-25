//! The "Get out of debt" planner: port of
//! apps/desktop/src/screens/shell/DebtCalculator.tsx (the math lives in
//! vault_core::debt). Seeds debts from liability accounts (editable), compares
//! avalanche vs. snowball, and keeps the saved plan in sync with the server.

use std::collections::{BTreeMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use leptos::prelude::*;
use serde::Deserialize;
use vault_core::accounts::{Account, AccountListResponse};
use vault_core::debt::{self, Debt, DebtPatch, DebtPlan, Strategy};
use vault_core::money::{cents_to_fixed0, parse_amount_to_cents, to_fixed};
use wasm_bindgen::JsValue;

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{synced, Button, Confetti, Dialog, Panel, Spinner};

/// `deleteAccount`'s response.
#[derive(Deserialize)]
struct Archived {
    #[allow(dead_code)]
    archived: bool,
}

/// Stops a pending `setTimeout` from a cleanup that may run after the
/// owning signals are gone.
type Timer = Arc<Mutex<Option<TimeoutHandle>>>;
fn clear(timer: &Timer) {
    if let Some(h) = timer.lock().ok().and_then(|mut t| t.take()) {
        h.clear();
    }
}

fn new_manual_debt() -> Debt {
    Debt {
        id: format!("manual-{}", js_sys::Date::now() as i64),
        name: "New debt".into(),
        balance_cents: 100_000,
        apr: 18.0,
        min_cents: 5_000,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    DebtFree,
    Empty,
    Planning,
}

#[component]
pub fn DebtCalculator() -> impl IntoView {
    let host = use_host();
    let version = host.data_version;
    let reload = RwSignal::new(0u32);
    let accounts = LocalResource::new(move || {
        version.track();
        reload.track();
        let host = use_host();
        async move { host.call::<AccountListResponse>("accounts", &[]).await }
    });
    let saved_plan = LocalResource::new(move || {
        version.track();
        let host = use_host();
        async move { host.call::<DebtPlan>("debtPlan", &[]).await }
    });

    let liabilities = Memo::new(move |_| {
        accounts
            .get()
            .and_then(Result::ok)
            .map(|r| {
                debt::liabilities(&r.accounts)
                    .into_iter()
                    .cloned()
                    .collect::<Vec<Account>>()
            })
            .unwrap_or_default()
    });
    let account_ids = Memo::new(move |_| {
        liabilities.with(|l| l.iter().map(|a| a.id.clone()).collect::<HashSet<_>>())
    });

    let manual = RwSignal::new(Vec::<Debt>::new());
    let overrides = RwSignal::new(BTreeMap::<String, DebtPatch>::new());
    let extra = RwSignal::new("200".to_string());
    let strategy = RwSignal::new(Strategy::Avalanche);

    let debts = Memo::new(move |_| {
        liabilities.with(|l| {
            let refs: Vec<&Account> = l.iter().collect();
            overrides.with(|o| manual.with(|m| debt::build_debts(&refs, o, m)))
        })
    });
    let extra_cents = Memo::new(move |_| extra.with(|e| parse_amount_to_cents(e)).unwrap_or(0));
    let total_debt =
        Memo::new(move |_| debts.with(|d| d.iter().map(|d| d.balance_cents).sum::<i64>()));
    let plan =
        Memo::new(move |_| debts.with(|d| debt::simulate(d, extra_cents.get(), strategy.get())));
    let min_only = Memo::new(move |_| debts.with(|d| debt::simulate(d, 0, strategy.get())));

    // Track whether debt has ever existed so an all-zero total reads as a
    // milestone rather than the cold-start empty state, and fire the
    // celebration exactly on the transition from owing something to nothing.
    let ever_in_debt = RwSignal::new(false);
    let celebrate = RwSignal::new(false);
    let confirm_delete = RwSignal::new(None::<Debt>);
    let deleting = RwSignal::new(false);
    let delete_error = RwSignal::new(None::<String>);
    let settings_open = RwSignal::new(false);
    let prev_total = StoredValue::new(total_debt.get_untracked());
    let celebrate_timer: Timer = Arc::default();
    {
        let celebrate_timer = celebrate_timer.clone();
        Effect::new(move |_| {
            let total = total_debt.get();
            let ever = ever_in_debt.get();
            // The React effect's cleanup: a re-run cancels the pending timer.
            clear(&celebrate_timer);
            let was = prev_total.get_value();
            prev_total.set_value(total);
            if total > 0 && !ever {
                ever_in_debt.set(true);
            }
            if was > 0 && total == 0 {
                celebrate.set(true);
                if let Ok(h) = set_timeout_with_handle(
                    move || celebrate.set(false),
                    Duration::from_millis(5000),
                ) {
                    *celebrate_timer.lock().unwrap() = Some(h);
                }
            }
        });
    }

    // Hydrate the editable state from the saved plan once it arrives, then
    // keep the server in sync (debounced) on any edit. `hydrated` guards
    // against saving default state before the load lands.
    let hydrated = Arc::new(AtomicBool::new(false));
    {
        let hydrated = hydrated.clone();
        Effect::new(move |_| {
            if hydrated.load(Ordering::Relaxed) {
                return;
            }
            let Some(Ok(p)) = saved_plan.get() else {
                return;
            };
            hydrated.store(true, Ordering::Relaxed);
            extra.set(debt::extra_input(p.extra_cents));
            strategy.set(p.strategy);
            overrides.set(p.overrides);
            manual.set(p.manual);
        });
    }

    // The latest payload is kept outside the reactive graph so it can be
    // flushed when the planner unmounts: a quick edit followed by navigating
    // away would otherwise be cancelled with the debounce. The save effect
    // reads the signals themselves rather than a memo: like the React deps,
    // every set (including hydration) restarts the debounce and saves.
    let payload = move || DebtPlan {
        extra_cents: extra.with(|e| parse_amount_to_cents(e)).unwrap_or(0),
        strategy: strategy.get(),
        overrides: overrides.get(),
        manual: manual.get(),
    };
    let latest = Arc::new(Mutex::new(None::<DebtPlan>));
    let save_timer: Timer = Arc::default();
    {
        let (latest, save_timer, hydrated, host) = (
            latest.clone(),
            save_timer.clone(),
            hydrated.clone(),
            host.clone(),
        );
        Effect::new(move |_| {
            let p = payload();
            *latest.lock().unwrap() = Some(p.clone());
            clear(&save_timer);
            if !hydrated.load(Ordering::Relaxed) {
                return;
            }
            let host = host.clone();
            if let Ok(h) = set_timeout_with_handle(
                move || host.fire("updateDebtPlan", &[HostCtx::arg(&p)]),
                Duration::from_millis(500),
            ) {
                *save_timer.lock().unwrap() = Some(h);
            }
        });
    }
    {
        let host = host.clone();
        on_cleanup(move || {
            clear(&save_timer);
            clear(&celebrate_timer);
            // Flush the newest edits when the planner unmounts.
            if hydrated.load(Ordering::Relaxed) {
                if let Some(p) = latest.lock().ok().and_then(|l| l.clone()) {
                    host.fire("updateDebtPlan", &[HostCtx::arg(&p)]);
                }
            }
        });
    }

    let on_patch = Callback::new(move |(id, patch): (String, DebtPatch)| {
        if account_ids.with_untracked(|s| s.contains(&id)) {
            overrides.update(|o| o.entry(id).or_default().merge(&patch));
        } else {
            manual.update(|m| {
                for x in m.iter_mut().filter(|x| x.id == id) {
                    patch.apply(x);
                }
            });
        }
    });
    // Manual debts are just local rows: drop them. Real accounts get archived
    // via the API (which the whole app treats as a delete), so confirm first.
    let on_remove = Callback::new(move |d: Debt| {
        if account_ids.with_untracked(|s| s.contains(&d.id)) {
            confirm_delete.set(Some(d));
        } else {
            manual.update(|m| m.retain(|x| x.id != d.id));
        }
    });
    let confirm_remove_account = {
        let host = host.clone();
        move || {
            let Some(d) = confirm_delete.get_untracked() else {
                return;
            };
            if deleting.get_untracked() {
                return;
            }
            deleting.set(true);
            delete_error.set(None);
            let host = host.clone();
            leptos::task::spawn_local(async move {
                match host
                    .try_call::<Archived>("deleteAccount", &[JsValue::from_str(&d.id)])
                    .await
                {
                    Ok(_) => {
                        overrides.update(|o| {
                            o.remove(&d.id);
                        });
                        confirm_delete.set(None);
                        reload.update(|v| *v += 1);
                    }
                    Err(e) => delete_error.set(Some(e.message_or("Couldn’t delete the account."))),
                }
                deleting.set(false);
            });
        }
    };
    let reset_plan = move || {
        manual.set(Vec::new());
        overrides.set(BTreeMap::new());
        ever_in_debt.set(false);
        celebrate.set(false);
        prev_total.set_value(0);
    };
    let add_manual_debt = move || {
        manual.update(|m| m.push(new_manual_debt()));
        settings_open.set(true);
    };

    // Only a change of mode swaps the view, so editing in the dialog never
    // rebuilds (and unfocuses) it.
    let mode = Memo::new(move |_| {
        if total_debt.get() == 0 && ever_in_debt.get() {
            Mode::DebtFree
        } else if debts.with(Vec::is_empty) {
            Mode::Empty
        } else {
            Mode::Planning
        }
    });

    let confirm_remove_account = StoredValue::new_local(confirm_remove_account);
    move || {
        match mode.get() {
        Mode::DebtFree => view! {
            <Panel kicker="Plan" title="Get out of debt">
                <div style="position: relative; overflow: hidden; text-align: center; padding: 22px 0 8px">
                    {move || celebrate.get().then(|| view! { <Confetti /> })}
                    <div style=move || format!(
                        "font-size: var(--text-5xl); line-height: 1{}",
                        if celebrate.get() { "; animation: debtFreePop var(--dur-slow) var(--ease) both" } else { "" })>
                        "🎉"
                    </div>
                    <div style="font-family: var(--font-heading); font-weight: 700; font-size: var(--text-2xl); letter-spacing: -.02em; margin: 8px 0 4px">
                        "You’re debt-free!"
                    </div>
                    <p class="card-meta" style="max-width: 380px; margin: 0 auto 14px">
                        "Every balance is cleared. No interest, no minimums — just money that’s yours to keep. 🥳"
                    </p>
                    <div style="display: flex; gap: 8px; justify-content: center">
                        <Button variant="ghost" on_click=reset_plan>"Start a new plan"</Button>
                        <Button variant="secondary" on_click=add_manual_debt icon="plus">"Add a debt"</Button>
                    </div>
                </div>
            </Panel>
        }
        .into_any(),
        Mode::Empty => view! {
            <Panel kicker="Plan" title="Get out of debt">
                <p class="card-meta" style="margin-bottom: 12px">
                    "Add a credit card or loan account (with a balance) and it shows up here automatically — or add a debt by hand. The planner shows how fast you can be debt-free and how much interest you’ll save."
                </p>
                <Button variant="primary" on_click=add_manual_debt icon="plus">"Add a debt manually"</Button>
            </Panel>
        }
        .into_any(),
        Mode::Planning => {
            let interest_saved = move || {
                (min_only.with(|m| m.total_interest_cents) - plan.with(|p| p.total_interest_cents)).max(0.0)
            };
            let months_saved = move || {
                (min_only.with(|m| m.months) as i64 - plan.with(|p| p.months) as i64).max(0) as u32
            };
            let never = move || plan.with(|p| p.never_payoff);
            let months = move || plan.with(|p| p.months);
            let gear_button = move || view! {
                <button type="button" aria-label="Edit debts & payoff settings" title="Edit debts & payoff settings"
                    on:click=move |_| settings_open.set(true)
                    style="width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--color-divider); background: var(--color-surface); border-radius: var(--radius-md); color: var(--content-tertiary); cursor: pointer">
                    <GearIcon />
                </button>
            };
            view! {
                <Panel kicker="Plan" title="Get out of debt"
                    subtitle="Compare payoff strategies and see the impact of paying extra"
                    actions=gear_button().into_any()>
                    <div class="grid" style="margin-bottom: 6px">
                        <div class="col-4">
                            <div class="eyebrow">"Debt-free by"</div>
                            <div class="metric-value" style="font-size: var(--text-2xl)">
                                {move || if never() { "—".to_string() } else { fmt::month_year_from_now(months()) }}
                            </div>
                            <div style="font-size: var(--text-xs); color: var(--content-tertiary)">
                                {move || if never() { "payment too low".to_string() } else { debt::months_label(months()) }}
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="eyebrow">"Interest paid"</div>
                            <div class="metric-value" style="font-size: var(--text-2xl)">
                                {move || fmt::cents_whole_f64(plan.with(|p| p.total_interest_cents))}
                            </div>
                            <div class="pos" style="font-size: var(--text-xs); font-weight: 600">
                                {move || {
                                    let s = interest_saved();
                                    if s > 0.0 { format!("save {} vs. minimums", fmt::cents_whole_f64(s)) } else { "\u{a0}".into() }
                                }}
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="eyebrow">"Total debt"</div>
                            <div class="metric-value" style="font-size: var(--text-2xl)">
                                {move || fmt::cents_whole(total_debt.get())}
                            </div>
                            <div style="font-size: var(--text-xs); color: var(--content-tertiary)">
                                {move || {
                                    let m = months_saved();
                                    if m > 0 { format!("{} sooner", debt::months_label(m)) } else { "\u{a0}".into() }
                                }}
                            </div>
                        </div>
                    </div>

                    {move || (!never()).then(|| view! {
                        <div style="margin-bottom: 4px">
                            <PayoffChart plan=plan.with(|p| p.trajectory.clone()) min_only=min_only.with(|m| m.trajectory.clone()) />
                            <div style="display: flex; gap: 16px; font-size: var(--text-xs); color: var(--content-tertiary)">
                                <span style="display: flex; align-items: center; gap: 6px">
                                    <span style="width: 14px; height: 3px; border-radius: var(--radius-sm); background: var(--color-accent)"></span>
                                    "Your plan — debt-free "
                                    {fmt::month_year_from_now(months())}
                                </span>
                                <span style="display: flex; align-items: center; gap: 6px">
                                    <span style="width: 14px; height: 0px; border-top: 2px dashed var(--content-tertiary)"></span>
                                    "Minimums only"
                                </span>
                            </div>
                        </div>
                    })}

                    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: var(--text-sm); color: var(--content-tertiary); border-top: 1px solid var(--hairline); margin-top: 8px; padding-top: 12px">
                        <span>
                            <strong style="color: var(--color-text)">{move || debts.with(Vec::len)}</strong>
                            " "
                            {move || if debts.with(Vec::len) == 1 { "debt" } else { "debts" }}
                        </span>
                        <span aria-hidden="true">"·"</span>
                        <span>
                            <strong style="color: var(--color-text)">{move || fmt::cents_whole(extra_cents.get())}</strong>
                            " extra / mo"
                        </span>
                        <span aria-hidden="true">"·"</span>
                        <span style="text-transform: capitalize">{move || strategy.get().as_str()}</span>
                        <button type="button" on:click=move |_| settings_open.set(true)
                            style="margin-left: auto; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--color-divider); background: var(--color-surface); border-radius: var(--radius-md); padding: 5px 11px; font-size: var(--text-sm); font-weight: 600; color: var(--color-text); cursor: pointer">
                            <GearIcon size=14 />
                            " Edit debts & settings"
                        </button>
                    </div>

                    {move || settings_open.get().then(|| view! {
                        <DebtSettingsDialog
                            debts=debts
                            extra=extra
                            strategy=strategy
                            account_ids=account_ids
                            on_patch=on_patch
                            on_remove=on_remove
                            on_add=Callback::new(move |()| manual.update(|m| m.push(new_manual_debt())))
                            on_close=Callback::new(move |()| settings_open.set(false))
                        />
                    })}

                    {move || confirm_delete.get().map(|d| {
                        let close = move || {
                            confirm_delete.set(None);
                            delete_error.set(None);
                        };
                        let actions = move || view! {
                            <Button variant="secondary" disabled=deleting on_click=close>"Cancel"</Button>
                            <Button variant="primary" disabled=deleting
                                on_click=move || confirm_remove_account.with_value(|f| f())
                                style="background: var(--color-negative); border-color: var(--color-negative); color: #fff">
                                {move || if deleting.get() {
                                    view! { <Spinner label="Deleting" /> }.into_any()
                                } else {
                                    "Delete account".into_any()
                                }}
                            </Button>
                        };
                        view! {
                            <Dialog title="Delete this account?".to_string() actions=ToChildren::to_children(actions)
                                on_close=Callback::new(move |()| if !deleting.get_untracked() { close() })>
                                <p class="card-body" style="margin: 0; line-height: 1.6">
                                    <strong>{d.name.clone()}</strong>
                                    " will be removed from your accounts — it’ll disappear from balances, net worth, and this planner. This is the same as deleting it from the Accounts page."
                                </p>
                                {move || delete_error.get().map(|e| view! {
                                    <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative); margin-top: 10px">{e}</div>
                                })}
                            </Dialog>
                        }
                    })}
                </Panel>
            }
            .into_any()
        }
    }
    }
}

/// Balance-over-time area chart: your plan (accent) vs. minimums-only (muted).
#[component]
fn PayoffChart(plan: Vec<f64>, min_only: Vec<f64>) -> impl IntoView {
    const W: f64 = 720.0;
    const H: f64 = 200.0;
    const PAD: f64 = 10.0;
    let first = |t: &[f64]| t.first().copied().unwrap_or(0.0);
    let start = first(&plan).max(first(&min_only)).max(1.0);
    // X window: enough to show the plan reaching zero, plus context.
    // Math.max(2, Math.min(Math.max(len - 1, 24), 120))
    let x_max = (plan.len() as i64 - 1).clamp(24, 120) as f64;
    let px = move |i: usize| PAD + (i as f64 / x_max) * (W - 2.0 * PAD);
    let py = move |v: f64| H - PAD - (v.max(0.0) / start) * (H - 2.0 * PAD);
    let line = move |t: &[f64]| {
        let n = ((t.len() as i64 - 1).min(x_max as i64)).max(-1);
        (0..=n)
            .map(|i| {
                let i = i as usize;
                format!(
                    "{}{},{}",
                    if i == 0 { "M" } else { "L" },
                    to_fixed(px(i), 1),
                    to_fixed(py(t[i]), 1)
                )
            })
            .collect::<Vec<_>>()
            .join(" ")
    };
    let plan_n = (plan.len() as i64 - 1).min(x_max as i64).max(0) as usize;
    let base = to_fixed(H - PAD, 1);
    let area = format!(
        "{} L{},{base} L{},{base} Z",
        line(&plan),
        to_fixed(px(plan_n), 1),
        to_fixed(px(0), 1)
    );
    view! {
        <svg viewBox=format!("0 0 {W} {H}") style="width: 100%; height: auto; display: block; margin-bottom: 6px"
            role="img" aria-label="Debt payoff over time">
            <line x1=PAD y1=H - PAD x2=W - PAD y2=H - PAD stroke="var(--color-divider)" stroke-width="1" />
            <path d=area fill="color-mix(in srgb, var(--color-accent) 14%, transparent)" />
            {(min_only.len() > 2).then(|| view! {
                <path d=line(&min_only) fill="none" stroke="var(--content-tertiary)" stroke-width="1.5" stroke-dasharray="4 4" />
            })}
            <path d=line(&plan) fill="none" stroke="var(--color-accent)" stroke-width="2.5" stroke-linecap="round" />
            <circle cx=px(plan_n) cy=py(0.0) r="4" fill="var(--color-accent)" />
        </svg>
    }
}

/// Crisp settings gear, sized to its container's font color.
#[component]
fn GearIcon(#[prop(default = 17)] size: u32) -> impl IntoView {
    view! {
        <svg width=size height=size viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" stroke-width="1.6" />
            <path
                d="M19.4 13a7.6 7.6 0 0 0 .05-2l1.7-1.3-1.7-3-2 .8a7.7 7.7 0 0 0-1.75-1l-.3-2.1h-3.4l-.3 2.1a7.7 7.7 0 0 0-1.75 1l-2-.8-1.7 3L5.65 11a7.6 7.6 0 0 0 0 2l-1.7 1.3 1.7 3 2-.8c.53.42 1.12.76 1.75 1l.3 2.1h3.4l.3-2.1c.63-.24 1.22-.58 1.75-1l2 .8 1.7-3L19.4 13Z"
                stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
        </svg>
    }
}

const MINI_LABEL: &str = "font-size: var(--text-3xs); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--content-tertiary); margin-bottom: 3px; display: block";

/// Writes `text` back into the input when it differs, the way a React
/// controlled input shows its value even when the parsed number is unchanged.
fn show(ev: &leptos::ev::Event, text: &str) {
    let el: web_sys::HtmlInputElement = event_target(ev);
    if el.value() != text {
        el.set_value(text);
    }
}

/// The pop-up settings window: monthly extra, strategy, and each debt's
/// name / balance / APR / minimum, plus removing and adding debts.
#[component]
fn DebtSettingsDialog(
    debts: Memo<Vec<Debt>>,
    extra: RwSignal<String>,
    strategy: RwSignal<Strategy>,
    account_ids: Memo<HashSet<String>>,
    on_patch: Callback<(String, DebtPatch)>,
    on_remove: Callback<Debt>,
    on_add: Callback<()>,
    on_close: Callback<()>,
) -> impl IntoView {
    let actions = move || view! { <Button variant="primary" on_click=move || on_close.run(())>"Done"</Button> };
    view! {
        <Dialog title="Debt plan settings".to_string() on_close=on_close actions=ToChildren::to_children(actions)>
            <div style="display: flex; flex-direction: column; gap: 14px">
                <div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-end">
                    <div>
                        <span style=MINI_LABEL>"Extra / month"</span>
                        <div style="display: flex; align-items: center; gap: 6px">
                            <span style="color: var(--content-tertiary)">"$"</span>
                            <input class="input" inputmode="decimal" style="width: 110px"
                                prop:value=move || extra.get()
                                on:input=move |ev| extra.set(event_target_value(&ev)) />
                        </div>
                    </div>
                    <div>
                        <span style=MINI_LABEL>"Strategy"</span>
                        <div class="seg">
                            <label class="seg-opt">
                                <input type="radio" name="strategy"
                                    prop:checked=move || strategy.get() == Strategy::Avalanche
                                    on:change=move |_| strategy.set(Strategy::Avalanche) />
                                "Avalanche"
                            </label>
                            <label class="seg-opt">
                                <input type="radio" name="strategy"
                                    prop:checked=move || strategy.get() == Strategy::Snowball
                                    on:change=move |_| strategy.set(Strategy::Snowball) />
                                "Snowball"
                            </label>
                        </div>
                    </div>
                </div>
                <div style="font-size: var(--text-xs); color: var(--content-tertiary); line-height: 1.5">
                    {move || match strategy.get() {
                        Strategy::Avalanche => "Avalanche: extra goes to the highest-APR debt first — least interest.",
                        Strategy::Snowball => "Snowball: extra goes to the smallest balance first — fastest wins for motivation.",
                    }}
                </div>

                <div style="border-top: 1px solid var(--hairline); padding-top: 12px">
                    <span style=MINI_LABEL>"Your debts"</span>
                    <div style="display: flex; flex-direction: column; gap: 10px">
                        <For each=move || debts.get() key=|d| d.id.clone() let:d>
                            <DebtRow id=d.id debts=debts account_ids=account_ids on_patch=on_patch on_remove=on_remove />
                        </For>
                    </div>
                    <div style="margin-top: 10px">
                        <Button variant="ghost" on_click=move || on_add.run(()) icon="plus">"Add a debt manually"</Button>
                    </div>
                </div>
            </div>
        </Dialog>
    }
}

#[component]
fn DebtRow(
    id: String,
    debts: Memo<Vec<Debt>>,
    account_ids: Memo<HashSet<String>>,
    on_patch: Callback<(String, DebtPatch)>,
    on_remove: Callback<Debt>,
) -> impl IntoView {
    let id = StoredValue::new(id);
    let current =
        move || id.with_value(|id| debts.with(|ds| ds.iter().find(|d| &d.id == id).cloned()));
    let field = move |f: fn(&Debt) -> String| move || current().map(|d| f(&d)).unwrap_or_default();
    let name = field(|d| d.name.clone());
    let balance = field(|d| cents_to_fixed0(d.balance_cents));
    // Kept as typed while it means the same number, so "6." survives typing 6.5.
    let apr = synced(
        move || current().map(|d| d.apr).unwrap_or(0.0),
        |a| debt::apr_text(*a),
        debt::same_apr,
    );
    let min = field(|d| cents_to_fixed0(d.min_cents));
    let linked = move || id.with_value(|id| account_ids.with(|s| s.contains(id)));
    let patch = move |p: DebtPatch| on_patch.run((id.get_value(), p));

    view! {
        <div style="border: 1px solid var(--color-divider); border-radius: var(--radius-md); padding: 10px; display: flex; flex-direction: column; gap: 8px">
            <div style="display: flex; align-items: center; gap: 8px">
                <input class="input" placeholder="Debt name" style="flex: 1; min-width: 0"
                    prop:value=name
                    on:input=move |ev| {
                        patch(DebtPatch { name: Some(event_target_value(&ev)), ..Default::default() });
                        show(&ev, &name());
                    } />
                <button type="button"
                    aria-label=move || format!("Remove {}", name())
                    title=move || if linked() { "Delete this account" } else { "Remove this debt" }
                    on:click=move |_| if let Some(d) = current() { on_remove.run(d) }
                    style="width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--color-divider); background: var(--color-surface); border-radius: var(--radius-md); color: var(--color-negative); cursor: pointer; font-size: var(--text-lg); line-height: 1; flex: 0 0 auto">
                    "×"
                </button>
            </div>
            <div style="display: flex; gap: 8px">
                <label style="flex: 1">
                    <span style=MINI_LABEL>"Balance $"</span>
                    <input class="input num" inputmode="numeric" style="width: 100%; text-align: right; font-weight: 600"
                        prop:value=balance
                        on:input=move |ev| {
                            let cents = parse_amount_to_cents(&event_target_value(&ev)).unwrap_or(0);
                            patch(DebtPatch { balance_cents: Some(cents), ..Default::default() });
                            show(&ev, &balance());
                        } />
                </label>
                <label style="width: 72px">
                    <span style=MINI_LABEL>"APR %"</span>
                    <input class="input" inputmode="decimal" style="width: 100%; text-align: right"
                        prop:value=apr
                        on:input=move |ev| {
                            let text = debt::clean_apr(&event_target_value(&ev));
                            apr.set(text.clone());
                            patch(DebtPatch { apr: Some(debt::parse_apr(&text)), ..Default::default() });
                            show(&ev, &text);
                        } />
                </label>
                <label style="width: 92px">
                    <span style=MINI_LABEL>"Min / mo"</span>
                    <input class="input" inputmode="numeric" style="width: 100%; text-align: right"
                        prop:value=min
                        on:input=move |ev| {
                            let cents = parse_amount_to_cents(&event_target_value(&ev)).unwrap_or(0);
                            patch(DebtPatch { min_cents: Some(cents), ..Default::default() });
                            show(&ev, &min());
                        } />
                </label>
            </div>
            <span style="font-size: var(--text-2xs); color: var(--content-tertiary)">
                {move || if linked() {
                    "🔗 From a linked account — removing deletes the account"
                } else {
                    "✎ Manual entry"
                }}
            </span>
        </div>
    }
}
