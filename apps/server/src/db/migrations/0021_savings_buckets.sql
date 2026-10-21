-- Savings buckets: named parts of an account's balance (Emergency, Vacation…).
CREATE TABLE IF NOT EXISTS "savings_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"allocated_cents" bigint DEFAULT 0 NOT NULL,
	"target_cents" bigint,
	"goal_id" uuid REFERENCES "savings_goals"("id") ON DELETE SET NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "savings_buckets_account_idx" ON "savings_buckets" ("account_id", "sort_order");
