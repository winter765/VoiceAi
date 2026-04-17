-- Add session_language column to recipe_sessions table
-- Stores the detected/preferred language for the session (zh/en)

ALTER TABLE recipe_sessions ADD COLUMN IF NOT EXISTS session_language TEXT DEFAULT 'en';

COMMENT ON COLUMN recipe_sessions.session_language IS 'Detected language from user conversation (zh or en)';
