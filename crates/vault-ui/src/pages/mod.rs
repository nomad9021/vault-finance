//! Ported pages. Add the id here and in `render`, then to RUST_PAGES in
//! apps/desktop/src/rust/RustPage.tsx.

use leptos::prelude::*;

pub mod accounts;
pub mod bills;
pub mod budgets;
pub mod cashflow;
pub mod debt_calculator;
pub mod goals;
pub mod income;
pub mod insights;
pub mod investments;
pub mod networth;
pub mod taxes;

pub const IDS: &[&str] = &[
    "insights",
    "networth",
    "goals",
    "cashflow",
    "bills",
    "income",
    "investments",
    "accounts",
    "budgets",
    "taxes",
];

pub fn render(page: &str) -> AnyView {
    match page {
        "insights" => view! { <insights::InsightsPage /> }.into_any(),
        "networth" => view! { <networth::NetWorthPage /> }.into_any(),
        "goals" => view! { <goals::GoalsPage /> }.into_any(),
        "cashflow" => view! { <cashflow::CashFlowPage /> }.into_any(),
        "bills" => view! { <bills::BillsPage /> }.into_any(),
        "income" => view! { <income::IncomePage /> }.into_any(),
        "investments" => view! { <investments::InvestmentsPage /> }.into_any(),
        "accounts" => view! { <accounts::AccountsPage /> }.into_any(),
        "budgets" => view! { <budgets::BudgetsPage /> }.into_any(),
        "taxes" => view! { <taxes::TaxesPage /> }.into_any(),
        _ => ().into_any(),
    }
}
