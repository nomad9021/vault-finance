//! `<SwipeRow>` from apps/desktop/src/screens/shell/SwipeRow.tsx.

use leptos::html;
use leptos::prelude::*;
use wasm_bindgen::JsCast;

use super::listen::listen;

/// px per action button.
const ACTION_W: f64 = 80.0;

/// One button revealed by a swipe.
#[derive(Clone)]
pub struct SwipeAction {
    pub label: &'static str,
    pub danger: bool,
    pub on_action: Callback<()>,
}

#[derive(Clone, Copy)]
struct Gesture {
    x0: f64,
    y0: f64,
    base: f64,
    /// `Some(true)` = sideways, `Some(false)` = vertical, `None` = undecided.
    sideways: Option<bool>,
}

/// A list row with iPhone-style swipe actions: swipe left to reveal buttons
/// on the right (like Mail), swipe back or tap the row to close. Vertical
/// scrolling stays native (touch-action: pan-y); a gesture only counts as a
/// swipe once it's clearly sideways. Mouse users get the same actions
/// through the row's own tap, so nothing is swipe-only.
#[component]
pub fn SwipeRow(
    actions: Vec<SwipeAction>,
    /// Names the row for the actions' screen-reader labels.
    #[prop(into)]
    label: String,
    children: Children,
) -> impl IntoView {
    let width = actions.len() as f64 * ACTION_W;
    let x = RwSignal::new(0.0_f64);
    let dragging = RwSignal::new(false);
    let g = StoredValue::new(None::<Gesture>);
    let moved = StoredValue::new(false);
    let front = NodeRef::<html::Div>::new();

    let on_down = move |e: web_sys::PointerEvent| {
        if e.pointer_type() == "mouse" {
            return;
        }
        g.set_value(Some(Gesture {
            x0: e.client_x() as f64,
            y0: e.client_y() as f64,
            base: x.get_untracked(),
            sideways: None,
        }));
        moved.set_value(false);
    };
    let on_move = move |e: web_sys::PointerEvent| {
        let Some(mut s) = g.get_value() else {
            return;
        };
        let dx = e.client_x() as f64 - s.x0;
        let dy = e.client_y() as f64 - s.y0;
        if s.sideways.is_none() {
            if dx.abs() < 8.0 && dy.abs() < 8.0 {
                return;
            }
            let sideways = dx.abs() > dy.abs() * 1.2;
            s.sideways = Some(sideways);
            g.set_value(Some(s));
            if sideways {
                if let Some(el) = e
                    .current_target()
                    .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
                {
                    let _ = el.set_pointer_capture(e.pointer_id());
                }
                dragging.set(true);
            }
        }
        if s.sideways != Some(true) {
            return;
        }
        moved.set_value(true);
        // Resistance past fully open; no swiping right past closed.
        let next = s.base + dx;
        x.set(if next < -width {
            -width + (next + width) * 0.25
        } else {
            next.min(0.0)
        });
    };
    let on_up = move |_: web_sys::PointerEvent| {
        let s = g.get_value();
        g.set_value(None);
        dragging.set(false);
        if s.and_then(|s| s.sideways) != Some(true) {
            return;
        }
        x.update(|cur| *cur = if *cur < -width / 2.0 { -width } else { 0.0 });
    };

    // A swipe isn't a tap, and tapping an open row just closes it (capture
    // phase, before the row's own click).
    Effect::new(move || {
        if let Some(el) = front.get() {
            let target: web_sys::EventTarget = el.into();
            listen(target, "click", true, move |e| {
                if moved.get_value() || x.get_untracked() != 0.0 {
                    e.stop_propagation();
                    e.prevent_default();
                    moved.set_value(false);
                    x.set(0.0);
                }
            });
        }
    });

    let closed = move || x.get() == 0.0;
    view! {
        <div class="swipe-row">
            <div class="swipe-actions" style=format!("width: {width}px")
                aria-hidden=move || if closed() { "true" } else { "false" }>
                {actions.into_iter().map(|a| {
                    let aria = format!("{} {label}", a.label);
                    view! {
                        <button type="button" tabindex=move || if closed() { "-1" } else { "0" }
                            class=if a.danger { "swipe-action is-danger" } else { "swipe-action" }
                            aria-label=aria
                            on:click=move |_| {
                                x.set(0.0);
                                a.on_action.run(());
                            }>
                            {a.label}
                        </button>
                    }
                }).collect_view()}
            </div>
            <div node_ref=front class="swipe-front"
                style=move || {
                    let mut s = Vec::new();
                    let v = x.get();
                    if v != 0.0 {
                        s.push(format!("transform: translateX({v}px)"));
                    }
                    if dragging.get() {
                        s.push("transition: none".to_string());
                    }
                    (!s.is_empty()).then(|| s.join("; "))
                }
                on:pointerdown=on_down on:pointermove=on_move on:pointerup=on_up on:pointercancel=on_up>
                {children()}
            </div>
        </div>
    }
}
