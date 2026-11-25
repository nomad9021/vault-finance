//! Ported pages. Add the id here and in `render`, then to RUST_PAGES in
//! apps/desktop/src/rust/RustPage.tsx.

use leptos::prelude::*;

pub mod insights;
pub mod networth;
pub mod subscriptions;

pub const IDS: &[&str] = &["insights", "networth", "subscriptions"];

pub fn render(page: &str) -> AnyView {
    match page {
        "insights" => view! { <insights::InsightsPage /> }.into_any(),
        "networth" => view! { <networth::NetWorthPage /> }.into_any(),
        "subscriptions" => view! { <subscriptions::SubscriptionsPage /> }.into_any(),
        _ => ().into_any(),
    }
}
