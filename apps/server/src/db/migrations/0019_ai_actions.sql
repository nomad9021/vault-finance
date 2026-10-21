-- Changes the AI assistant proposes (category tree, rules, budgets, settings).
-- Each waits for the user's approval unless they chose auto mode; the row
-- records what was asked for and what happened.
CREATE TABLE IF NOT EXISTS "ai_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "ai_conversations"("id") ON DELETE CASCADE,
	"message_id" uuid REFERENCES "ai_messages"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_actions_conversation_id_idx" ON "ai_actions" ("conversation_id", "created_at");
