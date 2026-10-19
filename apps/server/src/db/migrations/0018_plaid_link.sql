-- Plaid Hosted Link: real banks. Each connection remembers where its last
-- /transactions/sync left off, and whether the bank wants a fresh sign-in.
ALTER TABLE "bank_connections" ADD COLUMN IF NOT EXISTS "sync_cursor" text;
--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN IF NOT EXISTS "needs_reconnect" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Plaid shut down its Development environment on 2024-06-20.
UPDATE "bank_settings" SET "plaid_env" = 'sandbox' WHERE "plaid_env" = 'development';
