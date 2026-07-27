CREATE TABLE IF NOT EXISTS "bills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "amount_cents" bigint NOT NULL,
  "saved_cents" bigint DEFAULT 0 NOT NULL,
  "due_day" integer DEFAULT 1 NOT NULL,
  "cadence" text DEFAULT 'monthly' NOT NULL,
  "autopay" boolean DEFAULT false NOT NULL,
  "account_id" uuid,
  "category_id" uuid,
  "color" text DEFAULT '#6f8ef2' NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "bills" ADD CONSTRAINT "bills_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "bills" ADD CONSTRAINT "bills_category_id_categories_id_fk"
    FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
