import { SupabaseClient } from "@supabase/supabase-js";

export interface FirmwareVersion {
    id: string;
    version: string;
    file_url: string;
    board_type: string;
    force_update: boolean;
    release_notes: string | null;
    is_active: boolean;
    created_at: string;
}

export const getActiveFirmware = async (
    supabase: SupabaseClient,
    boardType: string = "bread-compact-wifi",
): Promise<FirmwareVersion | null> => {
    const { data, error } = await supabase
        .from("firmware_versions")
        .select("*")
        .eq("board_type", boardType)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error("Error fetching active firmware:", error);
        return null;
    }
    return data;
};

export const createFirmwareVersion = async (
    supabase: SupabaseClient,
    firmware: Omit<FirmwareVersion, "id" | "created_at">,
): Promise<FirmwareVersion | null> => {
    // If this version is active, deactivate all other versions for this board
    if (firmware.is_active) {
        await supabase
            .from("firmware_versions")
            .update({ is_active: false })
            .eq("board_type", firmware.board_type);
    }

    const { data, error } = await supabase
        .from("firmware_versions")
        .insert(firmware)
        .select("*")
        .single();

    if (error) {
        console.error("Error creating firmware version:", error);
        return null;
    }
    return data;
};

export const setActiveFirmware = async (
    supabase: SupabaseClient,
    firmwareId: string,
): Promise<boolean> => {
    // Get the firmware to find its board type
    const { data: firmware } = await supabase
        .from("firmware_versions")
        .select("board_type")
        .eq("id", firmwareId)
        .single();

    if (!firmware) {
        return false;
    }

    // Deactivate all versions for this board
    await supabase
        .from("firmware_versions")
        .update({ is_active: false })
        .eq("board_type", firmware.board_type);

    // Activate the specified version
    const { error } = await supabase
        .from("firmware_versions")
        .update({ is_active: true })
        .eq("id", firmwareId);

    return !error;
};
