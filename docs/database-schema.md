# Database schema

PostgreSQL 16. Shown as SQL DDL for readability; the actual source of truth will
be the Drizzle schema in `apps/server/src/db/schema/`, which generates this.
One server = one household, so there is no `households` table — `users` rows
share a single implicit household, matching the Settings → Household screen in
the design (a small, fixed member list, not a multi-tenant model).

All money is stored as **integer cents** (`bigint`), never floating point.
Every table has `created_at timestamptz not null default now()`; tables that
are user-editable also get `updated_at` maintained by a trigger.

```sql
-- ── Identity & auth ─────────────────────────────────────────────

create table users (
  id              uuid primary key default gen_random_uuid(),
  email           citext not null unique,
  password_hash   text not null,               -- argon2id
  display_name    text not null,
  avatar_color    text not null,                -- hex, used for the initial-bubble tint
  role            text not null check (role in ('owner','member')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table device_sessions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  device_name         text not null,             -- user-editable label, e.g. "Maya's MacBook"
  platform            text not null check (platform in ('windows','macos','linux','ios')),
  refresh_token_hash  text not null,              -- argon2id hash of the opaque refresh token
  ip_address          inet,
  created_at          timestamptz not null default now(),
  last_used_at        timestamptz not null default now(),
  revoked_at          timestamptz
);
create index device_sessions_user_id_idx on device_sessions(user_id) where revoked_at is null;

-- ── AI configuration ────────────────────────────────────────────

create table ai_settings (
  id            boolean primary key default true check (id),  -- singleton row
  ollama_host   text not null default 'ollama',
  ollama_port   integer not null default 11434,
  model_name    text not null default 'llama3.1:8b',
  enabled       boolean not null default true
);

create table ai_conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  title       text,                               -- derived from first message, editable
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table ai_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references ai_conversations(id) on delete cascade,
  role             text not null check (role in ('user','assistant')),
  content          text not null,
  created_at       timestamptz not null default now()
);
create index ai_messages_conversation_id_idx on ai_messages(conversation_id, created_at);

-- ── Categories ───────────────────────────────────────────────────

create table categories (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  icon                text,                        -- phosphor icon name
  color               text not null,                -- hex, drives budget bars / sankey leaves
  parent_category_id  uuid references categories(id) on delete set null,
  is_system           boolean not null default false, -- seeded defaults (Groceries, Mortgage, …), not deletable
  created_at          timestamptz not null default now()
);

-- ── Accounts ────────────────────────────────────────────────────

create table accounts (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references users(id) on delete cascade,
  name           text not null,
  type           text not null check (type in
                   ('checking','savings','credit_card','investment','loan','mortgage','other')),
  institution    text,
  mask           text,                              -- last 4 digits, display only
  currency       text not null default 'USD',
  is_liability   boolean not null default false,
  interest_rate  numeric(6,4),                       -- APR or APY as a decimal, e.g. 0.0410
  balance_cents  bigint not null default 0,           -- current balance, maintained by transaction triggers
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Transactions ────────────────────────────────────────────────

create table transactions (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  category_id   uuid references categories(id) on delete set null,
  posted_at     date not null,
  amount_cents  bigint not null,                     -- negative = outflow, positive = inflow
  currency      text not null default 'USD',
  merchant_name text not null,
  description   text,
  pending       boolean not null default false,
  external_id   text,                                 -- dedupe key for CSV re-imports
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index transactions_account_id_idx on transactions(account_id, posted_at desc);
create index transactions_category_id_idx on transactions(category_id);
create unique index transactions_dedupe_idx on transactions(account_id, external_id) where external_id is not null;
create index transactions_merchant_search_idx on transactions using gin (to_tsvector('simple', merchant_name));

create table attachments (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null references transactions(id) on delete cascade,
  file_path       text not null,                      -- path within the server's upload volume
  mime_type       text not null,
  size_bytes      bigint not null,
  created_at      timestamptz not null default now()
);

-- ── Budgets ─────────────────────────────────────────────────────

create table budgets (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid not null references categories(id) on delete cascade,
  amount_cents  bigint not null,
  period        text not null default 'monthly' check (period in ('monthly')),
  rollover      boolean not null default false,        -- unused amount carries to next period
  starts_on     date not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index budgets_category_period_idx on budgets(category_id, starts_on);

-- ── Investments ─────────────────────────────────────────────────

create table investment_holdings (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts(id) on delete cascade,
  symbol          text not null,
  name            text,
  quantity        numeric(20,6) not null,
  cost_basis_cents bigint,
  as_of_date      date not null default current_date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index investment_holdings_account_id_idx on investment_holdings(account_id);

-- ── Savings goals ───────────────────────────────────────────────

create table savings_goals (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  target_cents      bigint not null,
  saved_cents       bigint not null default 0,          -- manually tracked, or derived if linked_account_id is set
  linked_account_id uuid references accounts(id) on delete set null,
  target_date       date,
  color             text not null,
  note              text,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── Reports (cached AI commentary, not raw data — that's always derived) ──

create table monthly_report_snapshots (
  id             uuid primary key default gen_random_uuid(),
  month          date not null,                          -- first of month, unique
  income_cents   bigint not null,
  spending_cents bigint not null,
  saved_cents    bigint not null,
  ai_summary     text,                                    -- generated once, cached; regenerable
  generated_at   timestamptz not null default now(),
  unique (month)
);
```

## Notes on derived data

- **Cash flow / Sankey** (`GET /api/v1/cashflow/sankey`) is computed on the fly
  from `transactions` grouped by `category_id` for the requested month — no
  dedicated table. `monthly_report_snapshots` exists purely to cache the
  AI-generated commentary so re-opening last month's report doesn't re-prompt
  the model.
- **Net worth** is `sum(accounts.balance_cents)` with liabilities already
  negative by convention (enforced in the accounts service, not the DB, so
  `is_liability` stays a display/categorization flag rather than a sign
  transform the DB has to reverse-engineer).
- **`account.balance_cents`** is maintained by the transactions service inside
  the same transaction (pun acknowledged) as any insert/update/delete against
  `transactions` — not a DB trigger — so the AI/reporting layer can reason about
  it without needing to understand Postgres trigger internals.
