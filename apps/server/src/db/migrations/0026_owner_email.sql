-- The owner's own mailbox, connected from Settings → Members, so household
-- invitations really come from their address. Singleton like ai_settings; the
-- password is an app password, encrypted by secret-crypto and never returned.
CREATE TABLE IF NOT EXISTS "owner_email" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "from_email" text NOT NULL,
  "host" text NOT NULL,
  "port" integer NOT NULL,
  "password" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
