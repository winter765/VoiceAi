-- Add new columns to devices table for self-registration support
ALTER TABLE "public"."devices" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ DEFAULT now();
ALTER TABLE "public"."devices" ADD COLUMN IF NOT EXISTS "device_name" TEXT DEFAULT '';
ALTER TABLE "public"."devices" ADD COLUMN IF NOT EXISTS "firmware_version" TEXT DEFAULT '';

-- Allow anonymous/unauthenticated INSERT into devices (for ESP32 self-registration)
CREATE POLICY "devices_self_register" ON "public"."devices"
  FOR INSERT WITH CHECK (true);
