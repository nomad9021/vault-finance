-- The household's tax profile (earners' gross pay, pre-tax deductions,
-- filing status, state and locality). One row; take-home is computed from it.
CREATE TABLE IF NOT EXISTS "tax_profile" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"profile" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
