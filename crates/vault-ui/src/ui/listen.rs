//! Event listeners on window/document that live as long as the component
//! that adds them (React's `useEffect(() => { add…; return remove… })`).

use leptos::prelude::*;
use send_wrapper::SendWrapper;
use wasm_bindgen::prelude::*;

/// Listen on `target` until the current owner is cleaned up.
pub fn listen(
    target: web_sys::EventTarget,
    event: &'static str,
    capture: bool,
    cb: impl Fn(web_sys::Event) + 'static,
) {
    let closure = Closure::<dyn Fn(web_sys::Event)>::new(cb);
    let _ = target.add_event_listener_with_callback_and_bool(
        event,
        closure.as_ref().unchecked_ref(),
        capture,
    );
    let held = SendWrapper::new((target, closure));
    on_cleanup(move || {
        let (target, closure) = held.take();
        let _ = target.remove_event_listener_with_callback_and_bool(
            event,
            closure.as_ref().unchecked_ref(),
            capture,
        );
    });
}

pub fn on_window(event: &'static str, capture: bool, cb: impl Fn(web_sys::Event) + 'static) {
    listen(window().into(), event, capture, cb);
}

pub fn on_document(event: &'static str, capture: bool, cb: impl Fn(web_sys::Event) + 'static) {
    listen(document().into(), event, capture, cb);
}

/// `useId()`: a document-unique id for label/input pairs.
pub fn use_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    format!("rs-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// A window listener that lives until the returned function is called, for
/// listeners added mid-gesture (a drag) rather than for a component's life.
/// `passive: false` lets the handler `preventDefault()` scrolling.
pub fn window_listener(
    event: &'static str,
    passive: bool,
    cb: impl Fn(web_sys::Event) + 'static,
) -> Box<dyn FnOnce()> {
    let closure = Closure::<dyn Fn(web_sys::Event)>::new(cb);
    let opts = web_sys::AddEventListenerOptions::new();
    opts.set_passive(passive);
    let w = window();
    let _ = w.add_event_listener_with_callback_and_add_event_listener_options(
        event,
        closure.as_ref().unchecked_ref(),
        &opts,
    );
    Box::new(move || {
        let _ = w.remove_event_listener_with_callback(event, closure.as_ref().unchecked_ref());
        // Often called from inside one of the gesture's own handlers: drop
        // the closure after it has returned, never while it runs.
        wasm_bindgen_futures::spawn_local(async move { drop(closure) });
    })
}

/// `useLayoutMode() === "narrow"`: the window is under 900px (the shell's
/// bottom-tab-bar layout), kept current as it crosses the breakpoint.
pub fn use_narrow_layout() -> ReadSignal<bool> {
    let query = window().match_media("(max-width: 899.98px)").ok().flatten();
    let (narrow, set_narrow) = signal(query.as_ref().is_some_and(|q| q.matches()));
    if let Some(q) = query {
        let read = q.clone();
        listen(q.into(), "change", false, move |_| {
            set_narrow.set(read.matches())
        });
    }
    narrow
}
