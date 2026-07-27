ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Seed a stable initial order from creation time so existing rows keep a
-- deterministic sequence within each parent before the user reorders them.
WITH ordered AS (
  SELECT "id",
         (ROW_NUMBER() OVER (
           PARTITION BY "parent_category_id"
           ORDER BY "created_at", "name"
         ) - 1) AS rn
  FROM "categories"
)
UPDATE "categories" c
SET "sort_order" = ordered.rn
FROM ordered
WHERE c."id" = ordered."id";
