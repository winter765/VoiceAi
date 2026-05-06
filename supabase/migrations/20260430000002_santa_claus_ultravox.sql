-- Add 'ultravox' to provider CHECK constraint
ALTER TABLE "public"."personalities"
DROP CONSTRAINT IF EXISTS personalities_provider_check;

ALTER TABLE "public"."personalities"
ADD CONSTRAINT personalities_provider_check
CHECK (provider IN ('openai', 'gemini', 'grok', 'elevenlabs', 'hume', 'ultravox'));

-- Update santa_claus personality to use Ultravox with custom voice
UPDATE "public"."personalities"
SET
    provider = 'ultravox',
    oai_voice = 'c846dea0-4083-4313-be97-6bf0b7cdc344'
WHERE key = 'santa_claus';
