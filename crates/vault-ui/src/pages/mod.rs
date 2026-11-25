//! Ported pages. Add the id here and in `render`, then to RUST_PAGES in
//! apps/desktop/src/rust/RustPage.tsx.

use leptos::prelude::*;

pub mod accounts;
pub mod bills;
pub mod budgets;
pub mod cashflow;
pub mod debt_calculator;
pub mod giving;
pub mod goals;
pub mod income;
pub mod insights;
pub mod investments;
pub mod networth;
pub mod reports;
pub mod review_presenter;
pub mod subscriptions;
pub mod taxes;
pub mod transactions;

pub const IDS: &[&str] = &[
    "insights",
    "networth",
    "subscriptions",
    "goals",
    "cashflow",
    "bills",
    "income",
    "investments",
    "accounts",
    "budgets",
    "taxes",
    "giving",
    "reports",
    "transactions",
];

pub fn render(page: &str) -> AnyView {
    match page {
        "insights" => view! { <insights::InsightsPage /> }.into_any(),
        "networth" => view! { <networth::NetWorthPage /> }.into_any(),
        "subscriptions" => view! { <subscriptions::SubscriptionsPage /> }.into_any(),
        "goals" => view! { <goals::GoalsPage /> }.into_any(),
        "cashflow" => view! { <cashflow::CashFlowPage /> }.into_any(),
        "bills" => view! { <bills::BillsPage /> }.into_any(),
        "income" => view! { <income::IncomePage /> }.into_any(),
        "investments" => view! { <investments::InvestmentsPage /> }.into_any(),
        "accounts" => view! { <accounts::AccountsPage /> }.into_any(),
        "budgets" => view! { <budgets::BudgetsPage /> }.into_any(),
        "taxes" => view! { <taxes::TaxesPage /> }.into_any(),
        "giving" => view! { <giving::GivingPage /> }.into_any(),
        "reports" => view! { <reports::ReportsPage /> }.into_any(),
        "transactions" => view! { <transactions::TransactionsPage /> }.into_any(),
        _ => ().into_any(),
    }
}
