import { SupabaseClient } from "@supabase/supabase-js";
import { updateUser } from "./users";

export const dbCheckUserCode = async (
    supabase: SupabaseClient,
    userCode: string,
) => {
    const { data, error } = await supabase
        .from("devices")
        .select("*")
        .eq("user_code", userCode)
        .maybeSingle();

    if (error) {
        throw error;
    }
    return !!data;
};

export const updateDevice = async (
    supabase: SupabaseClient,
    device: Partial<IDevice>,
    device_id: string,
) => {
    const { error } = await supabase.from("devices").update(device).eq(
        "device_id",
        device_id,
    );
    if (error) {
        throw error;
    }
};

export const addUserToDevice = async (
    supabase: SupabaseClient,
    userCode: string,
    userId: string,
) => {
    const { data, error } = await supabase
        .from("devices")
        .update({ user_id: userId })
        .eq("user_code", userCode)
        .select("*")
        .maybeSingle();

    if (error) {
        return false;
    }

    if (data) {
        await updateUser(supabase, { device_id: data.device_id }, userId);
    }

    return true;
};

export const doesUserHaveADevice = async (
    supabase: SupabaseClient,
    userId: string,
) => {
    const { data, error } = await supabase
        .from("devices")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return !!data;
};

function generateUserCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

export const getDeviceByMac = async (
    supabase: SupabaseClient,
    macAddress: string,
) => {
    const { data, error } = await supabase
        .from("devices")
        .select("*")
        .eq("mac_address", macAddress)
        .maybeSingle();

    if (error) {
        throw error;
    }
    return data;
};

export const createDevice = async (
    supabase: SupabaseClient,
    macAddress: string,
) => {
    const userCode = generateUserCode();
    const { data, error } = await supabase
        .from("devices")
        .insert({ mac_address: macAddress, user_code: userCode })
        .select("*")
        .single();

    if (error) {
        throw error;
    }
    return data;
};

export const addUserToDeviceByMac = async (
    supabase: SupabaseClient,
    macAddress: string,
    userId: string,
) => {
    const { data, error } = await supabase
        .from("devices")
        .update({ user_id: userId })
        .eq("mac_address", macAddress)
        .is("user_id", null)
        .select("*")
        .maybeSingle();

    if (error) {
        return false;
    }

    if (data) {
        await updateUser(supabase, { device_id: data.device_id }, userId);
    }

    return !!data;
};

export const unbindDevice = async (
    supabase: SupabaseClient,
    deviceId: string,
    userId: string,
) => {
    const { error: deviceError } = await supabase
        .from("devices")
        .update({ user_id: null })
        .eq("device_id", deviceId);

    if (deviceError) {
        throw deviceError;
    }

    await updateUser(supabase, { device_id: null }, userId);
};
