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

    /// Run `cb` when `app()` changes; returns an unsubscribe function.
    #[wasm_bindgen(method, js_name = onAppStateChange)]
    fn on_app_state_change(this: &Host, cb: &js_sys::Function) -> js_sys::Function;

    /// lib/spreadsheet.ts `readSpreadsheet(file)`: `{ name, content }`.
    #[wasm_bindgen(method, catch, js_name = readSpreadsheet)]
    async fn read_spreadsheet(this: &Host, file: &web_sys::File) -> Result<JsValue, JsValue>;

    /// A new assistant chat with an attachment, opened and sent.
    #[wasm_bindgen(method, js_name = askAssistant)]
    fn ask_assistant(this: &Host, message: &str, attachment: JsValue);

    /// A snapshot of app-store settings pages read (`reviewPrefs`,
    /// `aiVisible`, `platform`: "tauri" | "browser").
    #[wasm_bindgen(method)]
    fn app(this: &Host) -> JsValue;

    /// `platform.setFullscreen(on)`.
    #[wasm_bindgen(method, catch, js_name = setFullscreen)]
    async fn set_fullscreen(this: &Host, on: bool) -> Result<JsValue, JsValue>;

    /// `useKeepUnlocked()`: auto-lock waits until the returned function runs.
    #[wasm_bindgen(method, js_name = keepUnlocked)]
    fn keep_unlocked(this: &Host) -> js_sys::Function;
}

/// `host.app()`, read when a page needs it.
#[derive(Debug, Clone, PartialEq, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub review_prefs: vault_core::reports::ReviewPrefs,
    pub ai_visible: bool,
    pub platform: String,
}

/// A spreadsheet read for the assistant (`ChatAttachment`).
#[derive(Debug, Clone, PartialEq, serde::Deserialize, Serialize)]
pub struct Sheet {
    pub name: String,
    pub content: String,
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

    pub fn app(&self) -> AppState {
        serde_wasm_bindgen::from_value(self.host.app()).unwrap_or_default()
    }

    /// `platform.setFullscreen(on)`; the error's message on failure.
    pub async fn set_fullscreen(&self, on: bool) -> Result<(), String> {
        self.host
            .set_fullscreen(on)
            .await
            .map(|_| ())
            .map_err(|e| CallError::from_js(e).message)
    }

    /// `useKeepUnlocked()` for the current owner's lifetime.
    pub fn keep_unlocked(&self) {
        let release = SendWrapper::new(self.host.keep_unlocked());
        on_cleanup(move || {
            let _ = release.take().call0(&JsValue::NULL);
        });
    }

    /// `app()`, kept current while the page is mounted (React's
    /// `useApp((s) => …)`).
    pub fn app_state(&self) -> ReadSignal<AppState> {
        let read = |h: &Host| serde_wasm_bindgen::from_value(h.app()).unwrap_or_default();
        let (state, set_state) = signal(read(&self.host));
        let host = Rc::clone(&self.host);
        let cb = Closure::<dyn Fn()>::new(move || set_state.set(read(&host)));
        let unsubscribe =
            SendWrapper::new(self.host.on_app_state_change(cb.as_ref().unchecked_ref()));
        let cb = SendWrapper::new(cb);
        on_cleanup(move || {
            let _ = unsubscribe.call0(&JsValue::NULL);
            drop(cb);
        });
        state
    }

    /// Read a picked spreadsheet in JS (lib/spreadsheet.ts). The error is the
    /// message to show: the reader's own, or the generic one.
    pub async fn read_spreadsheet(&self, file: &web_sys::File) -> Result<Sheet, String> {
        const FALLBACK: &str = "Couldn't read that file. Save it as CSV and try again.";
        match self.host.read_spreadsheet(file).await {
            Ok(v) => serde_wasm_bindgen::from_value(v).map_err(|_| FALLBACK.to_string()),
            Err(e) => {
                let e = CallError::from_js(e);
                Err(if e.name == "SpreadsheetError" {
                    e.message
                } else {
                    FALLBACK.to_string()
                })
            }
        }
    }

    /// Start a new assistant chat with `sheet` attached, open it and send
    /// `message` (useChat newChat → attach → navigate → send).
    pub fn ask_assistant(&self, message: &str, sheet: &Sheet) {
        self.host.ask_assistant(message, Self::arg(sheet));
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
