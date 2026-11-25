//! Types and pure logic for the Rust UI.
//!
//! Each module mirrors a file in `packages/shared/src` (zod schemas become
//! serde structs with the same camelCase field names), so a value the
//! TypeScript `ApiClient` has already validated deserializes here unchanged.
//! Keep this crate free of wasm/browser dependencies: everything in it is
//! tested natively with `cargo test -p vault-core`.

pub mod accounts;
pub mod accounts_page;
pub mod balance_view;
pub mod bills;
pub mod buckets;
pub mod budget_period;
pub mod budget_sankey;
pub mod budgets;
pub mod cashflow;
pub mod categories;
pub mod dates;
pub mod debt;
pub mod giving;
pub mod goals;
pub mod income;
pub mod insights;
pub mod investments;
pub mod money;
pub mod nav;
pub mod networth;
pub mod preferences;
pub mod sankey;
pub mod sankey_card;
pub mod taxes;
pub mod transactions;
pub mod trend_chart;
