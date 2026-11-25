//! Form controls: `<Field>`, `<Select>` and `<DateField>` from
//! packages/ui/src/primitives.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use leptos::html;
use leptos::portal::Portal;
use leptos::prelude::*;
use vault_core::dates::{out_of_range, Month};
use wasm_bindgen::prelude::*;

use super::listen::{on_document, on_window, use_id};
use super::Icon;
use crate::fmt;

/// `<Field>`: labelled `.input`, two-way bound to `value`.
#[component]
pub fn Field(
    #[prop(into)] label: TextProp,
    value: RwSignal<String>,
    #[prop(optional, into)] placeholder: MaybeProp<String>,
    #[prop(optional)] input_mode: Option<&'static str>,
    /// Focus on mount (React's `autoFocus`).
    #[prop(optional)]
    autofocus: bool,
    #[prop(optional, into)] hint: Option<Signal<String>>,
    /// Enter pressed in the input (React's `onKeyDown` checking `e.key`).
    #[prop(optional)]
    on_enter: Option<Callback<()>>,
    /// Validation message; shown instead of the hint (and marks the input
    /// invalid) while non-empty.
    #[prop(optional, into)]
    error: Option<Signal<Option<String>>>,
    #[prop(optional)] max_length: Option<u32>,
    /// Rewrites what's typed before it's stored (React's
    /// `onChange={(e) => set(e.target.value.replace(…))}`).
    #[prop(optional)]
    filter: Option<fn(&str) -> String>,
) -> impl IntoView {
    let id = use_id();
    let input = NodeRef::<html::Input>::new();
    let current_error = move || error.and_then(|e| e.get()).filter(|e| !e.is_empty());
    if autofocus {
        Effect::new(move || {
            if let Some(el) = input.get() {
                let _ = el.focus();
            }
        });
    }
    view! {
        <div class="field">
            <label for=id.clone()>{move || label.get()}</label>
            <input node_ref=input id=id class="input" placeholder=move || placeholder.get() inputmode=input_mode
                maxlength=max_length aria-invalid=move || current_error().map(|_| "true")
                prop:value=move || value.get()
                on:input=move |e| {
                    let raw = event_target_value(&e);
                    match filter {
                        Some(f) => {
                            let clean = f(&raw);
                            // A rejected keystroke leaves the signal unchanged, so
                            // put the controlled value back by hand.
                            if clean != raw {
                                if let Some(el) = input.get_untracked() {
                                    el.set_value(&clean);
                                }
                            }
                            value.set(clean);
                        }
                        None => value.set(raw),
                    }
                }
                on:keydown=move |e| {
                    if let Some(f) = on_enter.filter(|_| e.key() == "Enter") {
                        f.run(());
                    }
                } />
            {move || match current_error() {
                Some(e) => Some(view! { <div role="alert" class="field-error">{e}</div> }.into_any()),
                None => hint.map(|h| view! { <div class="field-hint">{move || h.get()}</div> }.into_any()),
            }}
        </div>
    }
}

/// One `<option>`: value, label, disabled.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
    pub disabled: bool,
}

impl SelectOption {
    pub fn new(value: impl Into<String>, label: impl Into<String>) -> Self {
        SelectOption {
            value: value.into(),
            label: label.into(),
            disabled: false,
        }
    }
}

/// `<Select>`: a native select styled with `.input`, under a label.
#[component]
pub fn Select(
    #[prop(into)] label: String,
    value: RwSignal<String>,
    #[prop(into)] options: Signal<Vec<SelectOption>>,
) -> impl IntoView {
    let id = use_id();
    view! {
        <div class="field">
            <label for=id.clone()>{label}</label>
            <select id=id class="input" on:change=move |e| value.set(event_target_value(&e))>
                {move || options.get().into_iter().map(|o| {
                    let v = o.value.clone();
                    view! {
                        <option value=o.value disabled=o.disabled
                            prop:selected=move || value.get() == v>{o.label}</option>
                    }
                }).collect_view()}
            </select>
        </div>
    }
}

fn today_iso() -> String {
    String::from(js_sys::Date::new_0().to_iso_string())
        .chars()
        .take(10)
        .collect()
}

/// `<DateField>`: a date field that owns its own calendar (the native
/// date input's popup ignores the theme and misbehaves on WebKitGTK). The
/// popover is on `<body>`, fixed, following the trigger as things scroll.
#[component]
pub fn DateField(
    #[prop(into)] label: String,
    /// "YYYY-MM-DD", or "" for no date.
    value: RwSignal<String>,
    #[prop(default = "Pick a date")] placeholder: &'static str,
    #[prop(default = true)] clearable: bool,
    #[prop(optional)] min: Option<&'static str>,
    #[prop(optional)] max: Option<&'static str>,
) -> impl IntoView {
    let id = use_id();
    let trigger = NodeRef::<html::Button>::new();
    let pop = NodeRef::<html::Div>::new();
    let open = RwSignal::new(false);
    // Which month the grid shows; you can page without picking anything.
    let cursor = RwSignal::new(Month::of(&value.get_untracked(), &today_iso()));
    let pos = RwSignal::new(None::<(f64, f64, f64)>);

    let close = move |focus_trigger: bool| {
        open.set(false);
        if focus_trigger {
            if let Some(t) = trigger.get_untracked() {
                let _ = t.focus();
            }
        }
    };

    // Re-sync the visible month when the value changes from outside.
    Effect::new(move || {
        let v = value.get();
        if !open.get() {
            cursor.set(Month::of(&v, &today_iso()));
        }
    });

    let place = move || {
        let Some(el) = trigger.get_untracked() else {
            return;
        };
        let r = el.get_bounding_client_rect();
        let win = window();
        let inner_h = win
            .inner_height()
            .ok()
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let inner_w = win
            .inner_width()
            .ok()
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let width = r.width().max(268.0);
        let height = pop
            .get_untracked()
            .map(|p| p.offset_height() as f64)
            .unwrap_or(320.0);
        // Flip above when there isn't room below; keep it on screen.
        let below = inner_h - r.bottom();
        let top = if below < height + 12.0 && r.top() > height + 12.0 {
            r.top() - height - 6.0
        } else {
            r.bottom() + 6.0
        };
        let left = r.left().max(8.0).min(inner_w - width - 8.0);
        pos.set(Some((top, left, width)));
    };

    Effect::new(move || {
        if open.get() {
            place();
        }
    });
    on_window("scroll", true, move |_| {
        if open.get_untracked() {
            place();
        }
    });
    on_window("resize", false, move |_| {
        if open.get_untracked() {
            place();
        }
    });

    on_document("mousedown", true, move |e| {
        if !open.get_untracked() {
            return;
        }
        let target = e.target().and_then(|t| t.dyn_into::<web_sys::Node>().ok());
        let inside =
            |el: Option<web_sys::Element>| el.is_some_and(|el| el.contains(target.as_ref()));
        if inside(pop.get_untracked().map(Into::into))
            || inside(trigger.get_untracked().map(Into::into))
        {
            return;
        }
        // Clicking away commits nothing and closes the picker. A Dialog
        // backdrop dismisses on `click`, so swallow the matching click too,
        // then stand down; a mousedown that never becomes a click mustn't
        // leave the swallower armed.
        e.prevent_default();
        e.stop_propagation();
        swallow_next_click();
        close(false);
    });
    on_document("keydown", true, move |e| {
        if !open.get_untracked() {
            return;
        }
        let Some(k) = e.dyn_ref::<web_sys::KeyboardEvent>() else {
            return;
        };
        if k.key() != "Escape" {
            return;
        }
        // Swallow it, or the surrounding Dialog closes too.
        e.prevent_default();
        e.stop_propagation();
        close(true);
    });

    let pick = move |iso: String| {
        value.set(iso);
        close(true);
    };

    let pop_label = format!("Choose {label}");
    view! {
        <div class="field">
            <label for=id.clone()>{label}</label>
            <button id=id node_ref=trigger type="button" class="input datefield-trigger"
                aria-haspopup="dialog" aria-expanded=move || if open.get() { "true" } else { "false" }
                on:click=move |_| {
                    cursor.set(Month::of(&value.get_untracked(), &today_iso()));
                    open.update(|o| *o = !*o);
                }>
                {move || {
                    let v = value.get();
                    if v.is_empty() {
                        view! { <span class="datefield-placeholder">{placeholder}</span> }.into_any()
                    } else {
                        view! { <span>{fmt::long_date(&v)}</span> }.into_any()
                    }
                }}
                <Icon name="calendar" size=16 />
            </button>
            {move || (open.get() && pos.get().is_some()).then(|| {
                let pop_label = pop_label.clone();
                view! {
                    <Portal>
                        <div node_ref=pop class="datefield-pop elev-lg" role="dialog" aria-label=pop_label.clone()
                            style=move || pos.get().map(|(t, l, w)| format!("top: {t}px; left: {l}px; width: {w}px"))>
                            <div class="datefield-head">
                                <button type="button" class="datefield-nav" aria-label="Previous month"
                                    on:click=move |_| cursor.update(|c| *c = c.shift(-1))>
                                    <Icon name="chevronLeft" size=16 />
                                </button>
                                <div class="datefield-month">{move || fmt::month_long_year(cursor.get())}</div>
                                <button type="button" class="datefield-nav" aria-label="Next month"
                                    on:click=move |_| cursor.update(|c| *c = c.shift(1))>
                                    <Icon name="chevronRight" size=16 />
                                </button>
                            </div>
                            <div class="datefield-grid" role="grid">
                                {["M", "T", "W", "T", "F", "S", "S"].map(|d| view! {
                                    <div class="datefield-dow" aria-hidden="true">{d}</div>
                                })}
                                {move || {
                                    let today = today_iso();
                                    let selected = value.get();
                                    cursor.get().days().into_iter().map(|cell| match cell {
                                        None => view! { <span></span> }.into_any(),
                                        Some(cell) => {
                                            let is_today = cell.iso == today;
                                            let iso = cell.iso.clone();
                                            view! {
                                                <button type="button" class="datefield-day"
                                                    disabled=out_of_range(&cell.iso, min, max)
                                                    aria-current=is_today.then_some("date")
                                                    data-selected=(cell.iso == selected).then_some("true")
                                                    data-today=is_today.then_some("true")
                                                    on:click=move |_| pick(iso.clone())>
                                                    {cell.day}
                                                </button>
                                            }.into_any()
                                        }
                                    }).collect_view()
                                }}
                            </div>
                            <div class="datefield-foot">
                                <button type="button" class="datefield-action" on:click=move |_| pick(today_iso())>
                                    "Today"
                                </button>
                                {clearable.then(|| view! {
                                    <button type="button" class="datefield-action"
                                        on:click=move |_| { value.set(String::new()); close(true); }>
                                        "Clear"
                                    </button>
                                })}
                            </div>
                        </div>
                    </Portal>
                }
            })}
        </div>
    }
}

/// Eat the next click anywhere (capture phase), or give up after 400 ms.
fn swallow_next_click() {
    let doc = document();
    let timer = Rc::new(Cell::new(0));
    let armed: Rc<RefCell<Option<js_sys::Function>>> = Rc::new(RefCell::new(None));
    let cleanup = {
        let (doc, timer, armed) = (doc.clone(), timer.clone(), armed.clone());
        Rc::new(move || {
            if let Some(f) = armed.borrow_mut().take() {
                let _ = doc.remove_event_listener_with_callback_and_bool("click", &f, true);
                window().clear_timeout_with_handle(timer.get());
            }
        })
    };
    // Handed to JS (into_js_value) rather than dropped from inside its own
    // call; one small closure per click-away.
    let swallow: js_sys::Function = {
        let cleanup = cleanup.clone();
        Closure::<dyn Fn(web_sys::Event)>::new(move |ev: web_sys::Event| {
            ev.prevent_default();
            ev.stop_propagation();
            cleanup();
        })
        .into_js_value()
        .unchecked_into()
    };
    let _ = doc.add_event_listener_with_callback_and_bool("click", &swallow, true);
    *armed.borrow_mut() = Some(swallow);
    let on_timeout = Closure::once_into_js(move || cleanup());
    if let Ok(h) = window()
        .set_timeout_with_callback_and_timeout_and_arguments_0(on_timeout.unchecked_ref(), 400)
    {
        timer.set(h);
    }
}
