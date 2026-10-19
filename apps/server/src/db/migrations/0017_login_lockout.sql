-- Account lockout: after repeated wrong passwords or 2FA codes the account is
-- locked for a while, whatever IP address the attempts come from.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failed_login_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
