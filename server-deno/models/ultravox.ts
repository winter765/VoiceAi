import { appendFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import type { RawData } from "npm:@types/ws";
import { WebSocket } from "npm:ws";
import { addConversation, getDeviceInfo } from "../supabase.ts";
import { createOpusPacketizer, createOpusDecoder, isDev, ultravoxApiKey } from "../utils.ts";
import { sessionManager } from "../session-manager.ts";
import { CHEF_PERSONALITY_KEY, chefTools } from "../prompts/chef.ts";
import { getOrGenerateReminderAudio } from "../services/tts.ts";

// In-memory storage for active timers and recipe sessions (per device)
// In production, consider using Redis or database for persistence
const deviceTimers = new Map<string, Map<string, {
    name: string;
    durationSeconds: number;
    reminderPhrase: string;
    startTime: number;
}>>();

// Pending audio generation for timers (to send after TTS completes)
const pendingTimerAudio = new Map<string, {
    deviceId: string;
    timerName: string;
    espWs: WebSocket;
}>();

/**
 * Generate TTS audio for timer reminder and send to ESP32
 * Runs asynchronously to not block the main flow
 */
async function generateAndSendTimerAudio(
    espWs: WebSocket,
    timerName: string,
    reminderPhrase: string,
    deviceId: string
): Promise<void> {
    try {
        console.log(`[CHEF] Generating TTS audio for timer "${timerName}": "${reminderPhrase}"`);

        // Generate TTS audio (or get from cache)
        const opusAudio = await getOrGenerateReminderAudio(timerName, reminderPhrase);

        // Send audio to ESP32
        if (espWs.readyState === WebSocket.OPEN) {
            espWs.send(JSON.stringify({
                type: "server",
                msg: "TIMER.AUDIO",
                timer_name: timerName,
                audio_base64: opusAudio.toString("base64"),
                audio_size: opusAudio.length,
            }));

            console.log(`[CHEF] Timer audio sent for "${timerName}": ${opusAudio.length} bytes`);
        } else {
            console.log(`[CHEF] ESP32 disconnected, cannot send timer audio for "${timerName}"`);
        }
    } catch (err) {
        console.error(`[CHEF] Failed to generate timer audio for "${timerName}":`, err);
        // Timer will still work, just without custom reminder audio
        // ESP32 should have a fallback beep/default sound
    }
}

const deviceRecipeSessions = new Map<string, {
    recipeName: string;
    steps: string[];
    currentStep: number;
}>();

/**
 * Handle tool calls from Ultravox (Chef mode)
 */
function handleToolCall(
    event: any,
    uvWs: WebSocket,
    espWs: WebSocket,
    deviceId: string
) {
    const { toolName, invocationId, parameters } = event;

    console.log(`[CHEF] Tool call: ${toolName}`, parameters);

    let result: any = { success: true };

    try {
        switch (toolName) {
            case "set_timer": {
                const { timer_name, duration_seconds, reminder_phrase } = parameters;

                // Initialize device timers if needed
                if (!deviceTimers.has(deviceId)) {
                    deviceTimers.set(deviceId, new Map());
                }
                const timers = deviceTimers.get(deviceId)!;

                // Check max timers
                if (timers.size >= 5) {
                    result = { success: false, error: "Maximum 5 timers allowed" };
                    break;
                }

                // Store timer info
                timers.set(timer_name, {
                    name: timer_name,
                    durationSeconds: duration_seconds,
                    reminderPhrase: reminder_phrase,
                    startTime: Date.now(),
                });

                // Send initial timer command to ESP32 (without audio)
                espWs.send(JSON.stringify({
                    type: "server",
                    msg: "TIMER.SET",
                    timer_name,
                    duration_seconds,
                    reminder_phrase,
                }));

                // Generate TTS audio asynchronously and send to ESP32
                // This runs in background so we don't block the tool response
                generateAndSendTimerAudio(espWs, timer_name, reminder_phrase, deviceId);

                console.log(`[CHEF] Timer set: ${timer_name} for ${duration_seconds}s`);
                result = {
                    success: true,
                    message: `Timer "${timer_name}" set for ${Math.floor(duration_seconds / 60)} minutes ${duration_seconds % 60} seconds`
                };
                break;
            }

            case "cancel_timer": {
                const { timer_name } = parameters;
                const timers = deviceTimers.get(deviceId);

                if (timers?.has(timer_name)) {
                    timers.delete(timer_name);

                    // Send cancel command to ESP32
                    espWs.send(JSON.stringify({
                        type: "server",
                        msg: "TIMER.CANCEL",
                        timer_name,
                    }));

                    console.log(`[CHEF] Timer cancelled: ${timer_name}`);
                    result = { success: true, message: `Timer "${timer_name}" cancelled` };
                } else {
                    result = { success: false, error: `Timer "${timer_name}" not found` };
                }
                break;
            }

            case "list_timers": {
                const timers = deviceTimers.get(deviceId);
                const now = Date.now();

                if (!timers || timers.size === 0) {
                    result = { success: true, timers: [], message: "No active timers" };
                } else {
                    const timerList = Array.from(timers.values()).map(t => {
                        const elapsed = Math.floor((now - t.startTime) / 1000);
                        const remaining = Math.max(0, t.durationSeconds - elapsed);
                        return {
                            name: t.name,
                            remaining_seconds: remaining,
                            remaining_display: `${Math.floor(remaining / 60)}m ${remaining % 60}s`
                        };
                    });
                    result = { success: true, timers: timerList };
                }
                break;
            }

            case "save_recipe_steps": {
                const { recipe_name, steps } = parameters;

                // Store recipe session
                deviceRecipeSessions.set(deviceId, {
                    recipeName: recipe_name,
                    steps: steps,
                    currentStep: 1,
                });

                // Send recipe session to ESP32 for local navigation
                espWs.send(JSON.stringify({
                    type: "server",
                    msg: "RECIPE.SESSION",
                    recipe_name,
                    total_steps: steps.length,
                    current_step: 1,
                }));

                console.log(`[CHEF] Recipe session saved: ${recipe_name} with ${steps.length} steps`);
                result = {
                    success: true,
                    message: `Recipe "${recipe_name}" saved with ${steps.length} steps`
                };
                break;
            }

            default:
                console.log(`[CHEF] Unknown tool: ${toolName}`);
                result = { success: false, error: `Unknown tool: ${toolName}` };
        }
    } catch (err) {
        console.error(`[CHEF] Tool error:`, err);
        result = { success: false, error: String(err) };
    }

    // Send tool result back to Ultravox
    if (uvWs.readyState === WebSocket.OPEN) {
        uvWs.send(JSON.stringify({
            type: "client_tool_result",
            invocationId,
            result: JSON.stringify(result),
        }));
        console.log(`[CHEF] Tool result sent for ${toolName}:`, result);
    }
}

/**
 * Get active recipe session for a device
 */
export function getRecipeSession(deviceId: string) {
    return deviceRecipeSessions.get(deviceId) || null;
}

/**
 * Update recipe step for a device
 */
export function updateRecipeStep(deviceId: string, step: number) {
    const session = deviceRecipeSessions.get(deviceId);
    if (session) {
        session.currentStep = step;
    }
}

/**
 * Clear recipe session for a device
 */
export function clearRecipeSession(deviceId: string) {
    deviceRecipeSessions.delete(deviceId);
}

/**
 * Get active timers for a device
 */
export function getActiveTimers(deviceId: string) {
    const timers = deviceTimers.get(deviceId);
    if (!timers) return [];

    const now = Date.now();
    return Array.from(timers.values()).map(t => {
        const elapsed = Math.floor((now - t.startTime) / 1000);
        const remaining = Math.max(0, t.durationSeconds - elapsed);
        return {
            name: t.name,
            remainingSeconds: remaining,
        };
    });
}

// Heartbeat configuration
const HEARTBEAT_INTERVAL_MS = 30000;  // 30 seconds
const HEARTBEAT_TIMEOUT_MS = 5000;    // 5 seconds to wait for pong
const MAX_MISSED_HEARTBEATS = 2;      // Close after 2 missed heartbeats

const ULTRAVOX_API_URL = "https://api.ultravox.ai/api/calls";

interface UltravoxCallResponse {
    callId: string;
    joinUrl: string;
    [key: string]: any;
}

interface CreateUltravoxCallOptions {
    systemPrompt: string;
    voice: string;
    firstMessage: string;
    tools?: any[];  // Ultravox tool definitions
}

async function createUltravoxCall(
    options: CreateUltravoxCallOptions
): Promise<UltravoxCallResponse> {
    const { systemPrompt, voice, firstMessage, tools } = options;

    if (!ultravoxApiKey) {
        throw new Error("ULTRAVOX_API_KEY is not set");
    }

    const body: any = {
        model: "fixie-ai/ultravox",
        systemPrompt,
        voice,
        medium: {
            serverWebSocket: {
                inputSampleRate: 16000,
                outputSampleRate: 24000,
            },
        },
    };

    if (firstMessage) {
        body.firstSpeaker = "FIRST_SPEAKER_AGENT";
        body.initialMessages = [
            { role: "MESSAGE_ROLE_USER", text: firstMessage },
        ];
    }

    // Add tools if provided (for Chef mode, etc.)
    if (tools && tools.length > 0) {
        body.selectedTools = tools;
        console.log(`[UV] Creating call with ${tools.length} tools`);
    }

    const response = await fetch(ULTRAVOX_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": ultravoxApiKey,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ultravox API error (${response.status}): ${errorText}`);
    }

    return await response.json();
}

export const connectToUltravox = async ({
    ws,
    payload,
    connectionPcmFile,
    firstMessage,
    systemPrompt,
    closeHandler,
}: ProviderArgs) => {
    const { user, supabase } = payload;

    if (!ultravoxApiKey) {
        throw new Error("ULTRAVOX_API_KEY is not set");
    }

    const voice = payload.user.personality?.oai_voice || "Mark";

    // Get device ID (prefer MAC address, fallback to device_id)
    const deviceId = user.device?.mac_address || user.device_id || "unknown";
    console.log(`[UV] Device ID: ${deviceId}`);

    // Check if this is Chef mode (by personality key)
    const personalityKey = user.personality?.key;
    const isChefMode = personalityKey === CHEF_PERSONALITY_KEY;
    const tools = isChefMode ? chefTools : undefined;
    if (isChefMode) {
        console.log(`[UV] Chef mode enabled for device ${deviceId}`);
    }

    // Pre-fetch device info at connection start to avoid latency during audio playback
    let cachedVolume = 100;
    getDeviceInfo(supabase, user.user_id).then(device => {
        cachedVolume = device?.volume ?? 100;
        console.log(`[UV] Device info cached: volume=${cachedVolume}`);
    }).catch(() => {
        console.log("[UV] Failed to fetch device info, using default volume");
    });

    // --- On-demand session state ---
    let uvWs: WebSocket | null = null;
    let isSessionActive = false;

    // --- Heartbeat state ---
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
    let missedHeartbeats = 0;
    let isAlive = true;

    // Cleanup function for SessionManager
    const cleanup = () => {
        console.log(`[UV] Cleanup called for device ${deviceId}`);
        stopHeartbeat();
        stopSession();
        try {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        } catch (e) {
            console.error(`[UV] Error closing WebSocket:`, e);
        }
    };

    // Register session with SessionManager (will auto-close existing session for this device)
    sessionManager.register(deviceId, {
        deviceId,
        callId: null,
        ws,
        uvWs: null,
        cleanup,
    });

    // --- Heartbeat functions ---
    function startHeartbeat() {
        stopHeartbeat(); // Clear any existing
        missedHeartbeats = 0;
        isAlive = true;

        heartbeatInterval = setInterval(() => {
            if (!isAlive) {
                missedHeartbeats++;
                console.log(`[UV] Heartbeat missed for device ${deviceId}, count: ${missedHeartbeats}`);
                if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
                    console.log(`[UV] Device ${deviceId} unresponsive, closing session`);
                    stopHeartbeat();
                    stopSession();
                    sessionManager.unregister(deviceId);
                    try {
                        ws.terminate();
                    } catch (e) {
                        console.error(`[UV] Error terminating WebSocket:`, e);
                    }
                    return;
                }
            }
            isAlive = false;
            try {
                ws.ping();
            } catch (e) {
                console.error(`[UV] Error sending ping:`, e);
            }
        }, HEARTBEAT_INTERVAL_MS);

        console.log(`[UV] Heartbeat started for device ${deviceId}`);
    }

    function stopHeartbeat() {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        if (heartbeatTimeout) {
            clearTimeout(heartbeatTimeout);
            heartbeatTimeout = null;
        }
    }

    // Listen for pong responses
    ws.on("pong", () => {
        isAlive = true;
        missedHeartbeats = 0;
        sessionManager.updateActivity(deviceId);
    });

    // Start heartbeat monitoring
    startHeartbeat();
    let createdSent = false;
    let createdAcked = false; // true after RESPONSE.CREATED text msg is actually sent
    let waitingForNewTurn = false; // true after AI finishes speaking, waiting for user to speak
    let outputTranscript = "";
    let audioPacketCount = 0;
    let totalAudioBytes = 0;

    // Opus decoder for input audio from ESP32 (16kHz)
    const inputDecoder = createOpusDecoder();
    let decodedPcmBytes = 0;

    let opusPacketsSent = 0;
    const opus = createOpusPacketizer((packet) => {
        opusPacketsSent++;
        if (opusPacketsSent <= 5 || opusPacketsSent % 10 === 1) {
            console.log(`[AUDIO-DIAG] Opus→ESP32: packet #${opusPacketsSent}, size=${packet.length}B, first4bytes=[${Array.from(packet.slice(0, 4)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(',')}]`);
        }
        ws.send(packet);
    });

    const sendResponseCreated = () => {
        console.log("[DEBUG] Sending RESPONSE.CREATED to ESP32");
        opus.reset();
        // Use pre-cached volume to avoid DB query latency
        ws.send(JSON.stringify({
            type: "server",
            msg: "RESPONSE.CREATED",
            volume_control: cachedVolume,
        }));
        createdAcked = true;
        console.log(`[DEBUG] RESPONSE.CREATED sent, createdAcked=true, volume=${cachedVolume}`);
    };

    // Start a new Ultravox call session
    async function startSession() {
        if (isSessionActive) {
            console.log("[UV] Session already active, ignoring START_SESSION");
            return;
        }

        console.log("[UV] START_SESSION: Creating Ultravox call...");
        let callData: UltravoxCallResponse;
        try {
            callData = await createUltravoxCall({
                systemPrompt,
                voice,
                firstMessage,
                tools,
            });
            console.log(`[UV] Ultravox call created: ${callData.callId}`);
        } catch (e) {
            console.error("[UV] Failed to create Ultravox call:", e);
            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
            return;
        }

        // Reset per-session state
        createdSent = false;
        outputTranscript = "";
        opusPacketsSent = 0;
        opus.reset();

        // Connect to Ultravox joinUrl
        const newUvWs = new WebSocket(callData.joinUrl);
        uvWs = newUvWs;
        isSessionActive = true;

        // Update SessionManager with Ultravox call info
        sessionManager.updateUltravoxInfo(deviceId, callData.callId, newUvWs);

        let uvAudioChunks = 0;
        let uvAudioBytes = 0;

        newUvWs.on("open", () => {
            console.log("[UV] Connected to Ultravox WebSocket");
        });

        const pcmQueue: Buffer[] = []; // Buffer PCM chunks until RESPONSE.CREATED is acked

        newUvWs.on("message", async (data: Buffer, isBinary: boolean) => {
            // Guard: if session was stopped, ignore late messages
            if (uvWs !== newUvWs) return;

            if (isBinary) {
                uvAudioChunks++;
                uvAudioBytes += data.length;

                // Update data activity every 50 chunks (~1 second of audio)
                if (uvAudioChunks % 50 === 0) {
                    sessionManager.updateDataActivity(deviceId);
                }

                if (uvAudioChunks % 50 === 1) {
                    console.log(`[UV] Ultravox audio: chunk #${uvAudioChunks}, size=${data.length}B, total=${uvAudioBytes}B`);
                }
                if (!createdSent) {
                    // If waiting for new turn, don't start sending audio yet
                    if (waitingForNewTurn) {
                        console.log("[DEBUG] Ignoring audio chunk while waitingForNewTurn=true");
                        return;
                    }
                    createdSent = true;
                    // Buffer this chunk, send RESPONSE.CREATED, then flush buffered PCM
                    pcmQueue.push(Buffer.from(data));
                    sendResponseCreated();
                    // Flush all buffered PCM chunks
                    while (pcmQueue.length > 0) {
                        opus.push(pcmQueue.shift()!);
                    }
                    return;
                }
                if (!createdAcked) {
                    // Still waiting for RESPONSE.CREATED to finish sending, buffer the PCM
                    pcmQueue.push(Buffer.from(data));
                    return;
                }
                opus.push(data);
                return;
            }

            let event: any;
            try {
                event = JSON.parse(data.toString("utf-8"));
            } catch {
                return;
            }

            try {
                switch (event.type) {
                    case "state":
                        console.log("[UV] state:", event.state);
                        if (event.state === "listening" && createdSent) {
                            console.log("[DEBUG] state→listening with createdSent=true → sending RESPONSE.COMPLETE");
                            opus.flush(true);
                            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                            createdSent = false;
                            createdAcked = false;
                            outputTranscript = "";
                            waitingForNewTurn = true; // Wait for AI to start new response before sending RESPONSE.CREATED
                            console.log("[DEBUG] Set waitingForNewTurn=true, ignoring audio until new turn starts");
                        } else if (event.state === "thinking" || event.state === "speaking") {
                            // AI is starting a new turn
                            waitingForNewTurn = false;
                        }
                        break;

                    case "transcript":
                        console.log("[UV] transcript:", event.role, "final:", event.final, "text:", event.text);
                        if (event.role === "agent" && event.final) {
                            outputTranscript = event.text || "";
                            if (outputTranscript) {
                                ws.send(JSON.stringify({ type: "server", msg: "TRANSCRIPT.ASSISTANT", text: outputTranscript }));
                                addConversation(supabase, "assistant", outputTranscript, user);
                            }
                        } else if (event.role === "user" && event.final) {
                            const userText = event.text || "";
                            if (userText) {
                                ws.send(JSON.stringify({ type: "server", msg: "TRANSCRIPT.USER", text: userText }));
                                addConversation(supabase, "user", userText, user);
                            }
                        }
                        break;

                    case "agent_audio_done":
                        console.log("[DEBUG] agent_audio_done → sending RESPONSE.COMPLETE to ESP32");
                        opus.flush(true);
                        ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                        createdSent = false;
                        createdAcked = false;
                        outputTranscript = "";
                        break;

                    case "user_speech_started":
                        console.log("[DEBUG] user_speech_started → sending AUDIO.COMMITTED to ESP32");
                        ws.send(JSON.stringify({ type: "server", msg: "AUDIO.COMMITTED" }));
                        break;

                    case "client_tool_invocation":
                        // Handle tool calls from Ultravox (Chef mode timers, recipe steps, etc.)
                        console.log("[UV] Tool invocation:", event.toolName, event.parameters);
                        handleToolCall(event, newUvWs, ws, deviceId);
                        break;

                    case "error":
                        console.error("[UV] Ultravox error:", event);
                        ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
                        createdSent = false;
                        createdAcked = false;
                        break;

                    default:
                        if (isDev) {
                            console.log("[UV] event:", event.type, event);
                        }
                        break;
                }
            } catch (err) {
                console.error("[UV] Error processing event:", err);
                ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
                createdSent = false;
            }
        });

        newUvWs.on("close", () => {
            console.log("[UV] Ultravox WebSocket closed");
            // If there was an active response, notify ESP32 that it's complete
            if (createdSent) {
                console.log("[DEBUG] Ultravox closed during active response, sending RESPONSE.COMPLETE to ESP32");
                opus.flush(true);
                ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                createdSent = false;
                createdAcked = false;
            }
            // Do NOT close ESP32 ws — just clean up session state
            if (uvWs === newUvWs) {
                uvWs = null;
                isSessionActive = false;
            }
        });

        newUvWs.on("error", (error: any) => {
            console.error("[UV] Ultravox WebSocket error:", error);
            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
        });
    }

    // Stop the current Ultravox call session
    function stopSession() {
        if (!isSessionActive && !uvWs) {
            console.log("[UV] No active session to stop");
            return;
        }
        console.log("[UV] STOP_SESSION: Closing Ultravox call");
        isSessionActive = false;
        createdSent = false;
        createdAcked = false;
        opus.reset();
        if (uvWs) {
            uvWs.close();
            uvWs = null;
        }
        // Notify ESP32 that session has ended so it can update state
        ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
        console.log("[UV] Sent RESPONSE.COMPLETE to ESP32 after STOP_SESSION");
    }

    // Listen for ESP32 messages (text instructions + binary audio)
    ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
            // Only forward audio when session is active
            if (isSessionActive && uvWs?.readyState === WebSocket.OPEN) {
                audioPacketCount++;
                totalAudioBytes += (data as Buffer).length;

                // Update data activity every 50 packets (~1 second of audio)
                if (audioPacketCount % 50 === 0) {
                    sessionManager.updateDataActivity(deviceId);
                }

                // Decode Opus to PCM (16kHz) before forwarding to Ultravox
                try {
                    const pcmData = inputDecoder.decode(data as Buffer);
                    decodedPcmBytes += pcmData.length;

                    if (audioPacketCount % 100 === 1) {
                        console.log(`[DEBUG] ESP32 audio: packet #${audioPacketCount}, opus=${(data as Buffer).length}B, pcm=${pcmData.length}B, totalPcm=${decodedPcmBytes}B`);
                    }

                    // Log first 5 packets with hex dump
                    if (audioPacketCount <= 5) {
                        const first8 = Array.from(pcmData.slice(0, 8)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(',');
                        console.log(`[AUDIO-IN] ESP32→UV: pkt#${audioPacketCount}, opus=${(data as Buffer).length}B, pcm=${pcmData.length}B, first8=[${first8}]`);
                    }

                    uvWs.send(Buffer.from(pcmData));

                    if (isDev && connectionPcmFile) {
                        connectionPcmFile.write(Buffer.from(pcmData));
                    }
                } catch (err) {
                    console.error("[UV] Opus decode error:", err);
                }
            }
            return;
        }

        // Text messages — parse instructions
        // Always log for debugging (UNCONDITIONAL)
        console.log(`[TEXT-IN] ESP32 text message received, len=${(data as Buffer).length}:`, (data as Buffer).toString("utf-8"));

        let message: any;
        try {
            message = JSON.parse((data as Buffer).toString("utf-8"));
        } catch {
            return;
        }

        if (message?.type !== "instruction") return;

        if (message.msg === "START_SESSION") {
            startSession();
        } else if (message.msg === "STOP_SESSION") {
            stopSession();
        } else if (message.msg === "INTERRUPT") {
            opus.reset();
        }
    });

    ws.on("error", (error: any) => {
        console.error("[UV] ESP32 WebSocket error:", error);
        stopHeartbeat();
        stopSession();
        sessionManager.unregister(deviceId);
    });

    ws.on("close", async (code: number, reason: string) => {
        console.log(`[UV] ESP32 WebSocket closed with code ${code}, reason: ${reason}`);
        console.log(`[DEBUG] Audio summary: ${audioPacketCount} packets, ${totalAudioBytes} bytes total`);
        stopHeartbeat();
        stopSession();
        sessionManager.unregister(deviceId);
        await closeHandler();
        opus.close();
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
        }
    });

    // Resolve immediately — no Ultravox connection yet, just listening for instructions
    console.log(`[UV] Ultravox handler ready for device ${deviceId}, waiting for START_SESSION`);
};
