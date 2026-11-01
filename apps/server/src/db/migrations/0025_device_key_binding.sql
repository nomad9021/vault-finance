-- Biometric keys belong to the approved device that enrolled them, so a key
-- copied off a device (or minted with a stolen access token) is useless
-- without that device's own identity, and dies when the device is revoked.
-- Existing keys stay NULL and are bound on their next use (auth/service.ts).
ALTER TABLE "device_keys" ADD COLUMN IF NOT EXISTS "trusted_device_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_trusted_device_id_fk"
    FOREIGN KEY ("trusted_device_id") REFERENCES "trusted_devices"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
