-- AI Usage Tracking: usage_logs and pricing_config tables
-- Records AI session usage for billing purposes

-- 1. Create usage_logs table (session-level aggregation)
CREATE TABLE IF NOT EXISTS "public"."usage_logs" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "device_id" uuid REFERENCES "public"."devices"("device_id") ON DELETE SET NULL,
    "device_mac" text,                    -- Redundant storage for traceability after device deletion
    "user_id" uuid REFERENCES "public"."users"("user_id") ON DELETE SET NULL,
    "provider" text NOT NULL,             -- ultravox/gemini/openai/elevenlabs/hume/grok
    "session_id" text,                    -- AI session ID (e.g., Ultravox callId)

    -- Usage metrics
    "audio_input_ms" integer DEFAULT 0,   -- Input audio duration (milliseconds)
    "audio_output_ms" integer DEFAULT 0,  -- Output audio duration (milliseconds)
    "input_bytes" integer DEFAULT 0,      -- Input data size (bytes)
    "output_bytes" integer DEFAULT 0,     -- Output data size (bytes)
    "input_tokens" integer DEFAULT 0,     -- Input tokens (for text-based AI)
    "output_tokens" integer DEFAULT 0,    -- Output tokens (for text-based AI)

    -- Billing
    "cost_usd" decimal(10,6) DEFAULT 0,   -- Calculated cost in USD

    -- Timestamps
    "session_start" timestamp with time zone NOT NULL,
    "session_end" timestamp with time zone,
    "duration_ms" integer DEFAULT 0,      -- Total session duration
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes for usage_logs
CREATE INDEX IF NOT EXISTS idx_usage_logs_device_id ON usage_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_device_mac ON usage_logs(device_mac);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_provider ON usage_logs(provider);
CREATE INDEX IF NOT EXISTS idx_usage_logs_session_id ON usage_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_session_start ON usage_logs(session_start);

-- RLS for usage_logs
ALTER TABLE "public"."usage_logs" ENABLE ROW LEVEL SECURITY;

-- Users can view their own usage logs
CREATE POLICY "Users can view own usage logs"
    ON "public"."usage_logs"
    FOR SELECT
    USING (auth.uid() = user_id);

-- Service role has full access
CREATE POLICY "Service role has full access to usage logs"
    ON "public"."usage_logs"
    FOR ALL
    USING (auth.role() = 'service_role');

-- Allow anon insert/update for server-side operations (Deno server uses anon key)
CREATE POLICY "Allow anon to insert usage logs"
    ON "public"."usage_logs"
    FOR INSERT
    TO anon
    WITH CHECK (true);

CREATE POLICY "Allow anon to update usage logs"
    ON "public"."usage_logs"
    FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow anon to select usage logs"
    ON "public"."usage_logs"
    FOR SELECT
    TO anon
    USING (true);

COMMENT ON TABLE "public"."usage_logs" IS 'AI session usage logs for billing - stores aggregated metrics per session';

-- 2. Create pricing_config table
CREATE TABLE IF NOT EXISTS "public"."pricing_config" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "provider" text NOT NULL UNIQUE,
    "pricing" jsonb NOT NULL,
    "is_active" boolean DEFAULT true,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- RLS for pricing_config
ALTER TABLE "public"."pricing_config" ENABLE ROW LEVEL SECURITY;

-- Everyone can read pricing config
CREATE POLICY "Anyone can read pricing config"
    ON "public"."pricing_config"
    FOR SELECT
    USING (true);

-- Only service role can modify
CREATE POLICY "Service role can modify pricing config"
    ON "public"."pricing_config"
    FOR ALL
    USING (auth.role() = 'service_role');

COMMENT ON TABLE "public"."pricing_config" IS 'AI provider pricing configuration for cost calculation';

-- 3. Insert initial pricing data
INSERT INTO pricing_config (provider, pricing) VALUES
('ultravox', '{
    "audio_input_per_min_usd": 0.01,
    "audio_output_per_min_usd": 0.02,
    "description": "Ultravox voice AI"
}'),
('gemini', '{
    "audio_input_per_min_usd": 0.004,
    "audio_output_per_min_usd": 0.008,
    "description": "Google Gemini 2.0 Flash"
}'),
('openai', '{
    "audio_input_per_min_usd": 0.006,
    "audio_output_per_min_usd": 0.024,
    "description": "OpenAI Realtime API"
}'),
('elevenlabs', '{
    "audio_input_per_min_usd": 0,
    "audio_output_per_min_usd": 0.03,
    "description": "ElevenLabs ConvAI"
}'),
('hume', '{
    "audio_input_per_min_usd": 0.01,
    "audio_output_per_min_usd": 0.01,
    "description": "Hume EVI"
}'),
('grok', '{
    "audio_input_per_min_usd": 0.005,
    "audio_output_per_min_usd": 0.01,
    "description": "xAI Grok"
}')
ON CONFLICT (provider) DO UPDATE SET
    pricing = EXCLUDED.pricing,
    updated_at = now();
