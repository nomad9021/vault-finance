ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'expense' NOT NULL;
--> statement-breakpoint
-- The seeded top-level "Income" category becomes the first income source.
UPDATE "categories" SET "kind" = 'income'
WHERE "parent_category_id" IS NULL AND lower("name") = 'income';
