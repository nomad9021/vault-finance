# How Vault Finance works

A tour of what the app does and how the pieces fit together. Vault Finance is a
**private, self-hosted personal-finance app**: you run the server, your data
never leaves your hardware, and AI is optional and off by default.

---

## The big picture

```
  Desktop app  ──TLS──▶  Your server  ──▶  PostgreSQL (your data)
  (Tauri +React)          (Fastify)    └──▶  Ollama (optional local AI)
```

- The **desktop app** is just a client — it holds no data. Everything lives in
  your server's database.
- The server exposes a small REST API (`/api/v1/...`); the client talks to it
  over TLS with a pinned certificate.
- Money is stored in **integer cents** everywhere to avoid rounding errors.

Where things live in the codebase:

| Path | What |
|---|---|
| `apps/server` | Fastify API, Postgres schema + migrations, business logic |
| `apps/desktop` | Tauri + React desktop client (the screens below) |
| `packages/shared` | Zod schemas + the typed API client used by the app |
| `packages/ui` | Shared UI primitives (Panel, Button, charts like the Sankey) |
| `packages/design-tokens` | The one CSS system (spacing, color, type, shadows) |

---

## Core concepts

- **Accounts** hold balances (checking, savings, credit cards, loans, mortgages,
  investments). Liabilities (credit cards / loans) carry negative balances.
- **Transactions** are money in (+) or out (−), each tied to an account and,
  ideally, a **category**.
- **Categories** form a **tree** (e.g. *Housing → Rent / Utilities*). This tree
  is the single structure that shapes the cash-flow **and** budget Sankey
  diagrams — you edit it in **Settings → Category tree**.
- **Net worth** = assets − liabilities across all accounts.

---

## The screens

### Dashboard
Your at-a-glance command center:
- **Hero metrics** — net worth, income, spending, savings rate for the month.
- **Cash-flow Sankey** — the flagship diagram: income sources → a total-income
  hub → spending categories, plus **Bills**, **Debt payments**, and an
  **Unspent / saved** flow so the diagram balances. Click any node to drill into
  its transactions.
- **Trend cards** — net worth, income, and spending over the last 6 months, each
  with a dashed **forward projection**.
- **Budgets**, **Upcoming bills**, **Recent activity**, **Goals**, and
  **Investments** summaries — each links to its full page.

### Accounts
The financial command center: a large **net-worth** figure, a **performance
chart** (net worth over time + projection), **asset-allocation** and
**liabilities** breakdowns, and **expandable account groups** with balances.

### Transactions
A fast, bank-app-style ledger:
- **Sticky toolbar** with search, category / account / **date-range** filters.
- **Bulk edit** — select rows to re-categorize or delete in one go.
- A **summary card** (money in / out / net) for the *entire* filtered set.
- **CSV import** from your bank, and **Auto-categorize** (local keyword rules +
  learning from your past choices — no AI involved).

### Income
Income sources and history, feeding the income side of the Sankey.

### Budgets
Set a **monthly limit per category** and track spending against it, month by
month, with progress bars and over-budget warnings.

### Budget Planner
A forward-looking, plan-only view: set one **fixed monthly income**, allocate it
across categories, and watch a **Sankey** balance the plan (income → each
category → *Unallocated / savings*). It uses the same category tree and the same
Sankey presentation as the Dashboard, so both stay consistent.

### Cash Flow / Reports
Income-vs-spending over recent months, monthly and yearly **reports**, and (if
AI is enabled) a short written summary of your month.

### Bills
Track recurring bills — amount, cadence, next due date — and how much you've
**set aside** toward each (a sinking fund). Bills also appear as a branch in the
cash-flow Sankey.

### Goals & "Get out of debt"
- **Savings goals** with a target, progress bar, and projected completion; link
  a goal to an account so its balance drives the progress automatically.
- The **Get out of debt** planner: a gear-icon window to edit each debt (name,
  balance, APR, minimum) and add or delete debts. It compares **avalanche vs.
  snowball** payoff, shows the payoff curve and interest saved, and plays a
  celebration when you hit $0. Its state is saved server-side and shared with
  the Sankey's debt branch.

### Investments
Holdings with quantity, cost basis, and market value; totals, unrealized
gain/loss, and an allocation breakdown.

### AI Assistant (optional)
Off by default. Turn it on in Settings and connect a provider — **local Ollama**
(nothing leaves your hardware) or **your own OpenAI / Anthropic key**. It can
explain spending, forecast cash flow, and summarize your month. The server talks
to the provider; the desktop app never holds your key.

### Settings
One place for: **theme**, the **category tree** (shapes both Sankeys),
**auto-categorization rules**, optional **bank linking**, **AI** configuration,
**two-factor authentication**, signed-in **devices**, and the **server**
connection.

---

## Security & privacy (short version)

- **Single owner** — no registration or invite path; only you can sign in.
- **argon2id** password hashing, rotating hashed refresh tokens, login
  rate-limiting, TLS with certificate pinning.
- **Two-factor authentication** (TOTP / authenticator app) available in Settings.
- **No telemetry, ever.** AI runs only if you turn it on, and can be kept fully
  local with Ollama.

For deploying, moving data to another drive, backups, and 2FA recovery, see
[operations.md](operations.md).
