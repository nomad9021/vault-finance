CREATE TABLE IF NOT EXISTS "member_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "display_name" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "token_hash" text NOT NULL,
  "invited_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "member_invites" ADD CONSTRAINT "member_invites_invited_by_user_id_users_id_fk"
    FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_invites_email_idx" ON "member_invites" ("email");
