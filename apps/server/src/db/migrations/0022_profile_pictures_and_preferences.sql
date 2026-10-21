-- Profile pictures (small data: URLs) and per-person preferences such as the
-- dashboard layout, which follow the person to every device.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_image" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;
