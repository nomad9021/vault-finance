CREATE TABLE IF NOT EXISTS "debt_plan" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "extra_cents" bigint DEFAULT 20000 NOT NULL,
  "strategy" text DEFAULT 'avalanche' NOT NULL,
  "overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "manual" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
