//! Types and pure logic for the Rust UI.
//!
//! Each module mirrors a file in `packages/shared/src` (zod schemas become
//! serde structs with the same camelCase field names), so a value the
//! TypeScript `ApiClient` has already validated deserializes here unchanged.
//! Keep this crate free of wasm/browser dependencies: everything in it is
//! tested natively with `cargo test -p vault-core`.

pub mod accounts;
pub mod accounts_page;
pub mod ai;
pub mod ai_actions;
pub mod auth;
pub mod auto_lock;
pub mod balance_view;
pub mod bank;
pub mod bills;
pub mod buckets;
pub mod budget_period;
pub mod budget_sankey;
pub mod budgets;
pub mod cashflow;
pub mod categories;
pub mod categorize;
pub mod common;
pub mod control;
pub mod dashboard;
pub mod dates;
pub mod debt;
pub mod downloads;
pub mod giving;
pub mod goals;
pub mod guilt_free;
pub mod income;
pub mod insights;
pub mod investments;
pub mod members;
pub mod money;
pub mod nav;
pub mod networth;
pub mod password;
pub mod platform;
pub mod preferences;
pub mod reports;
pub mod sankey;
pub mod sankey_card;
pub mod serde_util;
pub mod server_route;
pub mod setup;
pub mod startup_checks;
pub mod status;
pub mod subscriptions;
pub mod taxes;
pub mod transactions;
pub mod transactions_page;
pub mod trend_chart;
pub mod updates;
pub mod url;
pub mod user;
