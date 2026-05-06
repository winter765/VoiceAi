-- ============================================================
-- Chef AI - Supabase Database Schema
-- 独立 Supabase 项目，为公司 B 使用
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

-- ============================================================
-- 1. Languages Table (语言列表)
-- ============================================================
CREATE TABLE IF NOT EXISTS "public"."languages" (
    "language_id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "code" text NOT NULL UNIQUE,
    "name" text NOT NULL,
    "flag" text NOT NULL
);

-- 初始化语言数据
INSERT INTO "public"."languages" ("code", "name", "flag") VALUES
    ('en-US', 'English', '🇺🇸'),
    ('zh-CN', '中文', '🇨🇳')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 2. Personalities Table (人格/角色配置)
-- ============================================================
CREATE TABLE IF NOT EXISTS "public"."personalities" (
    "personality_id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "key" text NOT NULL UNIQUE,
    "title" text DEFAULT '' NOT NULL,
    "subtitle" text DEFAULT '' NOT NULL,
    "short_description" text DEFAULT '' NOT NULL,
    "character_prompt" text DEFAULT '' NOT NULL,
    "oai_voice" text DEFAULT 'alloy' NOT NULL,
    "voice_prompt" text DEFAULT '' NOT NULL,
    "is_doctor" boolean DEFAULT false NOT NULL,
    "is_child_voice" boolean DEFAULT false,
    "is_story" boolean DEFAULT false NOT NULL,
    "creator_id" uuid,
    "pitch_factor" real DEFAULT 1.0,
    "first_message" text DEFAULT '',
    "provider" text DEFAULT 'ultravox'
);

-- 插入 Chef 角色
INSERT INTO "public"."personalities" ("key", "title", "subtitle", "short_description", "character_prompt", "oai_voice", "provider") VALUES
    ('chef', 'Chef', 'AI Kitchen Assistant', 'Your personal cooking guide', 'You are Chef, an AI kitchen assistant.', 'alloy', 'ultravox')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 3. Users Table (用户表)
-- ============================================================
CREATE TABLE IF NOT EXISTS "public"."users" (
    "user_id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "email" text DEFAULT '' NOT NULL,
    "supervisor_name" text NOT NULL DEFAULT '',
    "supervisee_name" text NOT NULL DEFAULT '',
    "supervisee_persona" text DEFAULT '' NOT NULL,
    "supervisee_age" smallint DEFAULT 30 NOT NULL,
    "session_time" integer DEFAULT 0 NOT NULL,
    "avatar_url" text DEFAULT '' NOT NULL,
    "personality_id" uuid REFERENCES "public"."personalities"("personality_id") ON DELETE SET DEFAULT,
    "is_premium" boolean DEFAULT false NOT NULL,
    "user_info" jsonb DEFAULT '{"user_type": "user", "user_metadata": {}}'::jsonb NOT NULL,
    "language_code" text DEFAULT 'en-US' NOT NULL REFERENCES "public"."languages"("code") ON UPDATE CASCADE ON DELETE SET DEFAULT,
    "device_id" uuid UNIQUE
);

COMMENT ON TABLE "public"."users" IS 'Chef AI users';

-- ============================================================
-- 4. Devices Table (设备表)
-- ============================================================
CREATE TABLE IF NOT EXISTS "public"."devices" (
    "device_id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "mac_address" text UNIQUE,
    "user_code" text NOT NULL UNIQUE,
    "user_id" uuid REFERENCES "public"."users"("user_id") ON UPDATE CASCADE ON DELETE SET NULL,
    "is_ota" boolean DEFAULT false NOT NULL,
    "is_reset" boolean DEFAULT false NOT NULL,
    "volume" smallint DEFAULT 70 NOT NULL,
    "device_name" text DEFAULT '',
    "firmware_version" text DEFAULT ''
);

COMMENT ON TABLE "public"."devices" IS 'Chef AI devices';

-- 添加 users.device_id 外键
ALTER TABLE "public"."users"
    ADD CONSTRAINT "users_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id")
    ON UPDATE CASCADE ON DELETE SET NULL;

-- ============================================================
-- 5. Conversations Table (对话历史)
-- ============================================================
CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "conversation_id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "user_id" uuid NOT NULL REFERENCES "public"."users"("user_id"),
    "role" text NOT NULL,
    "content" text NOT NULL,
    "metadata" jsonb,
    "chat_group_id" uuid,
    "is_sensitive" boolean DEFAULT false,
    "personality_key" text REFERENCES "public"."personalities"("key") ON UPDATE CASCADE ON DELETE CASCADE
);

COMMENT ON TABLE "public"."conversations" IS 'Chef AI conversation history';

-- ============================================================
-- 6. Recipe Sessions Table (食谱会话 - Chef 专属)
-- ============================================================
CREATE TABLE IF NOT EXISTS "public"."recipe_sessions" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "device_id" text NOT NULL,
    "user_id" uuid REFERENCES "public"."users"("user_id") ON DELETE CASCADE,
    "recipe_name" text NOT NULL,
    "total_steps" integer NOT NULL,
    "current_step" integer DEFAULT 1 NOT NULL,
    "steps" jsonb NOT NULL,
    "status" text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
    "session_language" text DEFAULT 'en',
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT (now() + interval '2 hours') NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_recipe_sessions_device_id" ON "public"."recipe_sessions" ("device_id");
CREATE INDEX IF NOT EXISTS "idx_recipe_sessions_expires_at" ON "public"."recipe_sessions" ("expires_at");
CREATE INDEX IF NOT EXISTS "idx_recipe_sessions_user_id" ON "public"."recipe_sessions" ("user_id");

-- Auto-update updated_at trigger
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

COMMENT ON TABLE "public"."recipe_sessions" IS 'Chef AI recipe navigation sessions';

-- ============================================================
-- 7. Firmware Versions Table (OTA 更新)
-- ============================================================
CREATE TABLE IF NOT EXISTS "public"."firmware_versions" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "version" text NOT NULL,
    "file_url" text NOT NULL,
    "board_type" text NOT NULL DEFAULT 'bread-compact-wifi-lcd32',
    "force_update" boolean NOT NULL DEFAULT false,
    "release_notes" text,
    "is_active" boolean NOT NULL DEFAULT false,
    "created_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX idx_firmware_versions_board_active ON "public"."firmware_versions"(board_type, is_active);

COMMENT ON TABLE "public"."firmware_versions" IS 'Chef AI firmware versions for OTA';

-- ============================================================
-- 8. API Keys Table (用户 API Key 存储)
-- ============================================================
CREATE TABLE IF NOT EXISTS "public"."api_keys" (
    "api_key_id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "user_id" uuid NOT NULL UNIQUE REFERENCES "public"."users"("user_id") ON UPDATE CASCADE ON DELETE CASCADE,
    "encrypted_key" text NOT NULL,
    "iv" text NOT NULL
);

-- ============================================================
-- Row Level Security (RLS) Policies
-- ============================================================

-- Languages: public read
ALTER TABLE "public"."languages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read access for all" ON "public"."languages" FOR SELECT USING (true);

-- Personalities: public read
ALTER TABLE "public"."personalities" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read access for all" ON "public"."personalities" FOR SELECT USING (true);
CREATE POLICY "Authenticated users can insert" ON "public"."personalities" FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update own" ON "public"."personalities" FOR UPDATE TO authenticated USING (creator_id = auth.uid());

-- Users: read all, update own
ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read access for all" ON "public"."users" FOR SELECT USING (true);
CREATE POLICY "Enable insert for authenticated" ON "public"."users" FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Enable update for own email" ON "public"."users" FOR UPDATE USING (((SELECT auth.jwt()) ->> 'email') = email);
CREATE POLICY "Anon update" ON "public"."users" FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- Devices: read all, insert all, update all
ALTER TABLE "public"."devices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read access for all" ON "public"."devices" FOR SELECT USING (true);
CREATE POLICY "Enable insert for all" ON "public"."devices" FOR INSERT WITH CHECK (true);
CREATE POLICY "Enable update for all" ON "public"."devices" FOR UPDATE USING (true) WITH CHECK (true);

-- Conversations: public access
ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public conversations" ON "public"."conversations" USING (true);

-- Recipe Sessions: user-based access + service role
ALTER TABLE "public"."recipe_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own" ON "public"."recipe_sessions" FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own" ON "public"."recipe_sessions" FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own" ON "public"."recipe_sessions" FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users delete own" ON "public"."recipe_sessions" FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Service role full access" ON "public"."recipe_sessions" FOR ALL USING (auth.role() = 'service_role');

-- Firmware: anon read, authenticated full
ALTER TABLE "public"."firmware_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anon read firmware" ON "public"."firmware_versions" FOR SELECT TO anon USING (true);
CREATE POLICY "Authenticated full access" ON "public"."firmware_versions" FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- API Keys: user-based
ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own keys" ON "public"."api_keys" FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert keys" ON "public"."api_keys" FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Users delete own keys" ON "public"."api_keys" FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ============================================================
-- Grants
-- ============================================================
GRANT USAGE ON SCHEMA "public" TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA "public" TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA "public" TO anon, authenticated, service_role;
