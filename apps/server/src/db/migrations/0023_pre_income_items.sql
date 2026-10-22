-- Taxes and paycheck deductions the user enters, drawn before income on the Sankeys.
ALTER TABLE "budget_plan" ADD COLUMN IF NOT EXISTS "pre_income" jsonb DEFAULT '{"items":[],"useEstimate":true}'::jsonb NOT NULL;
