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
pub mod buckets;
pub mod cashflow;
pub mod dates;
pub mod debt;
pub mod goals;
pub mod insights;
pub mod money;
pub mod nav;
pub mod networth;
pub mod trend_chart;
