//! Ported pages. Add the id here and in `render`, then to RUST_PAGES in
//! apps/desktop/src/rust/RustPage.tsx.

use leptos::prelude::*;

pub mod cashflow;
pub mod debt_calculator;
pub mod insights;
pub mod networth;

pub const IDS: &[&str] = &["insights", "networth", "cashflow"];

pub fn render(page: &str) -> AnyView {
    match page {
        "insights" => view! { <insights::InsightsPage /> }.into_any(),
        "networth" => view! { <networth::NetWorthPage /> }.into_any(),
        "cashflow" => view! { <cashflow::CashFlowPage /> }.into_any(),
        _ => ().into_any(),
    }
}
