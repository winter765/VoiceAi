import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { getActiveFirmware } from "@/db/firmware";

interface DeviceInfo {
    version?: number;
    mac_address?: string;
    uuid?: string;
    chip_model_name?: string;
    application?: {
        name?: string;
        version?: string;
        idf_version?: string;
    };
}

function getBaseUrl(req: Request): string {
    // Use configured base URL if available
    if (process.env.NEXT_PUBLIC_BASE_URL) {
        return process.env.NEXT_PUBLIC_BASE_URL;
    }
    // Derive from request Host header
    const host = req.headers.get("host");
    if (host) {
        const proto = req.headers.get("x-forwarded-proto") || "http";
        return `${proto}://${host}`;
    }
    return "http://localhost:3000";
}

function compareVersions(current: string, latest: string): boolean {
    const parseVersion = (v: string): number[] => {
        return v.split(".").map((n) => parseInt(n, 10) || 0);
    };

    const currentParts = parseVersion(current);
    const latestParts = parseVersion(latest);

    for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
        const c = currentParts[i] || 0;
        const l = latestParts[i] || 0;
        if (l > c) return true;
        if (l < c) return false;
    }
    return false;
}

export async function POST(req: Request) {
    try {
        // Parse device info from request body
        let deviceInfo: DeviceInfo = {};
        try {
            deviceInfo = await req.json();
        } catch {
            // Empty body is okay
        }

        // Also check headers for device info
        const macAddress = req.headers.get("Device-Id") || deviceInfo.mac_address;
        const userAgent = req.headers.get("User-Agent") || "";

        // Extract current version from device info or user agent
        let currentVersion = deviceInfo.application?.version || "";
        if (!currentVersion && userAgent) {
            // User-Agent format: "elato/1.0.0 (ESP32-S3; ...)"
            const match = userAgent.match(/elato\/([0-9.]+)/i);
            if (match) {
                currentVersion = match[1];
            }
        }

        console.log(`[OTA] Check version request from ${macAddress}, current: ${currentVersion}`);

        const supabase = createClient();

        // Get board type from device info, default to bread-compact-wifi
        const boardType = "bread-compact-wifi";

        // Get active firmware version
        const firmware = await getActiveFirmware(supabase, boardType);

        // Build response
        const response: Record<string, unknown> = {};

        // Server time
        response.server_time = {
            timestamp: Date.now(),
            timezone_offset: 480, // UTC+8 (China)
        };

        // Firmware info
        if (firmware) {
            const hasNewVersion = currentVersion
                ? compareVersions(currentVersion, firmware.version)
                : true;

            // Build firmware URL
            let firmwareUrl = firmware.file_url;
            if (!firmwareUrl.startsWith("http://") && !firmwareUrl.startsWith("https://")) {
                // file_url is just a filename, use our download API
                const baseUrl = getBaseUrl(req);
                firmwareUrl = `${baseUrl}/api/ota/download/${encodeURIComponent(firmwareUrl)}`;
            }

            response.firmware = {
                version: firmware.version,
                url: firmwareUrl,
                force: firmware.force_update ? 1 : 0,
            };

            if (hasNewVersion) {
                console.log(`[OTA] New version available: ${firmware.version} (current: ${currentVersion})`);
            } else {
                console.log(`[OTA] Device is up to date: ${currentVersion}`);
            }
        }

        // WebSocket config (optional - device might already have this from auth)
        const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://35.162.7.133:8080";
        response.websocket = {
            url: wsUrl,
        };

        return NextResponse.json(response);
    } catch (error) {
        console.error("[OTA] Error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Internal server error" },
            { status: 500 },
        );
    }
}

// Also support GET for simple version checks
export async function GET(req: Request) {
    return POST(req);
}
