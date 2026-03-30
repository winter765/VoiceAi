import { NextResponse } from "next/server";
import { createReadStream, statSync, existsSync } from "fs";
import { join } from "path";

// Firmware directory from environment variable
// Default to ./firmware in project root for local development
const FIRMWARE_DIR = process.env.FIRMWARE_DIR || "./firmware";

export async function GET(
    req: Request,
    { params }: { params: Promise<{ filename: string }> },
) {
    try {
        const { filename } = await params;

        // Security: prevent directory traversal
        if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
            return NextResponse.json(
                { error: "Invalid filename" },
                { status: 400 },
            );
        }

        // Only allow .bin files
        if (!filename.endsWith(".bin")) {
            return NextResponse.json(
                { error: "Only .bin files are allowed" },
                { status: 400 },
            );
        }

        const filePath = join(FIRMWARE_DIR, filename);

        // Check if file exists
        if (!existsSync(filePath)) {
            console.error(`[OTA Download] File not found: ${filePath}`);
            return NextResponse.json(
                { error: "Firmware file not found" },
                { status: 404 },
            );
        }

        // Get file stats
        const stats = statSync(filePath);
        const fileSize = stats.size;

        console.log(`[OTA Download] Serving ${filename} (${fileSize} bytes)`);

        // Read file as buffer
        const { readFileSync } = await import("fs");
        const fileBuffer = readFileSync(filePath);

        // Return file with appropriate headers
        return new NextResponse(fileBuffer, {
            status: 200,
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": fileSize.toString(),
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Cache-Control": "no-cache",
            },
        });
    } catch (error) {
        console.error("[OTA Download] Error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Internal server error" },
            { status: 500 },
        );
    }
}
