//! The bridge to the React shell.

use std::rc::Rc;

use leptos::prelude::*;
use send_wrapper::SendWrapper;
use serde::{de::DeserializeOwned, Serialize};
use vault_core::nav::NavFilter;
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

    /// The `NavFilter` the page was opened with (`{}` when none).
    #[wasm_bindgen(method)]
    fn filter(this: &Host) -> JsValue;

    /// Run `cb` whenever the assistant changes data; returns an unsubscribe
    /// function.
    /// Tell every page the data changed (`useChat.refreshData()`), as React
    /// pages do after an edit that other pages draw.
    #[wasm_bindgen(method, js_name = refreshData)]
    fn refresh_data(this: &Host);

    #[wasm_bindgen(method, js_name = onDataChange)]
    fn on_data_change(this: &Host, cb: &js_sys::Function) -> js_sys::Function;
}

/// What pages get from context: the host plus a counter that ticks when the
/// assistant changes data, so resources that read it refetch.
#[derive(Clone)]
pub struct HostCtx {
    host: SendWrapper<Rc<Host>>,
    pub data_version: RwSignal<u32>,
    /// What the page was opened with (in-page tab, account…).
    pub filter: NavFilter,
}

impl HostCtx {
    pub fn new(host: Host) -> Self {
        let filter = serde_wasm_bindgen::from_value(host.filter()).unwrap_or_default();
        Self {
            host: SendWrapper::new(Rc::new(host)),
            data_version: RwSignal::new(0),
            filter,
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
        self.try_call(method, args).await.map_err(|e| e.message)
    }

    /// `call`, keeping what kind of error the ApiClient threw, for pages
    /// whose message depends on it (`err instanceof ApiRequestError`).
    pub async fn try_call<T: DeserializeOwned>(
        &self,
        method: &str,
        args: &[JsValue],
    ) -> Result<T, CallError> {
        let array: js_sys::Array = args.iter().collect();
        let value = self
            .host
            .call(method, array)
            .await
            .map_err(CallError::from_js)?;
        serde_wasm_bindgen::from_value(value).map_err(|e| CallError {
            name: "Error".into(),
            message: format!("{method}: unexpected response ({e})"),
            is_error: true,
        })
    }

    /// A request body for `call`: `None` goes over as `null` (not
    /// `undefined`, which JSON drops, so a PATCH couldn't clear a field) and
    /// maps as plain objects.
    pub fn arg(value: &impl Serialize) -> JsValue {
        value
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .unwrap_or(JsValue::UNDEFINED)
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

    /// `useChat.getState().refreshData()`: other pages (and this one, through
    /// `data_version`) refetch.
    pub fn refresh_data(&self) {
        self.host.refresh_data();
    }

    pub fn navigate(&self, page: &str, filter: &impl Serialize) {
        let filter = serde_wasm_bindgen::to_value(filter).unwrap_or(JsValue::UNDEFINED);
        self.host.navigate(page, filter);
    }
}

pub fn use_host() -> HostCtx {
    expect_context::<HostCtx>()
}

/// A rejected `call`.
#[derive(Debug, Clone, PartialEq)]
pub struct CallError {
    /// The JS error's `name` ("ApiRequestError", "ApiConnectionError", …).
    pub name: String,
    pub message: String,
    /// Whether it was an `Error` at all (`err instanceof Error`).
    pub is_error: bool,
}

impl CallError {
    fn from_js(err: JsValue) -> Self {
        match err.dyn_ref::<js_sys::Error>() {
            Some(e) => CallError {
                name: e.name().into(),
                message: e.message().into(),
                is_error: true,
            },
            None => CallError {
                name: String::new(),
                message: err.as_string().unwrap_or_else(|| "Request failed".into()),
                is_error: false,
            },
        }
    }

    /// `err instanceof ApiRequestError`: the server said no, with a reason
    /// worth showing.
    pub fn is_api_request(&self) -> bool {
        self.name == "ApiRequestError"
    }

    /// `err instanceof Error ? err.message : fallback`.
    pub fn message_or(&self, fallback: &str) -> String {
        if self.is_error {
            self.message.clone()
        } else {
            fallback.to_string()
        }
    }
}
