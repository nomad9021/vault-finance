//! `<ListRow>`, `<Money>`, `<Skeleton>`, `<Sheet>` from
//! packages/ui/src/primitives, and a `<Segmented>` whose options change.

use leptos::portal::Portal;
use leptos::prelude::*;
use wasm_bindgen::JsCast;

use super::listen::on_window;
use super::Icon;
use crate::fmt;

/// `<ListRow>`: the atom of every list. With `on_click` it's a button.
#[component]
pub fn ListRow(
    #[prop(optional)] leading: Option<AnyView>,
    #[prop(into)] title: String,
    #[prop(optional)] subtitle: Option<AnyView>,
    #[prop(optional)] trailing: Option<AnyView>,
    #[prop(optional)] trailing_sub: Option<AnyView>,
    #[prop(optional, into)] on_click: Option<Callback<()>>,
    /// Defaults to whether it's clickable.
    #[prop(optional)]
    chevron: Option<bool>,
) -> impl IntoView {
    let show_chevron = chevron.unwrap_or(on_click.is_some());
    let has_trailing = trailing.is_some() || trailing_sub.is_some();
    let inner = view! {
        {leading}
        <div class="list-row-main">
            <div class="list-row-title">{title}</div>
            {subtitle.map(|s| view! { <div class="list-row-sub">{s}</div> })}
        </div>
        {has_trailing.then(|| view! {
            <div style="text-align: right; flex: none">
                {trailing.map(|t| view! { <div class="list-row-amount">{t}</div> })}
                {trailing_sub.map(|t| view! { <div class="list-row-sub">{t}</div> })}
            </div>
        })}
        {show_chevron.then(|| view! {
            <Icon name="chevronRight" size=16 style="color: var(--content-tertiary); flex: none" />
        })}
    };
    match on_click {
        Some(f) => view! {
            <button type="button" class="list-row" on:click=move |_| f.run(())>{inner}</button>
        }
        .into_any(),
        None => view! { <div class="list-row">{inner}</div> }.into_any(),
    }
}

/// `<Money>`: a cent value as tabular text. `tone`: "none" | "auto" | "always".
#[component]
pub fn Money(
    cents: i64,
    #[prop(optional)] whole: bool,
    #[prop(optional)] signed: bool,
    #[prop(default = "none")] tone: &'static str,
) -> impl IntoView {
    let text = if whole {
        fmt::cents_whole(cents)
    } else if signed {
        fmt::cents_signed(cents)
    } else {
        fmt::cents(cents)
    };
    let tone_class = match tone {
        "none" => "",
        _ if cents > 0 => " pos",
        "always" if cents < 0 => " neg",
        _ => "",
    };
    view! { <span class=format!("money{tone_class}")>{text}</span> }
}

/// `<Skeleton>`: a shimmering block, `height` px tall.
#[component]
pub fn Skeleton(height: u32) -> impl IntoView {
    view! { <div class="skeleton" style=format!("height: {height}px; width: 100%")></div> }
}

/// `<Sheet>`: the bottom sheet, on `<body>`. Render it while open.
#[component]
pub fn Sheet(
    #[prop(into)] title: String,
    #[prop(into)] on_close: Callback<()>,
    children: ChildrenFn,
) -> impl IntoView {
    on_window("keydown", false, move |e| {
        if e.dyn_ref::<web_sys::KeyboardEvent>()
            .is_some_and(|k| k.key() == "Escape")
        {
            on_close.run(());
        }
    });
    // Stop the page behind from scrolling under the sheet.
    if let Some(body) = document().body() {
        let style = body.style();
        let prev = style.get_property_value("overflow").unwrap_or_default();
        let _ = style.set_property("overflow", "hidden");
        let prev = send_wrapper::SendWrapper::new(prev);
        on_cleanup(move || {
            if let Some(body) = document().body() {
                let _ = body.style().set_property("overflow", &prev);
            }
        });
    }
    let label = title.clone();
    let has_title = !title.is_empty();
    view! {
        <Portal>
            <div class="scrim" on:click=move |_| on_close.run(())></div>
            <div class="sheet" role="dialog" aria-modal="true" aria-label=label.clone()>
                <div class="sheet-grip" aria-hidden="true"></div>
                {has_title.then(|| view! {
                    <div class="panel-title" style="margin-bottom: var(--space-3)">{title.clone()}</div>
                })}
                {children()}
            </div>
        </Portal>
    }
}

/// `<Segmented>` with options and value that change (people, available views).
#[component]
pub fn SegmentedOf(
    #[prop(into)] options: Signal<Vec<(String, String)>>,
    #[prop(into)] value: Signal<String>,
    #[prop(into)] on_change: Callback<String>,
    #[prop(optional)] aria_label: Option<&'static str>,
) -> impl IntoView {
    let name = super::listen::use_id();
    view! {
        <div class="seg" role="radiogroup" aria-label=aria_label>
            <For each=move || options.get() key=|o| o.clone() children=move |(v, label)| {
                let name = name.clone();
                let mine = v.clone();
                view! {
                    <label class="seg-opt">
                        <input type="radio" name=name
                            prop:checked=move || value.get() == mine
                            on:change=move |_| on_change.run(v.clone()) />
                        {label}
                    </label>
                }
            } />
        </div>
    }
}
