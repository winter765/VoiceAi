import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer } from "npm:ws";
import type {
    WebSocket as WSWebSocket,
    WebSocketServer as _WebSocketServer,
} from "npm:@types/ws";
import { authenticateUser } from "./utils.ts";
import {
    createFirstMessage,
    createSystemPrompt,
    getChatHistory,
    getSupabaseClient,
} from "./supabase.ts";
import { SupabaseClient } from "@supabase/supabase-js";
import { isDev } from "./utils.ts";
import { connectToOpenAI } from "./models/openai.ts";
import { connectToGemini } from "./models/gemini.ts";
import { connectToElevenLabs } from "./models/elevenlabs.ts";
import { connectToHume } from "./models/hume.ts";
import { connectToGrok } from "./models/grok.ts";
import { connectToUltravox } from "./models/ultravox.ts";
import { connectToEcho } from "./models/echo.ts";
import { sessionManager } from "./session-manager.ts";
import { usageTracker } from "./usage-tracker.ts";

// --- REST API handlers ---
async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // Handle preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return true;
    }

    // GET /api/sessions - List all sessions
    if (path === "/api/sessions" && req.method === "GET") {
        const sessions = sessionManager.getAll();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            count: sessions.length,
            sessions,
        }));
        return true;
    }

    // DELETE /api/sessions - Close all sessions
    if (path === "/api/sessions" && req.method === "DELETE") {
        const count = sessionManager.closeAll();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            success: true,
            message: `Closed ${count} sessions`,
        }));
        return true;
    }

    // DELETE /api/sessions/:deviceId - Close specific session
    const sessionMatch = path.match(/^\/api\/sessions\/(.+)$/);
    if (sessionMatch && req.method === "DELETE") {
        const deviceId = decodeURIComponent(sessionMatch[1]);
        const success = sessionManager.forceClose(deviceId);
        if (success) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                success: true,
                message: `Closed session for device ${deviceId}`,
            }));
        } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                success: false,
                message: `No session found for device ${deviceId}`,
            }));
        }
        return true;
    }

    // GET /api/usage - List active usage tracking sessions
    if (path === "/api/usage" && req.method === "GET") {
        const sessions = usageTracker.getAllSessions();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            count: sessions.length,
            sessions: sessions.map(s => ({
                deviceId: s.deviceId,
                deviceMac: s.deviceMac,
                provider: s.provider,
                sessionId: s.sessionId,
                sessionStart: s.sessionStart.toISOString(),
                audioInputMs: s.audioInputMs,
                audioOutputMs: s.audioOutputMs,
                inputBytes: s.inputBytes,
                outputBytes: s.outputBytes,
            })),
        }));
        return true;
    }

    // GET /api/usage/summary - Get usage summary from database
    if (path === "/api/usage/summary" && req.method === "GET") {
        const period = url.searchParams.get("period") || "7d";
        const supabase = getSupabaseClient();

        // Calculate date range
        let startDate = new Date();
        if (period === "1d") {
            startDate.setDate(startDate.getDate() - 1);
        } else if (period === "7d") {
            startDate.setDate(startDate.getDate() - 7);
        } else if (period === "30d") {
            startDate.setDate(startDate.getDate() - 30);
        }

        try {
            const { data, error } = await supabase
                .from("usage_logs")
                .select("*")
                .gte("session_start", startDate.toISOString())
                .order("session_start", { ascending: false });

            if (error) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: error.message }));
                return true;
            }

            // Aggregate by provider
            const byProvider: Record<string, { sessions: number; cost_usd: number; audio_input_ms: number; audio_output_ms: number }> = {};
            const byDevice: Record<string, { sessions: number; cost_usd: number }> = {};
            let totalCost = 0;

            for (const log of data || []) {
                // By provider
                if (!byProvider[log.provider]) {
                    byProvider[log.provider] = { sessions: 0, cost_usd: 0, audio_input_ms: 0, audio_output_ms: 0 };
                }
                byProvider[log.provider].sessions++;
                byProvider[log.provider].cost_usd += parseFloat(log.cost_usd) || 0;
                byProvider[log.provider].audio_input_ms += log.audio_input_ms || 0;
                byProvider[log.provider].audio_output_ms += log.audio_output_ms || 0;

                // By device
                const deviceKey = log.device_mac || log.device_id || "unknown";
                if (!byDevice[deviceKey]) {
                    byDevice[deviceKey] = { sessions: 0, cost_usd: 0 };
                }
                byDevice[deviceKey].sessions++;
                byDevice[deviceKey].cost_usd += parseFloat(log.cost_usd) || 0;

                totalCost += parseFloat(log.cost_usd) || 0;
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                period,
                start_date: startDate.toISOString(),
                end_date: new Date().toISOString(),
                total_sessions: data?.length || 0,
                total_cost_usd: totalCost.toFixed(6),
                by_provider: byProvider,
                by_device: Object.entries(byDevice).map(([mac, stats]) => ({
                    device_mac: mac,
                    ...stats,
                    cost_usd: stats.cost_usd.toFixed(6),
                })),
            }));
        } catch (e) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(e) }));
        }
        return true;
    }

    // GET /api/usage/device/:mac - Get usage for specific device
    const usageDeviceMatch = path.match(/^\/api\/usage\/device\/(.+)$/);
    if (usageDeviceMatch && req.method === "GET") {
        const deviceMac = decodeURIComponent(usageDeviceMatch[1]);
        const supabase = getSupabaseClient();

        try {
            const { data, error } = await supabase
                .from("usage_logs")
                .select("*")
                .eq("device_mac", deviceMac)
                .order("session_start", { ascending: false })
                .limit(100);

            if (error) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: error.message }));
                return true;
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                device_mac: deviceMac,
                total_sessions: data?.length || 0,
                logs: data,
            }));
        } catch (e) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(e) }));
        }
        return true;
    }

    // Not an API request
    return false;
}

const server = createServer(async (req, res) => {
    // Try to handle as API request
    if (await handleApiRequest(req, res)) {
        return;
    }

    // Default response for non-API requests
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ElatoAI WebSocket Server");
});

const wss: _WebSocketServer = new WebSocketServer({ noServer: true,
    perMessageDeflate: false,
 });

wss.on('headers', (headers, req) => {
    // You should NOT see any "Sec-WebSocket-Extensions" here
    console.log('WS response headers :', headers);
});

wss.on("connection", async (ws: WSWebSocket, payload: IPayload) => {
    const { user, supabase } = payload;

    const connectionPcmFile: Deno.FsFile | null = null;

    const chatHistory = await getChatHistory(
        supabase,
        user.user_id,
        user.personality?.key ?? null,
        false,
    );
    const firstMessage = createFirstMessage(payload);
    const systemPrompt = createSystemPrompt(chatHistory, payload);

    const provider = user.personality?.provider;

    // send user details to client
    // when DEV_MODE is true, we send the default values 100, false, false
    ws.send(
        JSON.stringify({
            type: "auth",
            volume_control: user.device?.volume ?? 100,
            is_ota: user.device?.is_ota ?? false,
            is_reset: user.device?.is_reset ?? false,
            pitch_factor: user.personality?.pitch_factor ?? 1,
        }),
    );

    // Common close handler for cleanup
    const closeHandler = async () => {
        // Add any common cleanup logic here
    };

    // Common provider args
    const providerArgs: ProviderArgs = {
        ws,
        payload,
        connectionPcmFile,
        firstMessage,
        systemPrompt,
        closeHandler,
    };

    switch (provider) {
        case "openai":
            await connectToOpenAI(providerArgs);
            break;
        case "gemini":
            await connectToGemini(providerArgs);
            break;
        case "grok":
            await connectToGrok(providerArgs);
            break;
        case "elevenlabs":
            await connectToElevenLabs(providerArgs);
            break;
        case "hume":
            await connectToHume(providerArgs);
            break;
        case "ultravox":
            await connectToUltravox(providerArgs);
            break;
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
});

server.on("upgrade", async (req, socket, head) => {
    console.log('foobar upgrade', req.headers);
    let user: IUser;
    let supabase: SupabaseClient;
    let authToken: string;
    try {
        const {
            authorization: authHeader,
            "x-wifi-rssi": rssi,
            "x-device-mac": deviceMac,
        } = req.headers;
        authToken = authHeader?.replace("Bearer ", "") ?? "";
        const wifiStrength = parseInt(rssi as string); // Convert to number

        // You can now use wifiStrength in your code
        console.log("WiFi RSSI:", wifiStrength); // Will log something like -50

        // Remove debug logging
        if (!authToken) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }

        supabase = getSupabaseClient(authToken as string);
        user = await authenticateUser(supabase, authToken as string);

        // allow any mac address for dev
        const expectedMac = user.device?.mac_address;
        if (!isDev && deviceMac && deviceMac !== expectedMac) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }
    } catch (_e: any) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, {
            user,
            supabase,
            timestamp: new Date().toISOString(),
        });
    });
});

// 启动会话超时检查器
sessionManager.startTimeoutChecker();

if (isDev) { // RUN WITH: deno run -A --env-file=.env main.ts
    const HOST = Deno.env.get("HOST") || "0.0.0.0";
    const PORT = Deno.env.get("PORT") || "8000";
    server.listen(Number(PORT), HOST, () => {
        console.log(`Audio capture server running on ws://${HOST}:${PORT}`);
    });
} else {
    server.listen(8080);
}
