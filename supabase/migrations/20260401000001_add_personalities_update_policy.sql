-- Add UPDATE policy for personalities table
-- Allow authenticated users to update personalities (admin check handled in frontend)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'personalities'
        AND policyname = 'Enable update for authenticated users'
    ) THEN
        CREATE POLICY "Enable update for authenticated users" ON "public"."personalities"
        FOR UPDATE TO "authenticated"
        USING (true)
        WITH CHECK (true);
    END IF;
END
$$;
