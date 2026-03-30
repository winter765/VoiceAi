-- Create firmware_versions table for OTA updates
CREATE TABLE IF NOT EXISTS public.firmware_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT NOT NULL,
    file_url TEXT NOT NULL,
    board_type TEXT NOT NULL DEFAULT 'bread-compact-wifi',
    force_update BOOLEAN NOT NULL DEFAULT false,
    release_notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create index for quick lookup
CREATE INDEX idx_firmware_versions_board_active ON public.firmware_versions(board_type, is_active);

-- Enable RLS
ALTER TABLE public.firmware_versions ENABLE ROW LEVEL SECURITY;

-- Allow anonymous read access (devices don't have auth)
CREATE POLICY "Allow anonymous read access to firmware_versions"
    ON public.firmware_versions
    FOR SELECT
    TO anon
    USING (true);

-- Allow authenticated users full access (for admin)
CREATE POLICY "Allow authenticated users full access to firmware_versions"
    ON public.firmware_versions
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Add comments
COMMENT ON TABLE public.firmware_versions IS 'Firmware versions for OTA updates';
COMMENT ON COLUMN public.firmware_versions.file_url IS 'Filename (e.g. elato_1.0.0.bin) or full URL. If filename only, served via /api/ota/download endpoint.';
