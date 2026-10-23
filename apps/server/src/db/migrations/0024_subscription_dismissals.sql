-- Detected subscriptions the household said aren't subscriptions. Keyed by the
-- normalized merchant name, the same key detection groups charges by.
CREATE TABLE IF NOT EXISTS "subscription_dismissals" (
	"merchant_key" text PRIMARY KEY NOT NULL,
	"merchant_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
