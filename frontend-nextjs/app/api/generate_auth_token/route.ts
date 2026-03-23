import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { createClient } from "@/utils/supabase/server";
import { getDeviceByMac, createDevice } from "@/db/devices";

const ALGORITHM = "HS256";
const skipDeviceRegistration =
    process.env.NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION === "True";

interface TokenPayload {
    [key: string]: any;
}

const createSupabaseToken = (
    jwtSecretKey: string,
    data: TokenPayload,
    // Set expiration to null for no expiration, or use a very large number like 10 years
    expireDays: number | null = 3650, // Default to 10 years
): string => {
    const toEncode = {
        aud: "authenticated",
        role: "authenticated",
        sub: data.user_id,
        email: data.email,
        // Only include exp if expireDays is not null
        ...(expireDays && {
            exp: Math.floor(Date.now() / 1000) + (expireDays * 86400),
        }),
        user_metadata: {
            ...data,
        },
    };

    const encodedJwt = jwt.sign(toEncode, jwtSecretKey, {
        algorithm: ALGORITHM,
    });
    return encodedJwt;
};

const getUserByMacAddress = async (macAddress: string) => {
    const supabase = createClient();
    const { data, error } = await supabase.from("devices").select(
        "*, user:user_id(*)",
    ).eq("mac_address", macAddress).single();
    if (error) {
        throw new Error(error.message);
    }
    return data.user;
};

const getDevUser = async () => {
    const supabase = createClient();
    const { data, error } = await supabase.from("users").select("*").eq(
        "email",
        "admin@elatoai.com",
    ).single();
    if (error) {
        throw new Error(error.message);
    }
    return data;
};

function getBaseUrl(req: Request): string {
    if (process.env.NEXT_PUBLIC_BASE_URL) {
        return process.env.NEXT_PUBLIC_BASE_URL;
    }
    // Derive from request Host header so devices get a reachable URL
    const host = req.headers.get("host");
    if (host) {
        const proto = req.headers.get("x-forwarded-proto") || "http";
        return `${proto}://${host}`;
    }
    return "http://localhost:3000";
}

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const macAddress = searchParams.get("macAddress");

        if (!macAddress) {
            return NextResponse.json(
                { error: "MAC address is required" },
                { status: 400 },
            );
        }

        // Dev mode: skip device registration, use default admin user
        if (skipDeviceRegistration) {
            const user = await getDevUser();
            if (!user) {
                return NextResponse.json(
                    { error: "Dev user not found" },
                    { status: 500 },
                );
            }
            const token = createSupabaseToken(
                process.env.JWT_SECRET_KEY!,
                { email: user.email, user_id: user.user_id, created_time: new Date() },
                null,
            );
            return NextResponse.json({ status: "ok", token });
        }

        const supabase = createClient();

        // Look up device by MAC address
        let device = await getDeviceByMac(supabase, macAddress);

        // Device not in DB → auto-create (self-registration)
        if (!device) {
            device = await createDevice(supabase, macAddress);
        }

        // Device exists but not bound to a user → return pending status
        if (!device.user_id) {
            const registerUrl = `${getBaseUrl(req)}/register?mac=${encodeURIComponent(macAddress)}`;
            return NextResponse.json({
                status: "pending",
                user_code: device.user_code,
                register_url: registerUrl,
            });
        }

        // Device bound to user → fetch user and generate JWT
        const user = await getUserByMacAddress(macAddress);
        if (!user) {
            return NextResponse.json(
                { error: "User not found" },
                { status: 400 },
            );
        }

        const payload = {
            email: user.email,
            user_id: user.user_id,
            created_time: new Date(),
        };

        const token = createSupabaseToken(
            process.env.JWT_SECRET_KEY!,
            payload,
            null,
        );

        return NextResponse.json({ status: "ok", token });
    } catch (error) {
        return NextResponse.json(
            {
                error: error instanceof Error
                    ? error.message
                    : "Internal server error",
            },
            { status: 500 },
        );
    }
}
