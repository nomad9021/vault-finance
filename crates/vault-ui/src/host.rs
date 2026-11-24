//! The bridge to the React shell.

use std::rc::Rc;

use leptos::prelude::*;
use send_wrapper::SendWrapper;
use serde::{de::DeserializeOwned, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// Built in RustPage.tsx. Keep the two in sync.
    pub type Host;

    /// Call an `ApiClient` method by name; resolves to its (already
    /// zod-validated) result.
    #[wasm_bindgen(method, catch)]
    async fn call(this: &Host, method: &str, args: js_sys::Array) -> Result<JsValue, JsValue>;

    /// Move to another page, with an optional `NavFilter`.
    #[wasm_bindgen(method)]
    fn navigate(this: &Host, page: &str, filter: JsValue);

    /// Run `cb` whenever the assistant changes data; returns an unsubscribe
    /// function.
    #[wasm_bindgen(method, js_name = onDataChange)]
    fn on_data_change(this: &Host, cb: &js_sys::Function) -> js_sys::Function;
}

/// What pages get from context: the host plus a counter that ticks when the
/// assistant changes data, so resources that read it refetch.
#[derive(Clone)]
pub struct HostCtx {
    host: SendWrapper<Rc<Host>>,
    pub data_version: RwSignal<u32>,
}

impl HostCtx {
    pub fn new(host: Host) -> Self {
        Self {
            host: SendWrapper::new(Rc::new(host)),
            data_version: RwSignal::new(0),
        }
    }

    pub(crate) fn subscribe_data_changes(&self) -> js_sys::Function {
        let version = self.data_version;
        let cb = Closure::<dyn Fn()>::new(move || version.update(|v| *v += 1));
        let unsubscribe = self.host.on_data_change(cb.as_ref().unchecked_ref());
        // Lives as long as the page; RustPage unsubscribes on unmount.
        cb.forget();
        unsubscribe
    }

    pub async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        args: &[JsValue],
    ) -> Result<T, String> {
        let array: js_sys::Array = args.iter().collect();
        let value = self
            .host
            .call(method, array)
            .await
            .map_err(js_error_message)?;
        serde_wasm_bindgen::from_value(value)
            .map_err(|e| format!("{method}: unexpected response ({e})"))
    }

    /// Call an `ApiClient` method without waiting for or reading the result,
    /// like `void client.method(...)` (the request outlives the page).
    pub fn fire(&self, method: &str, args: &[JsValue]) {
        let host = Rc::clone(&self.host);
        let method = method.to_string();
        let array: js_sys::Array = args.iter().collect();
        wasm_bindgen_futures::spawn_local(async move {
            let _ = host.call(&method, array).await;
        });
    }

    /// A request body for `call`/`fire`: plain JSON-shaped JS (maps become
    /// objects, not `Map`s, so `JSON.stringify` sends them).
    pub fn arg(value: &impl Serialize) -> JsValue {
        value
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .unwrap_or(JsValue::UNDEFINED)
    }

    pub fn navigate(&self, page: &str, filter: &impl Serialize) {
        let filter = serde_wasm_bindgen::to_value(filter).unwrap_or(JsValue::UNDEFINED);
        self.host.navigate(page, filter);
    }
}

pub fn use_host() -> HostCtx {
    expect_context::<HostCtx>()
}

fn js_error_message(err: JsValue) -> String {
    err.dyn_ref::<js_sys::Error>()
        .map(|e| String::from(e.message()))
        .or_else(|| err.as_string())
        .unwrap_or_else(|| "Request failed".into())
}
