-- Device approval (ADR-0009): every device must be approved by the server
-- before it can sign in. One row per (user, device install).
CREATE TABLE IF NOT EXISTS "trusted_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "device_id" uuid NOT NULL,
  "secret_hash" text NOT NULL,
  "device_name" text NOT NULL,
  "platform" text NOT NULL,
  "status" text NOT NULL,
  "approval_code" text,
  "code_attempts" integer DEFAULT 0 NOT NULL,
  "request_ip" inet,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "approved_at" timestamp with time zone,
  "approved_via" text,
  "approved_by" uuid,
  "login_ready" boolean DEFAULT false NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trusted_devices_user_device_idx" ON "trusted_devices" ("user_id", "device_id");
--> statement-breakpoint
ALTER TABLE "device_sessions" ADD COLUMN IF NOT EXISTS "trusted_device_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_trusted_device_id_fk"
    FOREIGN KEY ("trusted_device_id") REFERENCES "trusted_devices"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
