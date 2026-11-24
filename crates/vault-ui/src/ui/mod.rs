//! Leptos versions of the @vault/ui primitives. Same class names and markup
//! as packages/ui/src/primitives, so the shared stylesheet draws both.

use leptos::prelude::*;

mod dialog;
mod tabs;
pub use dialog::{Confetti, Dialog};
pub use tabs::Tabs;

#[rustfmt::skip]
mod icons_gen;
pub use icons_gen::NAMES as ICON_NAMES;

/// `<Icon>`: inline SVG on a 24×24 grid, stroke scales at small sizes.
#[component]
pub fn Icon(name: &'static str, #[prop(default = 18)] size: u32) -> impl IntoView {
    let d = icons_gen::path(name).unwrap_or_default();
    let stroke = if size <= 16 { "1.9" } else { "1.75" };
    view! {
        <svg width=size height=size viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width=stroke stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false">
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
    #[prop(optional, into)] disabled: Signal<bool>,
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
        <button type="button" class=class style=style disabled=move || disabled.get()
            on:click=move |_| on_click()>
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
    /// Small uppercase eyebrow above the title.
    #[prop(optional, into)]
    kicker: Option<String>,
    #[prop(optional, into)] title: Option<String>,
    #[prop(optional, into)] subtitle: Option<String>,
    /// Right-aligned header content.
    #[prop(optional, into)]
    actions: Option<ViewFn>,
    #[prop(optional)] flush: bool,
    children: Children,
) -> impl IntoView {
    let has_head = kicker.is_some() || title.is_some() || subtitle.is_some() || actions.is_some();
    view! {
        <div class=if flush { "panel panel-flush" } else { "panel" }>
            {has_head.then(|| view! {
                <div class=if flush { "panel-head panel-head-pad" } else { "panel-head" }>
                    <div style="min-width: 0">
                        {kicker.map(|k| view! { <div class="eyebrow">{k}</div> })}
                        {title.map(|t| view! { <div class="panel-title">{t}</div> })}
                        {subtitle.map(|s| view! { <div class="panel-sub">{s}</div> })}
                    </div>
                    {actions.map(|a| view! { <div class="panel-actions">{a.run()}</div> })}
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
) -> impl IntoView {
    view! {
        <div class=if compact { "empty empty-sm" } else { "empty" }>
            <div class="empty-icon"><Icon name=icon size=if compact { 20 } else { 24 } /></div>
            <div>
                <div class="empty-title">{title}</div>
                {body.map(|b| view! { <p class="empty-body" style="margin-top: var(--space-1)">{b}</p> })}
            </div>
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
