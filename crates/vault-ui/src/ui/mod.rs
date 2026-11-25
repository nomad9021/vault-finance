//! Leptos versions of the @vault/ui primitives. Same class names and markup
//! as packages/ui/src/primitives, so the shared stylesheet draws both.

use leptos::prelude::*;

mod confetti;
mod dialog;
mod drag_sort;
mod form;
mod listen;
mod pie_chart;
mod pre_income_dialog;
mod sankey;
mod sankey_arranger;
mod sankey_card;
mod sankey_order;
#[rustfmt::skip]
mod icons_gen;
pub use confetti::Confetti;
pub use dialog::Dialog;
pub use form::{DateField, Field, Select, SelectOption};
pub use icons_gen::NAMES as ICON_NAMES;
pub use listen::{on_document, on_window, use_narrow};
pub use pie_chart::{PieChart, PieSlice};
pub use pre_income_dialog::PreIncomeDialog;
pub use sankey::Sankey;
pub use sankey_arranger::SankeyArranger;
pub use sankey_card::SankeyCard;
pub use sankey_order::use_sankey_order;

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
    #[prop(optional, into)] aria_label: MaybeProp<String>,
    #[prop(optional, into)] disabled: MaybeProp<bool>,
    /// `e.stopPropagation()` before `on_click` (a button inside a clickable card).
    #[prop(optional)]
    stop_propagation: bool,
    /// `type="submit"`: submits its form (`on_click` still runs first).
    #[prop(optional)]
    submit: bool,
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
        <button type=if submit { "submit" } else { "button" } class=class style=style title=title aria-label=move || aria_label.get() disabled=move || disabled.get().unwrap_or(false)
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

/// `<Avatar>`: the initial on a colour disc, or the profile picture.
#[component]
pub fn Avatar(
    #[prop(into)] name: String,
    #[prop(into)] color: String,
    #[prop(optional, into)] image: Option<String>,
    #[prop(default = 40)] size: u32,
) -> impl IntoView {
    let font = vault_core::money::js_round(size as f64 * 0.4);
    let mut style =
        format!("width: {size}px; height: {size}px; background: {color}; font-size: {font}px");
    let inner = match image.filter(|s| !s.is_empty()) {
        Some(src) => {
            style.push_str("; overflow: hidden; padding: 0px");
            view! {
                <img src=src alt="" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block" />
            }
            .into_any()
        }
        None => name
            .trim()
            .chars()
            .next()
            .map(|c| c.to_uppercase().collect::<String>())
            .unwrap_or_else(|| "?".into())
            .into_any(),
    };
    view! { <span class="avatar" style=style aria-hidden="true">{inner}</span> }
}

/// `<Card>`: the older card container, with an optional kicker and title.
#[component]
pub fn Card(
    #[prop(default = "sm")] elevation: &'static str,
    #[prop(optional, into)] kicker: Option<String>,
    /// May change after mount (an earner's card follows their name).
    #[prop(optional, into)]
    title: Option<Signal<String>>,
    #[prop(optional, into)] style: Option<String>,
    children: Children,
) -> impl IntoView {
    view! {
        <div class=format!("card elev-{elevation}") style=style>
            {kicker.filter(|k| !k.is_empty()).map(|k| view! { <div class="card-kicker">{k}</div> })}
            {move || title.map(|t| t.get()).filter(|t| !t.is_empty()).map(|t| view! { <div class="card-title">{t}</div> })}
            {children()}
        </div>
    }
}

/// `<Panel>`: the one card container. `subtitle` may change after mount.
#[component]
pub fn Panel(
    /// Small uppercase eyebrow above the title.
    #[prop(optional, into)]
    kicker: Option<String>,
    #[prop(optional, into)] title: Option<String>,
    /// A title that isn't plain text (React's `title={<button>…}`); used
    /// instead of `title`.
    #[prop(optional)]
    title_view: Option<AnyView>,
    #[prop(optional, into)] subtitle: Option<Signal<String>>,
    #[prop(optional)] flush: bool,
    /// Right-aligned header content (buttons, a [`PanelLink`]).
    #[prop(optional)]
    actions: Option<AnyView>,
    children: Children,
) -> impl IntoView {
    let has_head = kicker.is_some()
        || title.is_some()
        || title_view.is_some()
        || subtitle.is_some()
        || actions.is_some();
    let title = match title_view {
        Some(v) => Some(v),
        None => title.map(IntoAny::into_any),
    };
    view! {
        <div class=if flush { "panel panel-flush" } else { "panel" }>
            {has_head.then(|| view! {
                <div class=if flush { "panel-head panel-head-pad" } else { "panel-head" }>
                    <div style="min-width: 0">
                        {kicker.map(|k| view! { <div class="eyebrow">{k}</div> })}
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

/// `<EmptyState>`.
#[component]
pub fn EmptyState(
    #[prop(default = "inbox")] icon: &'static str,
    #[prop(into)] title: String,
    #[prop(optional, into)] body: Option<String>,
    #[prop(optional)] compact: bool,
    /// Rendered after the text (usually a button).
    #[prop(optional)]
    action: Option<AnyView>,
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

/// `<SkeletonList>`: shimmering rows standing in for a list while it loads.
#[component]
pub fn SkeletonList(
    #[prop(default = 4)] rows: u32,
    #[prop(default = 44)] height: u32,
) -> impl IntoView {
    view! {
        <div class="stack-sm">
            {(0..rows).map(|_| view! {
                <div class="skeleton" style=format!("height: {height}px; width: 100%")></div>
            }).collect_view()}
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
pub fn Banner(
    tone: &'static str,
    /// Action button(s) on the right.
    #[prop(optional)]
    action: Option<Children>,
    children: Children,
) -> impl IntoView {
    let icon = match tone {
        "warning" | "danger" => "alert",
        "positive" => "check",
        _ => "info",
    };
    view! {
        <div role="status" class=format!("banner banner-{tone}")>
            <Icon name=icon size=17 style="flex: none" />
            <span style="flex: 1">{children()}</span>
            {action.map(|a| a())}
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
