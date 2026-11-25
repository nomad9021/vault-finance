//! `<PieChart>` from packages/ui/src/charts/PieChart.tsx: a donut with a
//! legend, for spending-by-category breakdowns.

use std::f64::consts::PI;

use leptos::prelude::*;
use vault_core::money::js_round;

const SIZE: f64 = 220.0;
const R: f64 = 100.0;
const INNER: f64 = 60.0;
const CX: f64 = SIZE / 2.0;
const CY: f64 = SIZE / 2.0;

#[derive(Debug, Clone, PartialEq)]
pub struct PieSlice {
    pub label: String,
    pub value: i64,
    pub color: String,
}

fn arc(start: f64, end: f64) -> String {
    // Full-circle guard: SVG arcs can't draw a 360° sweep in one path.
    let sweep = end - start;
    if sweep >= PI * 2.0 - 1e-6 {
        return [
            format!("M {CX} {}", CY - R),
            format!("A {R} {R} 0 1 1 {} {}", CX - 0.01, CY - R),
            format!("L {} {}", CX - 0.01, CY - INNER),
            format!("A {INNER} {INNER} 0 1 0 {CX} {}", CY - INNER),
            "Z".into(),
        ]
        .join(" ");
    }
    let p = |a: f64, r: f64| (CX + r * a.sin(), CY - r * a.cos());
    let large = if sweep > PI { 1 } else { 0 };
    let (x1, y1) = p(start, R);
    let (x2, y2) = p(end, R);
    let (x3, y3) = p(end, INNER);
    let (x4, y4) = p(start, INNER);
    format!(
        "M {x1} {y1} A {R} {R} 0 {large} 1 {x2} {y2} L {x3} {y3} A {INNER} {INNER} 0 {large} 0 {x4} {y4} Z"
    )
}

#[component]
pub fn PieChart(
    data: Vec<PieSlice>,
    /// Formats slice values and the center total.
    format: fn(i64) -> String,
    /// Center caption under the total, e.g. "spent".
    #[prop(optional)]
    center_label: Option<&'static str>,
    #[prop(default = "Breakdown".into(), into)] aria_label: String,
) -> impl IntoView {
    let slices: Vec<PieSlice> = data.into_iter().filter(|d| d.value > 0).collect();
    let total: i64 = slices.iter().map(|d| d.value).sum();
    let paths = if total == 0 {
        view! {
            <circle cx=CX cy=CY r=(R + INNER) / 2.0 fill="none" stroke="var(--color-divider)" stroke-width=R - INNER />
        }
        .into_any()
    } else {
        let mut angle = 0.0;
        slices
            .iter()
            .map(|d| {
                let start = angle;
                angle += d.value as f64 / total as f64 * PI * 2.0;
                view! { <path d=arc(start, angle) fill=d.color.clone() /> }
            })
            .collect_view()
            .into_any()
    };
    let empty = slices.is_empty();
    view! {
        <div style="display: flex; gap: 20px; align-items: center; flex-wrap: wrap">
            <svg class="pie-in" viewBox=format!("0 0 {SIZE} {SIZE}")
                style=format!("width: {SIZE}px; max-width: 100%; height: auto; flex: 0 0 auto")
                role="img" aria-label=aria_label>
                {paths}
                <text x=CX y=CY - 4.0 text-anchor="middle"
                    style="font-family: var(--font-heading); font-weight: 700; font-size: 20px; fill: var(--color-text)">
                    {format(total)}
                </text>
                {center_label.map(|l| view! {
                    <text x=CX y=CY + 16.0 text-anchor="middle"
                        style="font-family: var(--font-body); font-size: 11.5px; fill: var(--color-neutral-500)">
                        {l}
                    </text>
                })}
            </svg>
            <div style="display: flex; flex-direction: column; gap: 6px; min-width: 160px; flex: 1">
                {slices.into_iter().map(|d| {
                    let pct = if total > 0 { js_round(d.value as f64 / total as f64 * 100.0) } else { 0 };
                    view! {
                        <div style="display: flex; align-items: center; gap: 8px; font-size: 13px">
                            <span style=format!("width: 10px; height: 10px; border-radius: 3px; background: {}; flex: 0 0 auto", d.color)></span>
                            <span style="flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{d.label}</span>
                            <span style="color: var(--color-neutral-400)">{pct}"%"</span>
                            <span style="font-weight: 600; min-width: 64px; text-align: right">{format(d.value)}</span>
                        </div>
                    }
                }).collect_view()}
                {empty.then(|| view! {
                    <span style="font-size: 13px; color: var(--color-neutral-500)">"No spending yet."</span>
                })}
            </div>
        </div>
    }
}
