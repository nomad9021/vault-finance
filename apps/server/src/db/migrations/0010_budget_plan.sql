CREATE TABLE IF NOT EXISTS "budget_plan" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "planned_income_cents" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
