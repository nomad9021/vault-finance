-- Rework ai_settings for the multi-provider, off-by-default assistant.
-- ai_settings holds a single config row; safe to drop/re-add columns.
ALTER TABLE "ai_settings" DROP COLUMN IF EXISTS "ollama_host";
ALTER TABLE "ai_settings" DROP COLUMN IF EXISTS "ollama_port";
ALTER TABLE "ai_settings" DROP COLUMN IF EXISTS "model_name";
ALTER TABLE "ai_settings" ADD COLUMN "provider" text DEFAULT 'ollama' NOT NULL;
ALTER TABLE "ai_settings" ADD COLUMN "model" text DEFAULT 'llama3.1:8b' NOT NULL;
ALTER TABLE "ai_settings" ADD COLUMN "api_key" text;
ALTER TABLE "ai_settings" ADD COLUMN "base_url" text DEFAULT 'http://ollama:11434' NOT NULL;
ALTER TABLE "ai_settings" ALTER COLUMN "enabled" SET DEFAULT false;
-- Existing installs: force AI off so the pivot's "off by default" holds.
UPDATE "ai_settings" SET "enabled" = false;
