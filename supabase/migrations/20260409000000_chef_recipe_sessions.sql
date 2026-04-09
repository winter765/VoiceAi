-- Chef AI: Recipe Sessions Table
-- Stores active recipe navigation sessions for step-by-step guidance

CREATE TABLE IF NOT EXISTS "public"."recipe_sessions" (
    "id" uuid DEFAULT extensions.uuid_generate_v4() NOT NULL PRIMARY KEY,
    "device_id" text NOT NULL,
    "user_id" uuid REFERENCES "public"."users"("user_id") ON DELETE CASCADE,
    "recipe_name" text NOT NULL,
    "total_steps" integer NOT NULL,
    "current_step" integer DEFAULT 1 NOT NULL,
    "steps" jsonb NOT NULL,  -- Array of step strings
    "status" text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT (now() + interval '2 hours') NOT NULL
);

-- Index for fast lookups by device
CREATE INDEX IF NOT EXISTS "idx_recipe_sessions_device_id" ON "public"."recipe_sessions" ("device_id");

-- Index for expiration cleanup
CREATE INDEX IF NOT EXISTS "idx_recipe_sessions_expires_at" ON "public"."recipe_sessions" ("expires_at");

-- Index for user's sessions
CREATE INDEX IF NOT EXISTS "idx_recipe_sessions_user_id" ON "public"."recipe_sessions" ("user_id");

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION "public"."update_recipe_session_updated_at"()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "recipe_sessions_updated_at_trigger"
    BEFORE UPDATE ON "public"."recipe_sessions"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."update_recipe_session_updated_at"();

-- RLS Policies
ALTER TABLE "public"."recipe_sessions" ENABLE ROW LEVEL SECURITY;

-- Users can view their own sessions
CREATE POLICY "Users can view own recipe sessions"
    ON "public"."recipe_sessions"
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own sessions
CREATE POLICY "Users can insert own recipe sessions"
    ON "public"."recipe_sessions"
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own sessions
CREATE POLICY "Users can update own recipe sessions"
    ON "public"."recipe_sessions"
    FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can delete their own sessions
CREATE POLICY "Users can delete own recipe sessions"
    ON "public"."recipe_sessions"
    FOR DELETE
    USING (auth.uid() = user_id);

-- Service role has full access (for server-side operations)
CREATE POLICY "Service role has full access to recipe sessions"
    ON "public"."recipe_sessions"
    FOR ALL
    USING (auth.role() = 'service_role');

-- Comment
COMMENT ON TABLE "public"."recipe_sessions" IS 'Chef AI recipe navigation sessions for step-by-step cooking guidance';
