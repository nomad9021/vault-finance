-- Transfers between the household's own accounts aren't income or spending.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "is_transfer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "transfer_manual" boolean DEFAULT false NOT NULL;
