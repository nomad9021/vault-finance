CREATE TABLE IF NOT EXISTS "giving_funds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "kind" text DEFAULT 'giving' NOT NULL,
  "recipient" text,
  "monthly_cents" bigint DEFAULT 0 NOT NULL,
  "saved_cents" bigint DEFAULT 0 NOT NULL,
  "target_cents" bigint,
  "occasion_date" date,
  "account_id" uuid,
  "category_id" uuid,
  "color" text DEFAULT '#b47ef0' NOT NULL,
  "note" text,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "giving_funds" ADD CONSTRAINT "giving_funds_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "giving_funds" ADD CONSTRAINT "giving_funds_category_id_categories_id_fk"
    FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "savings_goals" ADD COLUMN IF NOT EXISTS "monthly_cents" bigint DEFAULT 0 NOT NULL;
