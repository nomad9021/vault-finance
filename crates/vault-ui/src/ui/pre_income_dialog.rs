//! `<PreIncomeDialog>` (apps/desktop/src/screens/shell/PreIncomeDialog.tsx):
//! "Before income", the taxes and paycheck deductions (from a pay stub) that
//! come out of pay before it reaches income. Both Sankeys draw them first,
//! beside the tax profile's estimate or instead of it.

use leptos::prelude::*;
use leptos::task::spawn_local;
use vault_core::budget_period::{
    pre_income_body, pre_income_invalid, pre_income_kind, pre_income_kind_value, pre_income_total,
    PreIncomeRow, PRE_INCOME_KINDS,
};
use vault_core::budgets::{PreIncome, PreIncomeKind};

use super::{Button, Dialog, Spinner};
use crate::fmt;
use crate::host::{use_host, HostCtx};

/// `crypto.randomUUID()`, or a time-and-random id where it's missing.
fn new_id() -> String {
    let crypto = js_sys::Reflect::get(&js_sys::global(), &"crypto".into()).ok();
    let uuid = crypto.and_then(|c| {
        let f = js_sys::Reflect::get(&c, &"randomUUID".into()).ok()?;
        let f: &js_sys::Function = wasm_bindgen::JsCast::dyn_ref(&f)?;
        f.call0(&c).ok()?.as_string()
    });
    let id = uuid.unwrap_or_else(|| format!("{}-{}", js_sys::Date::now(), js_sys::Math::random()));
    id.chars().take(36).collect()
}

#[component]
pub fn PreIncomeDialog(
    value: PreIncome,
    /// Whether a tax profile estimate exists (otherwise the switch is hidden).
    has_estimate: bool,
    #[prop(into)] on_close: Callback<()>,
    #[prop(into)] on_saved: Callback<PreIncome>,
) -> impl IntoView {
    let host = use_host();
    let rows = RwSignal::new(
        value
            .items
            .iter()
            .map(PreIncomeRow::from_item)
            .collect::<Vec<_>>(),
    );
    let use_estimate = RwSignal::new(value.use_estimate);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let update = move |id: &str, f: &dyn Fn(&mut PreIncomeRow)| {
        rows.update(|rs| {
            if let Some(r) = rs.iter_mut().find(|r| r.id == id) {
                f(r);
            }
        })
    };
    let total = Memo::new(move |_| rows.with(|rs| pre_income_total(rs)));
    let invalid = Memo::new(move |_| rows.with(|rs| pre_income_invalid(rs)));

    let save = move || {
        busy.set(true);
        error.set(None);
        let body = rows.with_untracked(|rs| pre_income_body(rs, use_estimate.get_untracked()));
        let host = host.clone();
        spawn_local(async move {
            match host
                .try_call::<PreIncome>("savePreIncome", &[HostCtx::arg(&body)])
                .await
            {
                Ok(saved) => on_saved.run(saved),
                Err(e) => error.set(Some(if e.is_api_request() {
                    e.message
                } else {
                    "Couldn't save.".into()
                })),
            }
            // `finally`: the dialog may already be gone.
            busy.try_set(false);
        });
    };

    let actions = move || {
        let save = save.clone();
        view! {
            <Button variant="ghost" on_click=move || on_close.run(())>"Cancel"</Button>
            <Button variant="primary" disabled=Signal::derive(move || busy.get() || invalid.get())
                on_click=save>
                {move || if busy.get() {
                    view! { <Spinner label="Saving" /> }.into_any()
                } else {
                    "Save".into_any()
                }}
            </Button>
        }
        .into_any()
    };

    view! {
        <Dialog title="Before income".to_string() on_close=on_close actions=std::sync::Arc::new(actions)>
            <p class="card-meta" style="margin-top: 0px">
                "Taxes and deductions taken out of pay before it reaches your income. They show on the left of both Sankeys, coming off gross pay. Enter monthly amounts (per paycheck × paychecks a month — biweekly is about 2.17)."
            </p>
            <div style="display: flex; flex-direction: column; gap: 8px">
                <For each=move || rows.with(|rs| rs.iter().map(|r| r.id.clone()).collect::<Vec<_>>())
                    key=|id| id.clone()
                    children=move |id: String| {
                        let field = {
                            let id = id.clone();
                            move |f: fn(&PreIncomeRow) -> String| {
                                let id = id.clone();
                                move || rows.with(|rs| rs.iter().find(|r| r.id == id).map(f).unwrap_or_default())
                            }
                        };
                        let (id_name, id_kind, id_amount, id_remove) = (id.clone(), id.clone(), id.clone(), id.clone());
                        let remove_label = field(|r| format!("Remove {}", if r.name.is_empty() { "item" } else { &r.name }));
                        view! {
                            <div style="display: grid; grid-template-columns: minmax(0, 1fr) 108px 84px auto; gap: 6px; align-items: center">
                                <input class="input" aria-label="Name" placeholder="Federal withholding"
                                    prop:value=field(|r| r.name.clone())
                                    on:input=move |e| {
                                        let v = event_target_value(&e);
                                        update(&id_name, &|r| r.name = v.clone());
                                    } />
                                <select class="input" aria-label="Type" style="padding-right: 24px"
                                    on:change=move |e| {
                                        let k: PreIncomeKind = pre_income_kind(&event_target_value(&e));
                                        update(&id_kind, &|r| r.kind = k);
                                    }>
                                    {PRE_INCOME_KINDS.iter().map(|&(_, v, label)| {
                                        let selected = field(move |r| pre_income_kind_value(r.kind).to_string());
                                        view! {
                                            <option value=v prop:selected=move || selected() == v>{label}</option>
                                        }
                                    }).collect_view()}
                                </select>
                                <input class="input" aria-label="Monthly amount" inputmode="decimal" placeholder="0.00"
                                    prop:value=field(|r| r.amount.clone())
                                    on:input=move |e| {
                                        let v = event_target_value(&e);
                                        update(&id_amount, &|r| r.amount = v.clone());
                                    } />
                                <Button variant="ghost" size="sm" icon="trash"
                                    aria_label=Signal::derive(remove_label)
                                    on_click=move || rows.update(|rs| rs.retain(|x| x.id != id_remove)) />
                            </div>
                        }
                    } />
                <div class="row-between">
                    <Button variant="ghost" size="sm" icon="plus"
                        disabled=Signal::derive(move || rows.with(|rs| rs.len() >= 30))
                        on_click=move || rows.update(|rs| rs.push(PreIncomeRow {
                            id: new_id(),
                            name: String::new(),
                            kind: PreIncomeKind::Tax,
                            amount: String::new(),
                        }))>
                        "Add item"
                    </Button>
                    {move || rows.with(|rs| !rs.is_empty()).then(|| view! {
                        <span class="card-meta">{format!("{} a month", fmt::cents(total.get()))}</span>
                    })}
                </div>
            </div>
            {has_estimate.then(|| view! {
                <label class="radio" style="font-size: var(--text-sm); margin-top: 12px">
                    <input type="checkbox" prop:checked=move || use_estimate.get()
                        on:change=move |e| use_estimate.set(event_target_checked(&e)) />
                    <span class="dot" style="border-radius: var(--radius-sm)"></span>
                    "Also show the estimated taxes from Salary & taxes (turn off if these items are your real figures)"
                </label>
            })}
            {move || error.get().map(|e| view! {
                <p role="alert" style="color: var(--color-negative); font-size: var(--text-sm)">{e}</p>
            })}
        </Dialog>
    }
}
