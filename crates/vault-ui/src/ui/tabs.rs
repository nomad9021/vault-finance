//! `<Tabs>`: in-page tabs, same markup as packages/ui/src/primitives/Tabs.tsx.
//! Arrow keys move between tabs (WAI-ARIA tabs pattern).

use leptos::{html, prelude::*};
use wasm_bindgen::JsCast;

/// `items` are `(value, label)` pairs. (Badges come with the first page that
/// needs one.)
#[component]
pub fn Tabs(
    items: &'static [(&'static str, &'static str)],
    value: RwSignal<&'static str>,
    #[prop(optional)] aria_label: Option<&'static str>,
) -> impl IntoView {
    let root = NodeRef::<html::Div>::new();
    let on_keydown = move |e: leptos::ev::KeyboardEvent| {
        let dir: isize = match e.key().as_str() {
            "ArrowRight" => 1,
            "ArrowLeft" => -1,
            _ => return,
        };
        e.prevent_default();
        let n = items.len() as isize;
        // findIndex is -1 when nothing matches; (-1 + dir + n) % n like JS.
        let i = items
            .iter()
            .position(|(v, _)| *v == value.get_untracked())
            .map_or(-1, |i| i as isize);
        let next = ((i + dir + n) % n) as usize;
        if let Some((v, _)) = items.get(next) {
            value.set(v);
            // Move focus with selection so the keyboard user sees where they are.
            let tab = root.get_untracked().and_then(|el| {
                el.query_selector_all(".tab")
                    .ok()
                    .and_then(|l| l.item(next as u32))
            });
            if let Some(t) = tab.and_then(|t| t.dyn_into::<web_sys::HtmlElement>().ok()) {
                let _ = t.focus();
            }
        }
    };
    view! {
        <div class="tabs" role="tablist" aria-label=aria_label node_ref=root on:keydown=on_keydown>
            {items.iter().map(|&(v, label)| {
                let active = move || value.get() == v;
                view! {
                    <button class="tab" role="tab" type="button"
                        aria-selected=move || active().to_string()
                        tabindex=move || if active() { "0" } else { "-1" }
                        data-active=move || active().then_some("true")
                        on:click=move |_| value.set(v)>
                        {label}
                    </button>
                }
            }).collect_view()}
        </div>
    }
}
