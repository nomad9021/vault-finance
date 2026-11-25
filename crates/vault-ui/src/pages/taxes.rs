//! Salary & taxes: port of apps/desktop/src/screens/shell/TaxesPage.tsx.
//!
//! Gross pay in, take-home out. The household's earners, pre-tax deductions
//! and location feed the shared 2026 tax engine (on the server, through
//! `estimateTax`); the estimate updates as you type, saving it keeps the
//! budget planner's income in step, and a tax Sankey shows where each
//! paycheck goes. "Compare a move" runs the same numbers somewhere else.

use std::time::Duration;

use leptos::leptos_dom::helpers::{set_timeout_with_handle, TimeoutHandle};
use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::taxes::{
    compare_start_state, dependents_from, js_number_string, marginal_total_pct, move_diff,
    optional_number, tax_sankey, whole_dollars_text, FilingStatus, PayFrequency, Period, TaxEarner,
    TaxEstimate, TaxPlacesResponse, TaxProfile, TaxProfileResponse,
};

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{
    Banner, Button, Card, Field, Sankey, Segmented, Select, SelectOption, Spinner, Tag,
};

const PERIODS: &[(&str, &str)] = &[("year", "Yearly"), ("month", "Monthly")];

fn period_of(v: &str) -> Period {
    if v == "month" {
        Period::Month
    } else {
        Period::Year
    }
}

/// `useEstimate(profile)`: a what-if estimate 300 ms after the profile stops
/// changing; nothing while no one has any pay. A failed request keeps the
/// last estimate and sets the error.
fn use_estimate(
    profile: Signal<Option<TaxProfile>>,
) -> (RwSignal<Option<TaxEstimate>>, RwSignal<Option<String>>) {
    let estimate = RwSignal::new(None::<TaxEstimate>);
    let error = RwSignal::new(None::<String>);
    let host = StoredValue::new(use_host());
    // Bumped on every change and on unmount: a stale timer or response
    // does nothing (React's `cancelled`).
    let generation = StoredValue::new(0u64);
    let timer = StoredValue::new(None::<TimeoutHandle>);
    // JSON.stringify(profile) as the effect key: only a real change re-runs.
    let key = Memo::new(move |_| profile.get());
    let cancel = move || {
        generation.try_update_value(|g| *g += 1);
        if let Some(h) = timer.try_get_value().flatten() {
            h.clear();
        }
    };
    Effect::new(move |_| {
        let p = key.get();
        cancel();
        let Some(p) = p.filter(TaxProfile::has_pay) else {
            estimate.set(None);
            return;
        };
        let mine = generation.get_value();
        let current = move || generation.try_get_value() == Some(mine);
        let handle = set_timeout_with_handle(
            move || {
                if !current() {
                    return;
                }
                let Some(host) = host.try_get_value() else {
                    return;
                };
                let body = HostCtx::arg(&p);
                spawn_local(async move {
                    let r = host.try_call::<TaxEstimate>("estimateTax", &[body]).await;
                    if !current() {
                        return;
                    }
                    match r {
                        Ok(e) => {
                            estimate.try_set(Some(e));
                            error.try_set(None);
                        }
                        Err(e) => {
                            error.try_set(Some(if e.is_api_request() {
                                e.message
                            } else {
                                "Couldn't estimate.".into()
                            }));
                        }
                    }
                });
            },
            Duration::from_millis(300),
        )
        .ok();
        timer.set_value(handle);
    });
    on_cleanup(cancel);
    (estimate, error)
}

/// A field's text that follows `value` (from the draft) when it changes,
/// unless what's already typed means the same thing (`same`), so "1." stays
/// "1." while the draft holds 1.
fn synced<T>(
    value: impl Fn() -> T + Send + Sync + 'static,
    show: fn(&T) -> String,
    same: fn(&str, &T) -> bool,
) -> RwSignal<String>
where
    T: PartialEq + Clone + Send + Sync + 'static,
{
    let value = Memo::new(move |_| value());
    let text = RwSignal::new(show(&value.get_untracked()));
    Effect::new(move |_| {
        let v = value.get();
        if !text.with_untracked(|t| same(t, &v)) {
            text.set(show(&v));
        }
    });
    text
}

fn show_pct(v: &Option<f64>) -> String {
    v.map(js_number_string).unwrap_or_default()
}

fn same_pct(t: &str, v: &Option<f64>) -> bool {
    show_pct(&optional_number(t)) == show_pct(v)
}

// `synced` takes `fn(&T)`, so these must take `&String`.
#[allow(clippy::ptr_arg)]
fn same_string(t: &str, v: &String) -> bool {
    t == v
}

#[allow(clippy::ptr_arg)]
fn show_string(v: &String) -> String {
    v.clone()
}

/// Edits to the draft (`edit` / `editEarner`), `Copy` for every handler.
#[derive(Clone, Copy)]
struct Draft {
    draft: RwSignal<Option<TaxProfile>>,
    dirty: RwSignal<bool>,
    saved: RwSignal<bool>,
}

impl Draft {
    fn read<T: Default>(self, f: impl FnOnce(&TaxProfile) -> T) -> T {
        self.draft.with(|d| d.as_ref().map(f).unwrap_or_default())
    }

    fn earner<T: Default>(self, i: usize, f: impl FnOnce(&TaxEarner) -> T) -> T {
        self.draft.with(|d| {
            d.as_ref()
                .and_then(|d| d.earners.get(i))
                .map(f)
                .unwrap_or_default()
        })
    }

    fn edit(self, f: impl FnOnce(&mut TaxProfile)) {
        self.draft
            .update(|d| f(d.get_or_insert_with(TaxProfile::default)));
        self.dirty.set(true);
        self.saved.set(false);
    }

    fn edit_earner(self, i: usize, f: impl FnOnce(&mut TaxEarner)) {
        self.edit(|d| {
            if let Some(e) = d.earners.get_mut(i) {
                f(e);
            }
        });
    }
}

#[component]
pub fn TaxesPage() -> impl IntoView {
    let data_version = use_host().data_version;
    let version = RwSignal::new(0u32);
    let data = LocalResource::new(move || {
        version.track();
        data_version.track();
        let host = use_host();
        async move { host.call::<TaxProfileResponse>("taxProfile", &[]).await }
    });
    let places_res = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move { host.call::<TaxPlacesResponse>("taxPlaces", &[]).await }
    });
    let places = Memo::new(move |prev: Option<&Option<TaxPlacesResponse>>| {
        match places_res.get() {
            Some(Ok(p)) => Some(p),
            // useData keeps the last good result.
            _ => prev.cloned().flatten(),
        }
    });

    let d = Draft {
        draft: RwSignal::new(None),
        dirty: RwSignal::new(false),
        saved: RwSignal::new(false),
    };
    Effect::new(move |_| {
        if let Some(Ok(r)) = data.get() {
            if !d.dirty.get() {
                d.draft.set(Some(r.profile.unwrap_or_default()));
            }
        }
    });

    let ready = move || d.draft.with(Option::is_some) && places.with(Option::is_some);
    view! {
        <Show when=ready fallback=|| view! { <Spinner label="Loading" /> }>
            <Loaded d=d places=places version=version />
        </Show>
    }
}

#[component]
fn Loaded(
    d: Draft,
    places: Memo<Option<TaxPlacesResponse>>,
    version: RwSignal<u32>,
) -> impl IntoView {
    let host = StoredValue::new(use_host());
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let period = RwSignal::new("year");
    let focus = RwSignal::new(None::<String>);

    let (estimate, est_error) = use_estimate(Signal::derive(move || d.draft.get()));
    let has_estimate = Memo::new(move |_| estimate.with(Option::is_some));
    let est = move |f: fn(&TaxEstimate) -> String| {
        move || estimate.with(|e| e.as_ref().map(f).unwrap_or_default())
    };

    let save = move || {
        let Some(draft) = d.draft.get_untracked() else {
            return;
        };
        busy.set(true);
        error.set(None);
        let host = host.get_value();
        spawn_local(async move {
            match host
                .try_call::<IgnoredAny>("saveTaxProfile", &[HostCtx::arg(&draft)])
                .await
            {
                Ok(_) => {
                    d.dirty.try_set(false);
                    d.saved.try_set(true);
                    version.try_update(|v| *v += 1);
                }
                Err(e) => {
                    error.try_set(Some(if e.is_api_request() {
                        e.message
                    } else {
                        "Couldn't save.".into()
                    }));
                }
            }
            busy.try_set(false);
        });
    };

    let year = move || places.with(|p| p.as_ref().map(|p| p.year).unwrap_or_default());

    view! {
        <div class="page" style="max-width: 1100px">
            <div class="page-head">
                <div>
                    <h1 class="page-title">"Salary & taxes"</h1>
                    <p class="card-meta" style="margin: 0px">
                        {year}
                        " US estimate · federal, Social Security & Medicare, all 50 states + DC, main local taxes"
                    </p>
                </div>
                <div style="display: flex; gap: 8px; align-items: center">
                    <Show when=move || d.saved.get()>
                        <Tag variant="positive">"Saved"</Tag>
                    </Show>
                    <Button variant="primary" on_click=save
                        disabled=Signal::derive(move || busy.get() || !d.dirty.get())>
                        {move || if busy.get() {
                            view! { <Spinner label="Saving" /> }.into_any()
                        } else {
                            "Save".into_any()
                        }}
                    </Button>
                </div>
            </div>
            {move || error.get().map(|e| view! { <Banner tone="danger">{e}</Banner> })}
            {move || est_error.get().map(|e| view! { <Banner tone="warning">{e}</Banner> })}

            <Show when=move || has_estimate.get()>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px">
                    <Card kicker="Take-home" title=Signal::derive(est(|e| fmt::cents_whole(e.take_home_cents)))>
                        <p class="card-meta">
                            {est(|e| fmt::cents_whole(Period::Month.amount(e.take_home_cents)))}" a month"
                        </p>
                    </Card>
                    <Card kicker="Taxes" title=Signal::derive(est(|e| fmt::cents_whole(e.tax_cents)))>
                        <p class="card-meta">
                            {est(|e| js_number_string(e.effective_rate_pct))}"% of gross pay"
                        </p>
                    </Card>
                    <Card kicker="Next dollar earned"
                        title=Signal::derive(est(|e| format!("{}% tax", js_number_string(marginal_total_pct(e)))))>
                        <p class="card-meta">
                            {est(|e| format!(
                                "{}% federal + {}% state/local, plus FICA",
                                js_number_string(e.marginal_federal_pct),
                                js_number_string(e.marginal_state_pct),
                            ))}
                        </p>
                    </Card>
                    <Card kicker="Saved before tax" title=Signal::derive(est(|e| fmt::cents_whole(e.pretax_cents)))>
                        <p class="card-meta">"401(k), HSA and premiums"</p>
                    </Card>
                </div>
            </Show>

            <Show when=move || has_estimate.get()>
                <TaxSankey estimate=estimate period=period focus=focus />
            </Show>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; align-items: start">
                <Household d=d places=places />
                <div style="display: flex; flex-direction: column; gap: 16px">
                    <For each=move || 0..d.read(|p| p.earners.len()) key=|i| *i let:i>
                        <EarnerCard i=i d=d estimate=estimate />
                    </For>
                    <Show when=move || { d.read(|p| p.earners.len()) < 6 }>
                        <Button variant="secondary" icon="plus"
                            on_click=move || d.edit(|p| p.earners.push(TaxEarner::blank(p.earners.len())))>
                            "Add an earner"
                        </Button>
                    </Show>
                </div>
            </div>

            <Show when=move || has_estimate.get()>
                <Breakdown estimate=estimate period=period />
            </Show>

            <Show when=move || has_estimate.get()>
                <CompareMove d=d estimate=estimate places=places />
            </Show>
        </div>
    }
}

/// "Where you live and file".
#[component]
fn Household(d: Draft, places: Memo<Option<TaxPlacesResponse>>) -> impl IntoView {
    let status = synced(
        move || d.read(|p| p.filing_status.id().to_string()),
        show_string,
        same_string,
    );
    let state = synced(
        move || d.read(|p| p.state.clone()),
        show_string,
        same_string,
    );
    let locality = synced(
        move || d.read(|p| p.locality.clone().unwrap_or_default()),
        show_string,
        same_string,
    );
    let custom_local = synced(
        move || d.read(|p| p.custom_local_rate_pct),
        show_pct,
        same_pct,
    );
    let other_payroll = synced(move || d.read(|p| p.other_payroll_pct), show_pct, same_pct);
    let dependents = synced(
        move || d.read(|p| p.dependents),
        |n| n.to_string(),
        |t, n| dependents_from(t) == *n,
    );

    let status_options = Signal::stored(
        FilingStatus::ALL
            .iter()
            .map(|s| SelectOption::new(s.id(), s.label()))
            .collect::<Vec<_>>(),
    );
    let state_options = Signal::derive(move || {
        places.with(|p| {
            p.iter()
                .flat_map(|p| &p.states)
                .map(|s| {
                    let suffix = if s.taxes_wages { "" } else { " (no wage tax)" };
                    SelectOption::new(&s.code, format!("{}{suffix}", s.name))
                })
                .collect::<Vec<_>>()
        })
    });
    let locality_options = Memo::new(move |_| {
        let state = d.read(|p| p.state.clone());
        places.with(|p| {
            p.iter()
                .flat_map(|p| p.localities_in(&state))
                .map(|l| {
                    let suffix = if l.verified { "" } else { " (check pay stub)" };
                    SelectOption::new(&l.id, format!("{}{suffix}", l.name))
                })
                .collect::<Vec<_>>()
        })
    });

    view! {
        <Card kicker="Household" title="Where you live and file">
            <Select label="Filing status" value=status options=status_options
                on_change=Callback::new(move |v: String| {
                    if let Some(s) = FilingStatus::from_id(&v) {
                        d.edit(|p| p.filing_status = s);
                    }
                }) />
            <Select label="State" value=state options=state_options
                on_change=Callback::new(move |v: String| d.edit(|p| {
                    p.state = v;
                    p.locality = None;
                })) />
            <Show when=move || locality_options.with(|o| !o.is_empty())>
                <Select label="City / county" value=locality
                    options=Signal::derive(move || {
                        let mut o = vec![SelectOption::new("", "None of these")];
                        o.extend(locality_options.get());
                        o
                    })
                    on_change=Callback::new(move |v: String| {
                        d.edit(|p| p.locality = (!v.is_empty()).then_some(v));
                    }) />
            </Show>
            <Show when=move || d.read(|p| p.locality.is_none())>
                <Field label="Other local income tax %" input_mode="decimal" value=custom_local
                    placeholder="0" hint=Signal::stored("For a city or county not listed above.".to_string())
                    on_input=Callback::new(move |t: String| {
                        d.edit(|p| p.custom_local_rate_pct = optional_number(&t));
                    }) />
            </Show>
            <Field label="State payroll deductions %" input_mode="decimal" value=other_payroll
                placeholder="0"
                hint=Signal::stored("Paid leave or disability % from a pay stub, if your state has one we don't know.".to_string())
                on_input=Callback::new(move |t: String| {
                    d.edit(|p| p.other_payroll_pct = optional_number(&t));
                }) />
            <Field label="Children under 17" input_mode="numeric" value=dependents
                on_input=Callback::new(move |t: String| d.edit(|p| p.dependents = dependents_from(&t))) />
            <label class="radio" style="font-size: var(--text-sm)">
                <input type="checkbox" prop:checked=move || d.read(|p| p.sync_planned_income)
                    on:change=move |e| {
                        let on = event_target_checked(&e);
                        d.edit(|p| p.sync_planned_income = on);
                    } />
                <span class="dot" style="border-radius: var(--radius-sm)"></span>
                "Use the monthly take-home as the budget planner's income"
            </label>
        </Card>
    }
}

/// `MoneyField`: edits whole dollars but stores cents. The text is redone
/// from the cents whenever they change, like the React effect.
#[component]
fn MoneyField(
    #[prop(into)] label: String,
    cents: Signal<Option<i64>>,
    on_cents: Callback<i64>,
) -> impl IntoView {
    let text = synced(move || cents.get(), whole_dollars_text_ref, |_, _| false);
    view! {
        <Field label=label input_mode="decimal" value=text placeholder="0"
            on_input=Callback::new(move |t: String| {
                on_cents.run(vault_core::money::parse_amount_to_cents(&t).unwrap_or(0));
            }) />
    }
}

fn whole_dollars_text_ref(c: &Option<i64>) -> String {
    whole_dollars_text(*c)
}

#[component]
fn EarnerCard(i: usize, d: Draft, estimate: RwSignal<Option<TaxEstimate>>) -> impl IntoView {
    let name = synced(
        move || d.earner(i, |e| e.name.clone()),
        show_string,
        same_string,
    );
    let freq = synced(
        move || d.earner(i, |e| e.pay_frequency.id().to_string()),
        show_string,
        same_string,
    );
    let retirement = synced(
        move || d.earner(i, |e| e.retirement_pct),
        show_pct,
        same_pct,
    );
    let title = Signal::derive(move || {
        let n = d.earner(i, |e| e.name.clone());
        if n.is_empty() {
            format!("Earner {}", i + 1)
        } else {
            n
        }
    });
    let freq_options = Signal::stored(
        PayFrequency::ALL
            .iter()
            .map(|f| SelectOption::new(f.id(), f.label()))
            .collect::<Vec<_>>(),
    );
    let money = move |get: fn(&TaxEarner) -> Option<i64>, set: fn(&mut TaxEarner, i64)| {
        (
            Signal::derive(move || d.earner(i, get)),
            Callback::new(move |c: i64| d.edit_earner(i, |e| set(e, c))),
        )
    };
    let (gross, set_gross) = money(
        |e| Some(e.gross_annual_cents),
        |e, c| e.gross_annual_cents = c,
    );
    let (hsa, set_hsa) = money(|e| e.hsa_cents, |e, c| e.hsa_cents = Some(c));
    let (health, set_health) = money(
        |e| e.health_premium_cents,
        |e, c| e.health_premium_cents = Some(c),
    );
    let (other, set_other) = money(
        |e| e.other_pretax_cents,
        |e, c| e.other_pretax_cents = Some(c),
    );

    // p = estimate.perEarner[i], with this earner's paychecks a year.
    let line = move || {
        let periods = d.earner(i, |e| e.pay_frequency.periods());
        estimate.with(|e| {
            e.as_ref()
                .and_then(|e| e.per_earner.get(i))
                .map(|p| (p.take_home_cents, periods))
        })
    };

    view! {
        <Card kicker="Earner" title=title>
            <Field label="Name" value=name
                on_input=Callback::new(move |t: String| d.edit_earner(i, |e| e.name = t)) />
            <MoneyField label="Salary before tax (per year)" cents=gross on_cents=set_gross />
            <Select label="Paid" value=freq options=freq_options
                on_change=Callback::new(move |v: String| {
                    if let Some(f) = PayFrequency::from_id(&v) {
                        d.edit_earner(i, |e| e.pay_frequency = f);
                    }
                }) />
            <Field label="401(k) / 403(b) % of pay" input_mode="decimal" value=retirement placeholder="0"
                on_input=Callback::new(move |t: String| d.edit_earner(i, |e| {
                    e.retirement_pct = optional_number(&t);
                    e.retirement_cents = None;
                })) />
            <MoneyField label="HSA through payroll (per year)" cents=hsa on_cents=set_hsa />
            <MoneyField label="Health premiums (per year)" cents=health on_cents=set_health />
            <MoneyField label="Other pre-tax (FSA, commuter; per year)" cents=other on_cents=set_other />
            {move || line().map(|(take_home, periods)| view! {
                <p class="card-body" style="margin: 0px">
                    "Take-home "<strong>{fmt::cents_whole(take_home)}</strong>" a year · "
                    <strong>{fmt::cents_whole(vault_core::money::js_round(take_home as f64 / periods as f64))}</strong>
                    " per paycheck"
                </p>
            })}
            <Show when=move || { d.read(|p| p.earners.len()) > 1 }>
                <Button variant="ghost" icon="trash"
                    on_click=move || d.edit(|p| {
                        if i < p.earners.len() {
                            p.earners.remove(i);
                        }
                    })>
                    "Remove"
                </Button>
            </Show>
        </Card>
    }
}

/// Gross pay → earners' hub → pre-tax, each tax, take-home.
#[component]
fn TaxSankey(
    estimate: RwSignal<Option<TaxEstimate>>,
    period: RwSignal<&'static str>,
    focus: RwSignal<Option<String>>,
) -> impl IntoView {
    let graph = Memo::new(move |_| {
        estimate.with(|e| {
            e.as_ref()
                .map(|e| tax_sankey(e, period_of(period.get())))
                .unwrap_or_default()
        })
    });
    view! {
        <Card kicker="Tax Sankey" title="Where your pay goes">
            <div style="display: flex; justify-content: flex-end">
                <Segmented options=PERIODS value=period aria_label="Period" />
            </div>
            // Node values are already per period.
            <Sankey nodes=Signal::derive(move || graph.get().0) links=Signal::derive(move || graph.get().1)
                format=Callback::new(fmt::cents_whole_f64) focus=focus
                on_focus=Callback::new(move |f| focus.set(f))
                aria_label=Signal::stored("Tax Sankey".to_string()) />
        </Card>
    }
}

#[component]
fn Breakdown(
    estimate: RwSignal<Option<TaxEstimate>>,
    period: RwSignal<&'static str>,
) -> impl IntoView {
    let title = Signal::derive(move || {
        format!(
            "Where {} of pay goes",
            if period.get() == "year" {
                "a year"
            } else {
                "a month"
            }
        )
    });
    let money = move |c: i64| fmt::cents_whole(period_of(period.get()).amount(c));
    view! {
        <Card kicker="Breakdown" title=title>
            {move || estimate.get().map(|e| view! {
                <table class="table">
                    <tbody>
                        <tr>
                            <td>"Gross pay"</td>
                            <td style="text-align: right">{money(e.gross_cents)}</td>
                        </tr>
                        {e.lines.iter().map(|l| view! {
                            <tr>
                                <td>
                                    <span style=format!(
                                        "display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: {}; margin-right: 8px",
                                        l.group.color(),
                                    )></span>
                                    {l.label.clone()}
                                </td>
                                <td style="text-align: right">"\u{2212}"{money(l.amount_cents)}</td>
                            </tr>
                        }).collect_view()}
                        <tr>
                            <td><strong>"Take-home"</strong></td>
                            <td style="text-align: right"><strong>{money(e.take_home_cents)}</strong></td>
                        </tr>
                    </tbody>
                </table>
                {e.notes.iter().map(|n| view! {
                    <p class="card-meta" style="margin: 4px 0px 0px">{n.clone()}</p>
                }).collect_view()}
            })}
        </Card>
    }
}

/// Same household, different place: what changes.
#[component]
fn CompareMove(
    d: Draft,
    estimate: RwSignal<Option<TaxEstimate>>,
    places: Memo<Option<TaxPlacesResponse>>,
) -> impl IntoView {
    let state = RwSignal::new(compare_start_state(&d.read(|p| p.state.clone())).to_string());
    let locality = RwSignal::new(String::new());
    let (other, _) = use_estimate(Signal::derive(move || {
        let state = state.get();
        let locality = Some(locality.get()).filter(|l| !l.is_empty());
        d.draft
            .with(|p| p.as_ref().map(|p| p.moved_to(&state, locality)))
    }));
    let state_options = Signal::derive(move || {
        places.with(|p| {
            p.iter()
                .flat_map(|p| &p.states)
                .map(|s| SelectOption::new(&s.code, &s.name))
                .collect::<Vec<_>>()
        })
    });
    let locs = Memo::new(move |_| {
        let state = state.get();
        places.with(|p| {
            p.iter()
                .flat_map(|p| p.localities_in(&state))
                .map(|l| SelectOption::new(&l.id, &l.name))
                .collect::<Vec<_>>()
        })
    });
    let current = move || estimate.with(|e| e.as_ref().map_or(0, |e| e.take_home_cents));

    view! {
        <Card kicker="Compare a move" title="Take-home somewhere else">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px">
                <Select label="State" value=state options=state_options
                    on_change=Callback::new(move |_| locality.set(String::new())) />
                <Show when=move || locs.with(|l| !l.is_empty())>
                    <Select label="City / county" value=locality
                        options=Signal::derive(move || {
                            let mut o = vec![SelectOption::new("", "None of these")];
                            o.extend(locs.get());
                            o
                        }) />
                </Show>
            </div>
            {move || other.get().map(|o| {
                let (sign, year, month) = move_diff(o.take_home_cents, current());
                let color = if sign == '+' { "var(--color-positive)" } else { "var(--color-negative)" };
                view! {
                    <p class="card-body">
                        "Take-home in "{o.state_name}": "<strong>{fmt::cents_whole(o.take_home_cents)}</strong>
                        " a year — "
                        <strong style=format!("color: {color}")>{sign.to_string()}{fmt::cents_whole(year)}</strong>
                        " ("{sign.to_string()}{fmt::cents_whole(month)}
                        " a month) compared with now. Same pay; only taxes change."
                    </p>
                }
            })}
        </Card>
    }
}
