import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  inet,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Single-file schema on purpose: drizzle-kit's config loader requires a file
// with no relative imports, and one file also keeps cross-table references
// (FKs) trivially cycle-free. Sections below mirror docs/database-schema.md.

// ── identity ──

// Emails are normalized to lowercase in the auth service before insert/query,
// so plain text + unique gives citext semantics without the extension
// dependency (keeps embedded/test Postgres and future providers simple).
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  avatarColor: text("avatar_color").notNull(),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deviceSessions = pgTable(
  "device_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceName: text("device_name").notNull(),
    platform: text("platform", {
      enum: ["windows", "macos", "linux", "ios"],
    }).notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    ipAddress: inet("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("device_sessions_user_id_idx")
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

// ── categories ──

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  icon: text("icon"),
  color: text("color").notNull(),
  parentCategoryId: uuid("parent_category_id").references(
    (): AnyPgColumn => categories.id,
    { onDelete: "set null" },
  ),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── categorization rules ──
// User-defined keyword → category rules for local auto-categorization. The
// engine also learns merchant→category from history at runtime; only these
// explicit rules are persisted.

export const categorizationRules = pgTable("categorization_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Case-insensitive substring matched against a transaction's merchant name. */
  keyword: text("keyword").notNull(),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  /** Higher wins when multiple rules match. */
  priority: integer("priority").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── bank connections (optional third-party aggregator linking) ──
// Off by default. "mock" fabricates local data (nothing leaves the server);
// "plaid" routes through Plaid under the owner's own keys (ADR-0007).

export const bankConnections = pgTable("bank_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  /** Provider's identifier for the linked item/login. */
  externalItemId: text("external_item_id").notNull(),
  /** Provider access token; null for the mock provider. */
  accessToken: text("access_token"),
  institutionName: text("institution_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
});

// Singleton settings row (mirrors ai_settings): whether bank linking is on,
// which provider, and the owner's Plaid credentials when provider = plaid.
export const bankSettings = pgTable("bank_settings", {
  id: boolean("id").primaryKey().default(true).$type<true>(),
  enabled: boolean("enabled").notNull().default(false),
  provider: text("provider", { enum: ["mock", "plaid"] }).notNull().default("mock"),
  plaidClientId: text("plaid_client_id"),
  plaidSecret: text("plaid_secret"),
  plaidEnv: text("plaid_env", { enum: ["sandbox", "development", "production"] })
    .notNull()
    .default("sandbox"),
});

// ── accounts ──

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type", {
    enum: [
      "checking",
      "savings",
      "credit_card",
      "investment",
      "loan",
      "mortgage",
      "other",
    ],
  }).notNull(),
  institution: text("institution"),
  mask: text("mask"),
  currency: text("currency").notNull().default("USD"),
  isLiability: boolean("is_liability").notNull().default(false),
  interestRate: numeric("interest_rate", { precision: 6, scale: 4 }),
  balanceCents: bigint("balance_cents", { mode: "number" }).notNull().default(0),
  /** Set when the account was created by a bank connection sync. */
  bankConnectionId: uuid("bank_connection_id").references(() => bankConnections.id, {
    onDelete: "set null",
  }),
  externalAccountId: text("external_account_id"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── transactions ──

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    postedAt: date("posted_at").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("USD"),
    merchantName: text("merchant_name").notNull(),
    description: text("description"),
    pending: boolean("pending").notNull().default(false),
    externalId: text("external_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_account_id_idx").on(t.accountId, t.postedAt.desc()),
    index("transactions_category_id_idx").on(t.categoryId),
    uniqueIndex("transactions_dedupe_idx")
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index("transactions_merchant_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${t.merchantName})`,
    ),
  ],
);

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  transactionId: uuid("transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── budgets ──

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    period: text("period", { enum: ["monthly"] }).notNull().default("monthly"),
    rollover: boolean("rollover").notNull().default(false),
    startsOn: date("starts_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("budgets_category_period_idx").on(t.categoryId, t.startsOn)],
);

// ── investments ──

export const investmentHoldings = pgTable(
  "investment_holdings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    name: text("name"),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    costBasisCents: bigint("cost_basis_cents", { mode: "number" }),
    // User-maintained current value: a privacy-first self-hosted app has no
    // market-data feed, so valuations are entered by hand, never fetched.
    marketValueCents: bigint("market_value_cents", { mode: "number" }).notNull().default(0),
    asOfDate: date("as_of_date").notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("investment_holdings_account_id_idx").on(t.accountId)],
);

// ── goals ──

export const savingsGoals = pgTable("savings_goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  targetCents: bigint("target_cents", { mode: "number" }).notNull(),
  savedCents: bigint("saved_cents", { mode: "number" }).notNull().default(0),
  linkedAccountId: uuid("linked_account_id").references(() => accounts.id, {
    onDelete: "set null",
  }),
  targetDate: date("target_date"),
  color: text("color").notNull(),
  note: text("note"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── reports ──

export const monthlyReportSnapshots = pgTable("monthly_report_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  month: date("month").notNull().unique(),
  incomeCents: bigint("income_cents", { mode: "number" }).notNull(),
  spendingCents: bigint("spending_cents", { mode: "number" }).notNull(),
  savedCents: bigint("saved_cents", { mode: "number" }).notNull(),
  aiSummary: text("ai_summary"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── ai ──

// Singleton row: primary key is a bool constrained to true, so at most one row
// can ever exist. AI is OFF by default — the owner picks a provider and
// supplies credentials in Settings before anything is sent anywhere.
export const aiSettings = pgTable("ai_settings", {
  id: boolean("id")
    .primaryKey()
    .default(true)
    .$type<true>(),
  provider: text("provider", { enum: ["ollama", "openai", "anthropic"] })
    .notNull()
    .default("ollama"),
  model: text("model").notNull().default("llama3.1:8b"),
  // Cloud API key (openai/anthropic). Never returned by any endpoint.
  apiKey: text("api_key"),
  // Ollama base URL; also an optional OpenAI-compatible endpoint override.
  baseUrl: text("base_url").notNull().default("http://ollama:11434"),
  enabled: boolean("enabled").notNull().default(false),
});

export const aiConversations = pgTable("ai_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_messages_conversation_id_idx").on(t.conversationId, t.createdAt),
  ],
);
