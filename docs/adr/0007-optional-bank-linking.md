# ADR-0007: Bank linking is optional, off by default, and provider-abstracted

## Status

Accepted. Extends the privacy stance of [ADR-0006](0006-optional-multi-provider-ai.md)
(optional, off-by-default AI) to bank data.

## Context

Manual entry and CSV import work, but the most-requested convenience is
automatic transaction sync from a bank. There is no way to do this without a
third-party aggregator (Plaid, Teller, MX, GoCardless, SimpleFIN): the
aggregator holds the bank connection and relays the data. That directly
conflicts with the project's core promise — *your data stays on your hardware*.

We want the capability without silently breaking that promise, and we want to
prototype it without forcing anyone through a Plaid signup.

## Decision

1. **Off by default.** No bank UI does anything until the owner enables it in
   Settings → Connected banks. The app is fully usable — and fully local —
   without it.
2. **Provider abstraction** (mirrors the AI providers). One interface —
   `connect`, `listAccounts`, `syncTransactions` — with two backends:
   - **`mock`**: fabricates accounts and transactions entirely on the server.
     Nothing leaves the machine. This is what makes the prototype demoable and
     testable with zero external dependencies, and it is the default provider.
   - **`plaid`**: real Plaid over raw REST, using the **Sandbox** flow
     (`/sandbox/public_token/create` skips the interactive Link widget). The
     owner supplies their own Plaid credentials; the secret is stored on the
     server and never returned (`hasPlaidCredentials` boolean only).
3. **Honest privacy.** With `mock`, nothing leaves the server. With `plaid`,
   the bank login and transactions flow through Plaid's cloud under the owner's
   keys — the UI shows an explicit warning before Plaid can be selected, and the
   docs state it plainly.
4. **Data ownership on disconnect.** Synced accounts and their imported
   transactions are the user's; disconnecting a connection keeps them
   (`bank_connection_id` is set null, not cascaded).

## Consequences

- Sync is idempotent: transactions dedupe on `(account_id, external_id)`, so
  re-syncing only adds new rows. Provider balances are authoritative, so synced
  accounts take the provider balance and transaction inserts do not re-adjust
  balances (no double-counting).
- Imported transactions pass through the local categorization engine
  ([auto-categorization](../architecture.md)), so a bank sync arrives
  pre-sorted.
- Moving from prototype to real usage is a settings change (pick `plaid`, paste
  Sandbox keys) — no schema or code changes. Production Plaid is the same, with
  `plaid_env` switched and real approval obtained from Plaid.
- The privacy guarantee is now conditional in two independent axes (AI and
  bank data); both must be communicated as opt-in, off-by-default.
