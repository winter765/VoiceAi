-- Add usage tracking fields to conversations table
-- Links each message to its usage_log session and records per-message metrics

-- Add usage_log_id foreign key
ALTER TABLE "public"."conversations"
ADD COLUMN IF NOT EXISTS "usage_log_id" uuid REFERENCES "public"."usage_logs"("id") ON DELETE SET NULL;

-- Add per-message usage metrics
ALTER TABLE "public"."conversations"
ADD COLUMN IF NOT EXISTS "audio_duration_ms" integer DEFAULT 0;  -- Audio duration for this message (milliseconds)

ALTER TABLE "public"."conversations"
ADD COLUMN IF NOT EXISTS "audio_bytes" integer DEFAULT 0;        -- Audio size for this message (bytes)

ALTER TABLE "public"."conversations"
ADD COLUMN IF NOT EXISTS "tokens" integer DEFAULT 0;             -- Token count for this message (if applicable)

-- Index for querying conversations by usage_log
CREATE INDEX IF NOT EXISTS idx_conversations_usage_log_id ON conversations(usage_log_id);

-- Comments
COMMENT ON COLUMN "public"."conversations"."usage_log_id" IS 'Links to the AI session usage log';
COMMENT ON COLUMN "public"."conversations"."audio_duration_ms" IS 'Audio duration for this message in milliseconds';
COMMENT ON COLUMN "public"."conversations"."audio_bytes" IS 'Audio data size for this message in bytes';
COMMENT ON COLUMN "public"."conversations"."tokens" IS 'Token count for this message (text-based AI)';
