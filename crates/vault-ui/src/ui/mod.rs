//! Leptos versions of the @vault/ui primitives. Same class names and markup
//! as packages/ui/src/primitives, so the shared stylesheet draws both.

use leptos::prelude::*;

mod dialog;
mod form;
mod listen;
#[rustfmt::skip]
mod icons_gen;
pub use dialog::Dialog;
pub use form::{DateField, Field, Select, SelectOption};
pub use icons_gen::NAMES as ICON_NAMES;

/// `<Icon>`: inline SVG on a 24×24 grid, stroke scales at small sizes.
#[component]
pub fn Icon(
    name: &'static str,
    #[prop(default = 18)] size: u32,
    #[prop(optional)] style: Option<&'static str>,
) -> impl IntoView {
    let d = icons_gen::path(name).unwrap_or_default();
    let stroke = if size <= 16 { "1.9" } else { "1.75" };
    view! {
        <svg width=size height=size viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width=stroke stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false" style=style>
            <path d=d />
        </svg>
    }
}

/// `<Button>`. `on_click` is required; pages without one shouldn't be buttons.
#[component]
pub fn Button(
    #[prop(default = "secondary")] variant: &'static str,
    #[prop(default = "md")] size: &'static str,
    #[prop(optional)] icon: Option<&'static str>,
    #[prop(optional)] icon_end: Option<&'static str>,
    #[prop(optional)] block: bool,
    #[prop(optional, into)] style: Option<String>,
    #[prop(optional, into)] title: Option<String>,
    #[prop(optional, into)] disabled: Signal<bool>,
    /// `e.stopPropagation()` before `on_click` (a button inside a clickable card).
    #[prop(optional)]
    stop_propagation: bool,
    on_click: impl Fn() + 'static,
    #[prop(optional)] children: Option<Children>,
) -> impl IntoView {
    let icon_only = icon.is_some() && children.is_none();
    let icon_size = match size {
        "sm" => 15,
        "lg" => 19,
        _ => 17,
    };
    let mut class = format!("btn btn-{variant}");
    if size != "md" {
        class.push_str(&format!(" btn-{size}"));
    }
    if icon_only {
        class.push_str(" btn-icon");
    }
    if block {
        class.push_str(" btn-block");
    }
    view! {
        <button type="button" class=class style=style title=title disabled=move || disabled.get()
            on:click=move |e| {
                if stop_propagation {
                    e.stop_propagation();
                }
                on_click()
            }>
            {icon.map(|n| view! { <Icon name=n size=icon_size /> })}
            {children.map(|c| c())}
            {icon_end.map(|n| view! { <Icon name=n size=icon_size /> })}
        </button>
    }
}

/// `<MetricCard>` (static form; clickable cards come with the first page
/// that needs one).
#[component]
pub fn MetricCard(
    #[prop(into)] label: String,
    #[prop(into)] value: Signal<String>,
    #[prop(optional, into)] hint: Option<String>,
    #[prop(optional)] large: bool,
) -> impl IntoView {
    view! {
        <div class="panel stat">
            <div class="row" style="gap: var(--space-2)">
                <span class="stat-label">{label}</span>
            </div>
            <div class=if large { "stat-value stat-value-lg" } else { "stat-value" }>{value}</div>
            {hint.map(|h| view! { <div class="stat-hint">{h}</div> })}
        </div>
    }
}

/// `<Panel>`: the one card container.
#[component]
pub fn Panel(
    #[prop(optional, into)] title: Option<String>,
    #[prop(optional, into)] subtitle: Option<String>,
    #[prop(optional)] flush: bool,
    children: Children,
) -> impl IntoView {
    let has_head = title.is_some() || subtitle.is_some();
    view! {
        <div class=if flush { "panel panel-flush" } else { "panel" }>
            {has_head.then(|| view! {
                <div class=if flush { "panel-head panel-head-pad" } else { "panel-head" }>
                    <div style="min-width: 0">
                        {title.map(|t| view! { <div class="panel-title">{t}</div> })}
                        {subtitle.map(|s| view! { <div class="panel-sub">{s}</div> })}
                    </div>
                </div>
            })}
            {children()}
        </div>
    }
}

/// `<EmptyState>`.
#[component]
pub fn EmptyState(
    #[prop(default = "inbox")] icon: &'static str,
    #[prop(into)] title: String,
    #[prop(optional, into)] body: Option<String>,
    #[prop(optional)] compact: bool,
    /// Rendered after the text (usually a button).
    #[prop(optional)]
    children: Option<Children>,
) -> impl IntoView {
    view! {
        <div class=if compact { "empty empty-sm" } else { "empty" }>
            <div class="empty-icon"><Icon name=icon size=if compact { 20 } else { 24 } /></div>
            <div>
                <div class="empty-title">{title}</div>
                {body.map(|b| view! { <p class="empty-body" style="margin-top: var(--space-1)">{b}</p> })}
            </div>
            {children.map(|c| c())}
        </div>
    }
}

/// `<Spinner>`: three blinking dots.
#[component]
pub fn Spinner(#[prop(default = "Loading")] label: &'static str) -> impl IntoView {
    let dot = |i: u32| {
        let style = format!(
            "width: 6px; height: 6px; border-radius: 50%; background: var(--color-accent); animation: blink 1.2s {}s infinite",
            i as f32 * 0.2
        );
        view! { <span style=style></span> }
    };
    view! {
        <span role="status" aria-label=label style="display: inline-flex; gap: 4px; align-items: center">
            {dot(0)}{dot(1)}{dot(2)}
        </span>
    }
}

/// `<Tag>`.
#[component]
pub fn Tag(
    #[prop(default = "neutral")] variant: &'static str,
    #[prop(optional, into)] style: Option<String>,
    children: Children,
) -> impl IntoView {
    view! { <span class=format!("tag tag-{variant}") style=style>{children()}</span> }
}

/// `<ProgressBar>`: width and fill go through CSS custom properties.
#[component]
pub fn ProgressBar(
    /// 0–1, clamped.
    value: f64,
    #[prop(optional, into)] color: Option<String>,
    #[prop(optional)] over: bool,
    #[prop(optional)] small: bool,
    #[prop(optional, into)] label: Option<String>,
) -> impl IntoView {
    let pct = if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let fill = if over {
        "var(--color-negative)".to_string()
    } else {
        color.unwrap_or_else(|| "var(--color-accent)".into())
    };
    view! {
        <div class=if small { "bar bar-sm" } else { "bar" } role="progressbar"
            aria-valuenow=vault_core::money::js_round(pct * 100.0) aria-valuemin="0" aria-valuemax="100"
            aria-label=label style=format!("--bar-pct: {}%; --bar-fill: {fill}", pct * 100.0)>
            <i></i>
        </div>
    }
}

/// `<Banner>`: full-width status strip.
#[component]
pub fn Banner(tone: &'static str, children: Children) -> impl IntoView {
    let icon = match tone {
        "warning" | "danger" => "alert",
        "positive" => "check",
        _ => "info",
    };
    view! {
        <div role="status" class=format!("banner banner-{tone}")>
            <Icon name=icon size=17 style="flex: none" />
            <span style="flex: 1">{children()}</span>
        </div>
    }
}

/// `<Tabs>`: in-page tabs; arrow keys move between them (WAI-ARIA tabs).
#[component]
pub fn Tabs(
    items: &'static [(&'static str, &'static str)],
    value: RwSignal<&'static str>,
    #[prop(into)] aria_label: String,
) -> impl IntoView {
    let root = NodeRef::<leptos::html::Div>::new();
    let on_key = move |e: web_sys::KeyboardEvent| {
        let dir: isize = match e.key().as_str() {
            "ArrowRight" => 1,
            "ArrowLeft" => -1,
            _ => return,
        };
        e.prevent_default();
        let n = items.len() as isize;
        let i = items
            .iter()
            .position(|(v, _)| *v == value.get_untracked())
            .map_or(-1, |i| i as isize);
        let next = (i + dir + n).rem_euclid(n) as usize;
        value.set(items[next].0);
        // Move focus with selection so the keyboard user sees where they are.
        if let Some(tab) = root
            .get_untracked()
            .and_then(|r| r.query_selector_all(".tab").ok())
            .and_then(|l| l.item(next as u32))
        {
            use wasm_bindgen::JsCast;
            if let Ok(tab) = tab.dyn_into::<web_sys::HtmlElement>() {
                let _ = tab.focus();
            }
        }
    };
    view! {
        <div class="tabs" role="tablist" aria-label=aria_label node_ref=root on:keydown=on_key>
            {items.iter().map(|&(v, label)| {
                let active = move || value.get() == v;
                view! {
                    <button class="tab" role="tab" type="button"
                        aria-selected=move || if active() { "true" } else { "false" }
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
