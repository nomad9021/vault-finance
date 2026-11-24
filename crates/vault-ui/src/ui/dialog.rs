//! `<Dialog>` from packages/ui/src/primitives/Dialog.tsx.

use leptos::portal::Portal;
use leptos::prelude::*;
use wasm_bindgen::JsCast;

use super::listen::on_window;

/// How far a sheet must be dragged down (px) before letting go closes it.
const DISMISS_PX: f64 = 96.0;

/// A modal on `<body>` (always open: render it conditionally, like the React
/// pages do with `{editing && <Dialog open …>}`). On phones it's a bottom
/// sheet that can be dragged down by its grabber or title to dismiss.
#[component]
pub fn Dialog(
    #[prop(into)] title: Signal<String>,
    #[prop(into)] on_close: Callback<()>,
    #[prop(optional)] actions: Option<ChildrenFn>,
    children: ChildrenFn,
) -> impl IntoView {
    let drag = RwSignal::new(0.0_f64);
    // (start y, start time) while a drag is in progress.
    let start = RwSignal::new(None::<(f64, f64)>);
    let now = || window().performance().map(|p| p.now()).unwrap_or(0.0);

    on_window("keydown", false, move |e| {
        if let Some(e) = e.dyn_ref::<web_sys::KeyboardEvent>() {
            if e.key() == "Escape" {
                on_close.run(());
            }
        }
    });

    let on_down = move |e: web_sys::PointerEvent| {
        let phone = window()
            .match_media("(max-width: 640px)")
            .ok()
            .flatten()
            .is_some_and(|m| m.matches());
        if !phone {
            return;
        }
        start.set(Some((e.client_y() as f64, now())));
        if let Some(el) = e
            .current_target()
            .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
        {
            let _ = el.set_pointer_capture(e.pointer_id());
        }
    };
    let on_move = move |e: web_sys::PointerEvent| {
        if let Some((y, _)) = start.get_untracked() {
            drag.set((e.client_y() as f64 - y).max(0.0));
        }
    };
    let on_up = move |e: web_sys::PointerEvent| {
        let Some((y, t)) = start.get_untracked() else {
            return;
        };
        start.set(None);
        let dy = e.client_y() as f64 - y;
        let fast = dy / (now() - t).max(1.0) > 0.6; // a quick flick
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
                <div class="dialog" role="dialog" aria-modal="true" aria-label=move || title.get()
                    style=move || {
                        let d = drag.get();
                        (d != 0.0).then(|| format!("transform: translateY({d}px); transition: none"))
                    }>
                    <div class="dialog-drag" on:pointerdown=on_down on:pointermove=on_move
                        on:pointerup=on_up on:pointercancel=on_up>
                        <div class="dialog-grabber" aria-hidden="true"></div>
                        <div class="dialog-title">{move || title.get()}</div>
                    </div>
                    <div class="dialog-body">{children()}</div>
                    {actions.clone().map(|a| view! { <div class="dialog-actions">{a()}</div> })}
                </div>
            </div>
        </Portal>
    }
}
