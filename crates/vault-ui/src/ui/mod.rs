//! Leptos versions of the @vault/ui primitives. Same class names and markup
//! as packages/ui/src/primitives, so the shared stylesheet draws both.

use leptos::prelude::*;

#[rustfmt::skip]
mod icons_gen;
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
    #[prop(optional, into)] disabled: MaybeProp<bool>,
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
        <button type="button" class=class style=style
            disabled=move || disabled.get().unwrap_or(false) on:click=move |_| on_click()>
            {icon.map(|n| view! { <Icon name=n size=icon_size /> })}
            {children.map(|c| c())}
            {icon_end.map(|n| view! { <Icon name=n size=icon_size /> })}
        </button>
    }
}

/// `<MetricCard>`: label, a dominant number, optional delta and hint. With
/// `on_click` the whole card is a button and shows a chevron.
#[component]
pub fn MetricCard(
    #[prop(into)] label: String,
    #[prop(into)] value: Signal<String>,
    /// Change line, coloured by `delta_tone`.
    #[prop(optional, into)]
    delta: Option<String>,
    /// "up" | "down" | "muted".
    #[prop(default = "muted")]
    delta_tone: &'static str,
    #[prop(optional, into)] hint: Option<String>,
    #[prop(optional)] large: bool,
    #[prop(optional)] icon: Option<&'static str>,
    #[prop(optional, into)] on_click: Option<Callback<()>>,
) -> impl IntoView {
    let interactive = on_click.is_some();
    let (delta_class, arrow) = match delta_tone {
        "up" => ("pos", Some("trendUp")),
        "down" => ("neg", Some("trendDown")),
        _ => ("", None),
    };
    let class = if interactive {
        "panel stat clickable"
    } else {
        "panel stat"
    };
    let click = move |_| {
        if let Some(f) = on_click {
            f.run(());
        }
    };
    let key = move |e: leptos::ev::KeyboardEvent| {
        if let Some(f) = on_click {
            if e.key() == "Enter" || e.key() == " " {
                e.prevent_default();
                f.run(());
            }
        }
    };
    view! {
        <div class=class role=interactive.then_some("button") tabindex=interactive.then_some("0")
            on:click=click on:keydown=key>
            <div class="row" style="gap: var(--space-2)">
                {icon.map(|n| view! {
                    <span class="tile" style="width: 26px; height: 26px; border-radius: var(--radius-sm)">
                        <Icon name=n size=15 />
                    </span>
                })}
                <span class="stat-label">{label}</span>
                {interactive.then(|| view! {
                    <Icon name="chevronRight" size=15 style="margin-left: auto; color: var(--content-tertiary)" />
                })}
            </div>
            <div class=if large { "stat-value stat-value-lg" } else { "stat-value" }>{value}</div>
            {delta.filter(|d| !d.is_empty()).map(|d| view! {
                <div class=format!("stat-delta {delta_class}")>
                    {arrow.map(|a| view! { <Icon name=a size=13 /> })}
                    {d}
                </div>
            })}
            {hint.map(|h| view! { <div class="stat-hint">{h}</div> })}
        </div>
    }
}

/// `<Panel>`: the one card container. `subtitle` may change after mount.
#[component]
pub fn Panel(
    #[prop(optional, into)] title: Option<String>,
    #[prop(optional, into)] subtitle: Option<Signal<String>>,
    #[prop(optional)] flush: bool,
    /// Right-aligned header content (buttons, a [`PanelLink`]).
    #[prop(default = None)]
    actions: Option<AnyView>,
    children: Children,
) -> impl IntoView {
    let has_head = title.is_some() || subtitle.is_some() || actions.is_some();
    view! {
        <div class=if flush { "panel panel-flush" } else { "panel" }>
            {has_head.then(|| view! {
                <div class=if flush { "panel-head panel-head-pad" } else { "panel-head" }>
                    <div style="min-width: 0">
                        {title.map(|t| view! { <div class="panel-title">{t}</div> })}
                        {subtitle.map(|s| view! { <div class="panel-sub">{s}</div> })}
                    </div>
                    {actions.map(|a| view! { <div class="panel-actions">{a}</div> })}
                </div>
            })}
            {children()}
        </div>
    }
}

/// `<Segmented>`: the `.seg` control on native radio inputs.
#[component]
pub fn Segmented(
    options: &'static [(&'static str, &'static str)],
    value: RwSignal<&'static str>,
    #[prop(optional)] aria_label: Option<&'static str>,
) -> impl IntoView {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    // Stands in for React's useId: one radio group name per control.
    let name = format!("seg-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    view! {
        <div class="seg" role="radiogroup" aria-label=aria_label>
            {options.iter().map(|&(v, label)| view! {
                <label class="seg-opt">
                    <input type="radio" name=name.clone()
                        prop:checked=move || value.get() == v
                        on:change=move |_| value.set(v) />
                    {label}
                </label>
            }).collect_view()}
        </div>
    }
}

/// `TrendChart` (apps/desktop/src/screens/shell/TrendChart.tsx): history line
/// with a soft area, dashed projection and a dot on the last real point.
/// The SVG stays mounted while the data changes, like React's, so the reveal
/// animation only plays when the chart first appears.
#[component]
pub fn TrendChart(
    #[prop(into)] history: Signal<Vec<i64>>,
    #[prop(into)] projected: Signal<Vec<i64>>,
    #[prop(into)] color: Signal<String>,
    #[prop(default = 66)] height: u32,
    #[prop(default = true)] show_area: bool,
    #[prop(default = "Not enough history")] empty_label: &'static str,
) -> impl IntoView {
    use vault_core::trend_chart::{paths, WIDTH};
    let geo = Memo::new(move |_| paths(&history.get(), &projected.get(), height as f64));
    let has_chart = Memo::new(move |_| geo.with(|g| g.is_some()));
    let part = move |f: fn(&vault_core::trend_chart::TrendPaths) -> String| {
        move || geo.with(|g| g.as_ref().map(f).unwrap_or_default())
    };
    move || {
        if has_chart.get() {
            view! {
                <svg class="chart-reveal" viewBox=format!("0 0 {WIDTH} {height}")
                    style="width: 100%; height: auto; display: block"
                    preserveAspectRatio="none" aria-hidden="true">
                    {show_area.then(|| view! {
                        <path d=part(|g| g.area.clone())
                            fill=move || format!("color-mix(in srgb, {} 13%, transparent)", color.get()) />
                    })}
                    <path d=part(|g| g.hist.clone()) fill="none" stroke=color stroke-width="2"
                        stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
                    {move || (!projected.with(|p| p.is_empty())).then(|| view! {
                        <path d=part(|g| g.proj.clone()) fill="none" stroke=color stroke-width="2"
                            stroke-dasharray="5 4" opacity="0.55" stroke-linecap="round"
                            vector-effect="non-scaling-stroke" />
                    })}
                    <circle cx=move || geo.with(|g| g.as_ref().map(|g| g.dot.0).unwrap_or_default())
                        cy=move || geo.with(|g| g.as_ref().map(|g| g.dot.1).unwrap_or_default())
                        r="3" fill=color />
                </svg>
            }
            .into_any()
        } else {
            view! {
                <div style=format!("height: {height}px; display: flex; align-items: center; justify-content: center; color: var(--content-tertiary); font-size: var(--text-xs)")>
                    {empty_label}
                </div>
            }
            .into_any()
        }
    }
}

/// `<PanelLink>`: the "See all →" link in a panel header.
#[component]
pub fn PanelLink(
    on_click: impl Fn() + 'static,
    #[prop(optional)] children: Option<Children>,
) -> impl IntoView {
    view! {
        <button type="button" class="panel-link" on:click=move |_| on_click()>
            {match children {
                Some(c) => c().into_any(),
                None => "See all".into_any(),
            }}
            <Icon name="arrowRight" size=14 />
        </button>
    }
}

/// `<Tag>`: a small pill. `variant` is accent, accent-2, neutral, positive,
/// negative, warning or outline.
#[component]
pub fn Tag(
    #[prop(default = "neutral")] variant: &'static str,
    children: Children,
) -> impl IntoView {
    view! { <span class=format!("tag tag-{variant}")>{children()}</span> }
}

/// `<EmptyState>`.
#[component]
pub fn EmptyState(
    #[prop(default = "inbox")] icon: &'static str,
    #[prop(into)] title: String,
    #[prop(optional, into)] body: Option<String>,
    #[prop(optional)] compact: bool,
    #[prop(optional)] action: Option<AnyView>,
) -> impl IntoView {
    view! {
        <div class=if compact { "empty empty-sm" } else { "empty" }>
            <div class="empty-icon"><Icon name=icon size=if compact { 20 } else { 24 } /></div>
            <div>
                <div class="empty-title">{title}</div>
                {body.map(|b| view! { <p class="empty-body" style="margin-top: var(--space-1)">{b}</p> })}
            </div>
            {action}
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
