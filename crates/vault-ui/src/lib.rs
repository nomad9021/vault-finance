//! Vault Finance pages written in Leptos.
//!
//! The React shell (apps/desktop/src/rust/RustPage.tsx) owns the window,
//! navigation, sign-in and the `ApiClient`; it calls [`mount`] with a page id
//! and a small [`host::Host`] object. A Rust page fetches through the host,
//! so auth, certificate pinning and response validation stay in one place
//! while pages move over one at a time (docs/rust-port.md).

use leptos::prelude::*;
use wasm_bindgen::prelude::*;

pub mod fmt;
pub mod host;
pub mod pages;
pub mod ui;

/// A mounted page. Dropping it (or calling `unmount`) removes the page's DOM
/// and disposes its reactive graph.
#[wasm_bindgen]
pub struct Mounted {
    handle: Option<Box<dyn std::any::Any>>,
    unsubscribe: Option<js_sys::Function>,
}

#[wasm_bindgen]
impl Mounted {
    pub fn unmount(&mut self) {
        if let Some(f) = self.unsubscribe.take() {
            let _ = f.call0(&JsValue::NULL);
        }
        self.handle.take();
    }
}

/// Page ids the Rust side can draw, for the React shell to check before it
/// hands a page over.
#[wasm_bindgen(js_name = pageIds)]
pub fn page_ids() -> Vec<String> {
    pages::IDS.iter().map(|s| s.to_string()).collect()
}

/// What the shell's `NavFilter` says about how to open the page.
#[derive(Clone, Debug, Default)]
pub struct PageArgs {
    /// `filter.tab`: the tab to open on (pages read it once, at mount).
    pub tab: Option<String>,
}

/// Draw `page` into `el`. Errors if the page isn't ported yet.
#[wasm_bindgen]
pub fn mount(
    el: web_sys::HtmlElement,
    page: &str,
    host: host::Host,
    tab: Option<String>,
) -> Result<Mounted, JsError> {
    console_error_panic_hook::set_once();
    if !pages::IDS.contains(&page) {
        return Err(JsError::new(&format!("no Rust page called {page:?}")));
    }
    let page = page.to_string();
    let ctx = host::HostCtx::new(host);
    let unsubscribe = ctx.subscribe_data_changes();
    let handle = leptos::mount::mount_to(el, move || {
        provide_context(ctx.clone());
        provide_context(PageArgs { tab: tab.clone() });
        pages::render(&page)
    });
    Ok(Mounted {
        handle: Some(Box::new(handle)),
        unsubscribe: Some(unsubscribe),
    })
}
