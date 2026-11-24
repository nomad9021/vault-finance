//! `<Dialog>` (packages/ui/src/primitives/Dialog.tsx) and the debt-free
//! `<Confetti>` burst.

use leptos::{ev, portal::Portal, prelude::*};
use wasm_bindgen::JsCast;

/// How far a sheet must be dragged down (px) before letting go closes it.
const DISMISS_PX: f64 = 96.0;

fn now_ms() -> f64 {
    window().performance().map(|p| p.now()).unwrap_or(0.0)
}

/// A modal, rendered on `<body>` like the React one (an ancestor `.page`
/// keeps a transform, which would trap `position: fixed`). On a phone it is a
/// bottom sheet that can be dragged down by its grabber or title to dismiss.
/// Rendering it means it's open; the caller drops it to close.
#[component]
pub fn Dialog(
    #[prop(into)] title: String,
    on_close: Callback<()>,
    /// Rendered in the actions row, right-aligned.
    #[prop(optional, into)]
    actions: Option<ViewFn>,
    children: ChildrenFn,
) -> impl IntoView {
    let keys = window_event_listener(ev::keydown, move |e| {
        if e.key() == "Escape" {
            on_close.run(());
        }
    });
    on_cleanup(move || keys.remove());

    let drag = RwSignal::new(0.0f64);
    let start = StoredValue::new(None::<(f64, f64)>);
    let on_down = move |e: ev::PointerEvent| {
        let phone = window()
            .match_media("(max-width: 640px)")
            .ok()
            .flatten()
            .is_some_and(|m| m.matches());
        if !phone {
            return;
        }
        start.set_value(Some((e.client_y() as f64, now_ms())));
        if let Some(el) = e
            .current_target()
            .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
        {
            let _ = el.set_pointer_capture(e.pointer_id());
        }
    };
    let on_move = move |e: ev::PointerEvent| {
        if let Some((y, _)) = start.get_value() {
            drag.set((e.client_y() as f64 - y).max(0.0));
        }
    };
    let on_up = move |e: ev::PointerEvent| {
        let Some((y, t)) = start.get_value() else {
            return;
        };
        start.set_value(None);
        let dy = e.client_y() as f64 - y;
        let fast = dy / (now_ms() - t).max(1.0) > 0.6; // a quick flick
        drag.set(0.0);
        if dy > DISMISS_PX || (fast && dy > 24.0) {
            on_close.run(());
        }
    };

    view! {
        <Portal>
            <div class="dialog-backdrop" on:click=move |e| {
                if e.target() == e.current_target() {
                    on_close.run(());
                }
            }>
                <div class="dialog" role="dialog" aria-modal="true" aria-label=title.clone()
                    style=move || {
                        let d = drag.get();
                        (d != 0.0).then(|| format!("transform: translateY({d}px); transition: none"))
                    }>
                    <div class="dialog-drag" on:pointerdown=on_down on:pointermove=on_move
                        on:pointerup=on_up on:pointercancel=on_up>
                        <div class="dialog-grabber" aria-hidden="true"></div>
                        <div class="dialog-title">{title.clone()}</div>
                    </div>
                    <div class="dialog-body">{children()}</div>
                    {actions.clone().map(|a| view! { <div class="dialog-actions">{a.run()}</div> })}
                </div>
            </div>
        </Portal>
    }
}

const CONFETTI_COLORS: [&str; 6] = [
    "#3ecf8e", "#43cfc0", "#6f8ef2", "#b47ef0", "#ec6a9c", "#d8b23c",
];

/// A one-shot burst of falling confetti (`confettiFall` in base.css).
#[component]
pub fn Confetti() -> impl IntoView {
    let rnd = js_sys::Math::random;
    let pieces = (0..28).map(|i| {
        let left = rnd() * 100.0;
        let delay = rnd() * 0.7;
        let duration = 1.8 + rnd() * 1.4;
        let color = CONFETTI_COLORS[i % CONFETTI_COLORS.len()];
        let size = 6.0 + rnd() * 6.0;
        let style = format!(
            "position: absolute; top: -14px; left: {left}%; width: {size}px; height: {}px; background: {color}; border-radius: 1px; animation: confettiFall {duration}s linear {delay}s",
            size * 0.42
        );
        view! { <span style=style></span> }
    });
    view! {
        <div aria-hidden="true" style="position: absolute; inset: 0; pointer-events: none; overflow: hidden">
            {pieces.collect_view()}
        </div>
    }
}
