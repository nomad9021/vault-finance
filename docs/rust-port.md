# Moving the UI to Rust

The desktop/iOS UI is moving from React to [Leptos](https://leptos.dev) (Rust compiled to
WebAssembly) one page at a time, for a more responsive app: Leptos updates only the DOM nodes
whose data changed, with no virtual-DOM diff and no re-rendering of whole components.

Nothing changes for the server, the API or the design: Rust pages use the same stylesheet
classes and talk to the server through the same `ApiClient`.

## How it fits together

```
React shell (AppShell, sidebar, sign-in, ApiClient)
  └─ PageBody: page in RUST_PAGES and Rust UI on?
       ├─ yes → <RustPage> → wasm mount(el, page, host) → crates/vault-ui/src/pages/<page>.rs
       └─ no  → the React page, as before
```

- `crates/vault-core`: types (serde mirrors of `packages/shared` zod schemas) and pure logic.
  No browser dependencies, tested natively: `cargo test --manifest-path crates/Cargo.toml -p vault-core`.
- `crates/vault-ui`: Leptos pages and the `@vault/ui` primitives (same class names). The icon
  set is generated from `packages/ui/src/primitives/Icon.tsx` (`scripts/gen-rust-icons.mjs`).
- `apps/desktop/src/rust/RustPage.tsx`: loads the wasm, builds the host object (`call` an
  `ApiClient` method, `navigate`, `onDataChange`) and mounts/unmounts the page.
- Switch: Rust pages are on in dev builds and off in releases unless
  `localStorage["vault.rust-ui"] = "on"`. Set it to `"off"` to compare with the React page.

Build: `pnpm --filter @vault/desktop build:rust` (also run by `dev` and `build`). Needs
`rustup target add wasm32-unknown-unknown` and `cargo install wasm-pack --locked` once.

## Porting a page

1. Branch `rust/page-<id>` from main (one page per branch and pull request).
2. Add the response types to `vault-core` (field names exactly as the zod schema, with
   `#[serde(rename_all = "camelCase")]`), with a test that parses a realistic sample.
3. Any pure logic the page has (sorting, grouping, sums, date maths) goes in `vault-core` with
   tests. Logic shared with other pages that lives in `packages/shared` is ported with
   rust-anything (record → port → diff → gate) so it matches the TypeScript case by case.
4. Write `crates/vault-ui/src/pages/<id>.rs`, add it to `pages::IDS`/`render` and to
   `RUST_PAGES` in RustPage.tsx. Missing primitives go in `crates/vault-ui/src/ui`.
5. Check: `cargo fmt`, `cargo clippy --target wasm32-unknown-unknown -D warnings`, `cargo test`,
   desktop `tsc` + `vitest`, and screenshots of the React and Rust page on the dev stack
   (`node scripts/dev-stack.mjs --fresh` + `node scripts/seed-demo.mjs`) must match.
   `vault-ai-check parity <page>.tsx <page>.rs` gives a quick second opinion from the local
   model; treat it as advisory.
6. Update the ledger below in the same pull request.

## Ledger

Status: `todo` · `wip` · `review` (PR open) · `done` (merged, Rust page on in dev) · `default` (on in releases)

| Page | Wave | Status | Branch |
|---|---|---|---|
| insights | 0 | review | rust/foundation |
| cashflow | 1 | todo | |
| networth | 1 | review | rust/page-networth |
| subscriptions | 1 | todo | |
| goals (+ buckets tab) | 1 | review | rust/page-goals |
| investments | 2 | todo | |
| income | 2 | todo | |
| reports | 2 | todo | |
| taxes | 2 | todo | |
| accounts | 2 | todo | |
| bills | 2 | todo | |
| budgets (+ planner, vs-actual) | 2 | todo | |
| giving | 2 | todo | |
| transactions | 3 | todo | |
| dashboard | 3 | todo | |
| assistant | 3 | todo | |
| settings | 3 | todo | |
| shell | 4 | todo | |
| auth-screens | 4 | todo | |

| Shared logic (vault-core) | Status | Branch |
|---|---|---|
| money (format/parse) | wip (parseAmountToCents, toFixed) | rust/page-goals |
| tax engine | todo | |
| budget sankey | todo | |
| debt calculator | todo | |
| dashboard layout | todo | |

Wave 4 retires React: the shell and sign-in move to Leptos, `RustPage` becomes the app root,
and React, react-dom and zustand leave the bundle.
