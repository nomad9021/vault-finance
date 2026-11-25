//! `localStorage` for per-device preferences. Every access can throw (private
//! windows, blocked storage), so failures read as "nothing stored" and
//! writes are best-effort, like the React pages' try/catch.

fn store() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok().flatten()
}

pub fn get(key: &str) -> Option<String> {
    store()?.get_item(key).ok().flatten()
}

pub fn set(key: &str, value: &str) {
    if let Some(s) = store() {
        let _ = s.set_item(key, value);
    }
}

/// `new Set(JSON.parse(localStorage.getItem(key) ?? "[]"))` for a list of
/// strings; anything else reads as empty.
pub fn get_string_list(key: &str) -> Vec<String> {
    let Some(raw) = get(key) else {
        return Vec::new();
    };
    match js_sys::JSON::parse(&raw) {
        Ok(v) if js_sys::Array::is_array(&v) => js_sys::Array::from(&v)
            .iter()
            .filter_map(|x| x.as_string())
            .collect(),
        _ => Vec::new(),
    }
}

/// `localStorage.setItem(key, JSON.stringify(list))`.
pub fn set_string_list(key: &str, list: &[String]) {
    let arr: js_sys::Array = list
        .iter()
        .map(|s| wasm_bindgen::JsValue::from_str(s))
        .collect();
    if let Ok(json) = js_sys::JSON::stringify(&arr) {
        if let Some(json) = json.as_string() {
            set(key, &json);
        }
    }
}
