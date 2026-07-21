ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "quality_models" text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "show_model_names" boolean DEFAULT false NOT NULL;
