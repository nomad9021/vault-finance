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
