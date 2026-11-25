//! `useSankeyOrder` (apps/desktop/src/lib/sankeyOrder.ts): the person's own
//! arrangement of the Sankey bars, saved to their account and shared by every
//! diagram on the Rust side, so dragging a bar in one moves it in all.

use std::cell::{Cell, RefCell};

use leptos::prelude::*;
use vault_core::preferences::{Preferences, SankeyOrderBody};

use crate::host::{use_host, HostCtx};

type Listeners = Vec<(u32, RwSignal<Option<Vec<String>>>)>;

thread_local! {
    static CACHE: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
    static LOADING: Cell<bool> = const { Cell::new(false) };
    static LISTENERS: RefCell<Listeners> = const { RefCell::new(Vec::new()) };
    static NEXT: Cell<u32> = const { Cell::new(0) };
}

fn notify(order: &Option<Vec<String>>) {
    let listeners = LISTENERS.with(|l| l.borrow().iter().map(|(_, s)| *s).collect::<Vec<_>>());
    for s in listeners {
        s.set(order.clone());
    }
}

/// The saved order (`None` until it has loaded) and a setter that saves it.
pub fn use_sankey_order() -> (Signal<Option<Vec<String>>>, Callback<Vec<String>>) {
    let host = use_host();
    let order = RwSignal::new(CACHE.with(|c| c.borrow().clone()));
    let key = NEXT.with(|n| {
        let k = n.get();
        n.set(k + 1);
        k
    });
    LISTENERS.with(|l| l.borrow_mut().push((key, order)));
    on_cleanup(move || LISTENERS.with(|l| l.borrow_mut().retain(|(k, _)| *k != key)));

    if CACHE.with(|c| c.borrow().is_none()) && !LOADING.with(Cell::get) {
        LOADING.with(|l| l.set(true));
        let host = host.clone();
        leptos::task::spawn_local(async move {
            if let Ok(p) = host.call::<Preferences>("preferences", &[]).await {
                let loaded = Some(p.sankey_order.unwrap_or_default());
                CACHE.with(|c| *c.borrow_mut() = loaded.clone());
                notify(&loaded);
            }
            LOADING.with(|l| l.set(false));
        });
    }

    let save = Callback::new(move |next: Vec<String>| {
        host.fire(
            "savePreferences",
            &[HostCtx::arg(&SankeyOrderBody {
                sankey_order: &next,
            })],
        );
        let next = Some(next);
        CACHE.with(|c| *c.borrow_mut() = next.clone());
        notify(&next);
    });
    (order.into(), save)
}
