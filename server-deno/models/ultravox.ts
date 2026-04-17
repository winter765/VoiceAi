import { appendFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import type { RawData } from "npm:@types/ws";
import { WebSocket } from "npm:ws";
import { addConversation, getDeviceInfo, getChatHistory } from "../supabase.ts";
import { createOpusPacketizer, createOpusDecoder, isDev, ultravoxApiKey } from "../utils.ts";
import { sessionManager } from "../session-manager.ts";
import { CHEF_PERSONALITY_KEY, chefTools, classifyNavigationIntent } from "../prompts/chef.ts";
import { getOrGenerateReminderAudio } from "../services/tts.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js";

/**
 * Detect language from text (Chinese vs English)
 */
function detectLanguage(text: string): 'zh' | 'en' {
    if (!text || text.length === 0) return 'en';
    const chineseChars = text.match(/[\u4e00-\u9fa5]/g)?.length || 0;
    return chineseChars / text.length > 0.2 ? 'zh' : 'en';
}

/**
 * Get active recipe session from database
 */
async function getActiveRecipeSession(supabase: SupabaseClient, deviceId: string, userId: string) {
    try {
        const { data, error } = await supabase
            .from('recipe_sessions')
            .select('*')
            .eq('device_id', deviceId)
            .eq('status', 'active')
            .order('updated_at', { ascending: false })
            .limit(1)
            .single();

        if (error || !data) return null;

        // Check if session is not expired
        if (new Date(data.expires_at) < new Date()) {
            // Mark as expired
            await supabase
                .from('recipe_sessions')
                .update({ status: 'completed' })
                .eq('id', data.id);
            return null;
        }

        return data;
    } catch (e) {
        console.error('[CHEF] Error getting active recipe session:', e);
        return null;
    }
}

/**
 * Save or update recipe session in database
 */
async function saveRecipeSession(
    supabase: SupabaseClient,
    deviceId: string,
    userId: string,
    recipeName: string,
    steps: string[],
    currentStep: number,
    sessionLanguage: string,
    existingSessionId?: string
) {
    try {
        if (existingSessionId) {
            // Update existing session
            const { error } = await supabase
                .from('recipe_sessions')
                .update({
                    current_step: currentStep,
                    session_language: sessionLanguage,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', existingSessionId);

            if (error) throw error;
            console.log(`[CHEF] Updated recipe session ${existingSessionId}`);
        } else {
            // Create new session
            const { error } = await supabase
                .from('recipe_sessions')
                .insert({
                    device_id: deviceId,
                    user_id: userId,
                    recipe_name: recipeName,
                    total_steps: steps.length,
                    current_step: currentStep,
                    steps: steps,
                    session_language: sessionLanguage,
                    status: 'active',
                });

            if (error) throw error;
            console.log(`[CHEF] Created new recipe session for ${recipeName}`);
        }
    } catch (e) {
        console.error('[CHEF] Error saving recipe session:', e);
    }
}

/**
 * Generate chef welcome back message based on active recipe and language
 * This is sent as user message to trigger AI greeting
 * Keep it brief - just mention current step, don't explain content
 */
function generateChefWelcomeBack(
    recipeName: string,
    currentStep: number,
    totalSteps: number,
    language: 'zh' | 'en'
): string {
    // This prompt tells AI what to say - brief greeting only, no step explanation
    if (language === 'zh') {
        return `用户回来了。简短欢迎并告诉他们当前在${recipeName}第${currentStep}步（共${totalSteps}步），可以说"重复"听这步内容或"下一步"继续。不要解释步骤内容！`;
    } else {
        return `User is back. Briefly welcome and tell them they're on step ${currentStep} of ${totalSteps} of ${recipeName}. They can say "repeat" to hear step content or "next" to continue. Do NOT explain the step content!`;
    }
}

// In-memory storage for active timers and recipe sessions (per device)
// In production, consider using Redis or database for persistence
const deviceTimers = new Map<string, Map<string, {
    name: string;
    durationSeconds: number;
    reminderPhrase: string;
    startTime: number;
}>>();

// Timer expiration grace period (5 minutes after timer ends)
const TIMER_EXPIRATION_GRACE_MS = 5 * 60 * 1000;

/**
 * Clean up expired timers for a device
 * A timer is expired if: now > startTime + durationSeconds + grace period
 */
function cleanupExpiredTimers(deviceId: string): number {
    const timers = deviceTimers.get(deviceId);
    if (!timers) return 0;

    const now = Date.now();
    let cleanedCount = 0;

    for (const [timerName, timer] of timers.entries()) {
        const expirationTime = timer.startTime + (timer.durationSeconds * 1000) + TIMER_EXPIRATION_GRACE_MS;
        if (now > expirationTime) {
            timers.delete(timerName);
            cleanedCount++;
            console.log(`[CHEF] Cleaned up expired timer: ${timerName} (expired ${Math.floor((now - expirationTime) / 1000 / 60)} minutes ago)`);
        }
    }

    // Clean up empty device entry
    if (timers.size === 0) {
        deviceTimers.delete(deviceId);
    }

    return cleanedCount;
}

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
 * Returns { captureTimerAudio: string | null } to signal if audio capture should start
 */
async function handleToolCall(
    event: any,
    uvWs: WebSocket,
    espWs: WebSocket,
    deviceId: string,
    supabase: SupabaseClient,
    userId: string,
    detectedLanguage: 'zh' | 'en' = 'en'
): Promise<{ captureTimerAudio: string | null }> {
    const { toolName, invocationId, parameters } = event;

    console.log(`[CHEF] Tool call: ${toolName}`, parameters);

    let result: any = { success: true };
    let captureTimerAudio: string | null = null;

    try {
        switch (toolName) {
            case "set_timer": {
                const { timer_name, duration_seconds, reminder_phrase } = parameters;

                // Clean up expired timers first
                cleanupExpiredTimers(deviceId);

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

                // Send timer command to ESP32
                espWs.send(JSON.stringify({
                    type: "server",
                    msg: "TIMER.SET",
                    timer_name,
                    duration_seconds,
                    reminder_phrase,
                }));

                console.log(`[CHEF] Timer set: ${timer_name} for ${duration_seconds}s`);
                result = {
                    success: true,
                    message: `Timer "${timer_name}" set for ${Math.floor(duration_seconds / 60)} minutes ${duration_seconds % 60} seconds`
                };
                // Signal to capture this response's audio for the timer
                captureTimerAudio = timer_name;
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
                // Clean up expired timers before listing
                const cleanedCount = cleanupExpiredTimers(deviceId);
                if (cleanedCount > 0) {
                    console.log(`[CHEF] Cleaned ${cleanedCount} expired timers before listing`);
                }

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

                // Store recipe session in memory
                deviceRecipeSessions.set(deviceId, {
                    recipeName: recipe_name,
                    steps: steps,
                    currentStep: 1,
                });

                // Save to database for persistence across sessions
                await saveRecipeSession(
                    supabase,
                    deviceId,
                    userId,
                    recipe_name,
                    steps,
                    1,
                    detectedLanguage
                );

                // Send recipe session to ESP32 for local navigation
                espWs.send(JSON.stringify({
                    type: "server",
                    msg: "RECIPE.SESSION",
                    recipe_name,
                    total_steps: steps.length,
                    current_step: 1,
                }));

                console.log(`[CHEF] Recipe session saved: ${recipe_name} with ${steps.length} steps (lang: ${detectedLanguage})`);
                result = {
                    success: true,
                    message: `Recipe "${recipe_name}" saved with ${steps.length} steps`
                };
                break;
            }

            case "update_recipe_step": {
                const { step_number } = parameters;
                const session = deviceRecipeSessions.get(deviceId);

                if (!session) {
                    result = { success: false, error: "No active recipe session" };
                    break;
                }

                // Validate step number
                if (step_number < 1 || step_number > session.steps.length) {
                    result = { success: false, error: `Invalid step number. Must be 1-${session.steps.length}` };
                    break;
                }

                // Skip if step is already the requested step (prevent double-update from server-side handling)
                if (session.currentStep === step_number) {
                    console.log(`[CHEF] Step already at ${step_number}, skipping duplicate update`);
                    result = {
                        success: true,
                        message: `Already on step ${step_number} of ${session.steps.length}`
                    };
                    break;
                }

                // Update in-memory session
                session.currentStep = step_number;

                // Update database
                try {
                    const { data } = await supabase
                        .from('recipe_sessions')
                        .select('id')
                        .eq('device_id', deviceId)
                        .eq('status', 'active')
                        .order('updated_at', { ascending: false })
                        .limit(1)
                        .single();

                    if (data?.id) {
                        await supabase
                            .from('recipe_sessions')
                            .update({ current_step: step_number })
                            .eq('id', data.id);
                    }
                } catch (e) {
                    console.error('[CHEF] Error updating recipe step in DB:', e);
                }

                // Notify ESP32
                espWs.send(JSON.stringify({
                    type: "server",
                    msg: "RECIPE.STEP",
                    current_step: step_number,
                    total_steps: session.steps.length,
                }));

                console.log(`[CHEF] Recipe step updated: ${step_number}/${session.steps.length}`);
                result = {
                    success: true,
                    message: `Now on step ${step_number} of ${session.steps.length}`
                };
                break;
            }

            case "complete_recipe": {
                const session = deviceRecipeSessions.get(deviceId);

                if (!session) {
                    result = { success: false, error: "No active recipe session" };
                    break;
                }

                const completedRecipeName = session.recipeName;

                // Clear in-memory session
                deviceRecipeSessions.delete(deviceId);

                // Mark as completed in database
                try {
                    const { data } = await supabase
                        .from('recipe_sessions')
                        .select('id')
                        .eq('device_id', deviceId)
                        .eq('status', 'active')
                        .order('updated_at', { ascending: false })
                        .limit(1)
                        .single();

                    if (data?.id) {
                        await supabase
                            .from('recipe_sessions')
                            .update({ status: 'completed' })
                            .eq('id', data.id);
                    }
                } catch (e) {
                    console.error('[CHEF] Error completing recipe in DB:', e);
                }

                // Notify ESP32
                espWs.send(JSON.stringify({
                    type: "server",
                    msg: "RECIPE.COMPLETE",
                    recipe_name: completedRecipeName,
                }));

                console.log(`[CHEF] Recipe completed: ${completedRecipeName}`);
                result = {
                    success: true,
                    message: `Recipe "${completedRecipeName}" completed! Congratulations!`
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

    return { captureTimerAudio };
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
    // Clean up expired timers first
    cleanupExpiredTimers(deviceId);

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
    let sessionDetectedLanguage: 'zh' | 'en' = 'en';  // Detected from conversation history

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
    let lastOutputTranscript = ""; // Track last response to detect duplicates
    let lastUserTranscript = ""; // Track last user input to allow legitimate repeats
    let suspectedDuplicate = false; // Flag for potential duplicate response
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

        // Clean up expired timers at session start (for Chef mode)
        if (isChefMode) {
            const cleanedCount = cleanupExpiredTimers(deviceId);
            if (cleanedCount > 0) {
                console.log(`[CHEF] Cleaned ${cleanedCount} expired timers at session start`);
            }
        }

        // Determine firstMessage based on context (Chef mode: check for active recipe)
        let sessionFirstMessage = firstMessage;

        if (isChefMode) {
            try {
                // 1. Detect language from recent conversations
                const recentHistory = await getChatHistory(supabase, user.user_id, personalityKey, false);
                if (recentHistory && recentHistory.length > 0) {
                    const userMessages = recentHistory
                        .filter((c: any) => c.role === 'user')
                        .map((c: any) => c.content)
                        .join(' ');
                    sessionDetectedLanguage = detectLanguage(userMessages);
                    console.log(`[CHEF] Detected language: ${sessionDetectedLanguage} (from ${recentHistory.length} messages)`);
                }

                // 2. Check for active recipe session
                const activeRecipe = await getActiveRecipeSession(supabase, deviceId, user.user_id);
                if (activeRecipe) {
                    // Use saved language if available, otherwise use detected
                    const recipeLanguage = (activeRecipe.session_language === 'zh' ? 'zh' : 'en') as 'zh' | 'en';
                    sessionDetectedLanguage = recipeLanguage || sessionDetectedLanguage;
                    sessionFirstMessage = generateChefWelcomeBack(
                        activeRecipe.recipe_name,
                        activeRecipe.current_step,
                        activeRecipe.total_steps,
                        sessionDetectedLanguage
                    );
                    console.log(`[CHEF] Active recipe found: ${activeRecipe.recipe_name}, step ${activeRecipe.current_step}/${activeRecipe.total_steps}`);

                    // Restore in-memory session
                    deviceRecipeSessions.set(deviceId, {
                        recipeName: activeRecipe.recipe_name,
                        steps: activeRecipe.steps as string[],
                        currentStep: activeRecipe.current_step,
                    });
                }
            } catch (e) {
                console.error("[CHEF] Error checking recipe session:", e);
                // Continue with default firstMessage
            }
        }

        let callData: UltravoxCallResponse;
        try {
            callData = await createUltravoxCall({
                systemPrompt,
                voice,
                firstMessage: sessionFirstMessage,
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
        const sessionStartTime = Date.now();  // Track session start for barge-in protection
        const BARGE_IN_PROTECTION_MS = 2000;  // Ignore user_speech_started for first 2 seconds

        // Timer audio capture state
        // Strategy: Buffer ALL response audio, then associate with timer if set_timer was called
        let responseAudioBuffer: Buffer[] = [];  // Buffer all audio in current response
        let pendingTimerName: string | null = null;  // Timer name to associate with buffered audio

        // Echo filtering: track when AI finishes speaking to filter echo transcripts
        // Initialize to now so first response after wake-up is also protected
        let lastAgentSpeechEndTime = Date.now();
        const ECHO_FILTER_WINDOW_MS = 2000;  // Filter suspicious transcripts within 2s of AI speech end

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

                    // Buffer audio for potential timer capture (start of new response)
                    responseAudioBuffer.push(Buffer.from(data));
                    if (responseAudioBuffer.length === 1) {
                        console.log(`[DEBUG] Started buffering audio for response`);
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
                // Buffer audio for potential timer capture
                responseAudioBuffer.push(Buffer.from(data));
                if (responseAudioBuffer.length % 100 === 0) {
                    console.log(`[DEBUG] Audio buffer: ${responseAudioBuffer.length} chunks, pendingTimer=${pendingTimerName}`);
                }

                if (!createdAcked) {
                    // Still waiting for RESPONSE.CREATED to finish sending, buffer the PCM
                    pcmQueue.push(Buffer.from(data));
                    return;
                }

                // If capturing timer audio, DON'T send to ESP32 (silent capture)
                // User will only hear the confirmation before tool call, not the reminder phrase
                if (pendingTimerName) {
                    // Audio is buffered above, but not sent to ESP32
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
                            lastAgentSpeechEndTime = Date.now();  // Track when AI finishes for echo filtering
                            opus.flush(true);
                            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                            createdSent = false;
                            createdAcked = false;
                            outputTranscript = "";
                            waitingForNewTurn = true; // Wait for AI to start new response before sending RESPONSE.CREATED
                            console.log("[DEBUG] Set waitingForNewTurn=true, ignoring audio until new turn starts");

                            // Also send timer audio if pending (state change instead of agent_audio_done)
                            if (pendingTimerName && responseAudioBuffer.length > 0) {
                                const timerName = pendingTimerName;
                                const pcmBuffer = Buffer.concat(responseAudioBuffer);
                                console.log(`[CHEF] State→listening: Captured ${pcmBuffer.length} bytes PCM for timer "${timerName}" (${responseAudioBuffer.length} chunks)`);

                                try {
                                    const opusPackets: Buffer[] = [];
                                    const timerEncoder = createOpusPacketizer((packet) => {
                                        const lengthPrefix = Buffer.alloc(2);
                                        lengthPrefix.writeUInt16LE(packet.length, 0);
                                        opusPackets.push(Buffer.concat([lengthPrefix, Buffer.from(packet)]));
                                    });
                                    timerEncoder.push(pcmBuffer);
                                    timerEncoder.flush(true);
                                    timerEncoder.close();

                                    if (opusPackets.length > 0) {
                                        const opusAudio = Buffer.concat(opusPackets);
                                        ws.send(JSON.stringify({
                                            type: "server",
                                            msg: "TIMER.AUDIO",
                                            timer_name: timerName,
                                            audio_base64: opusAudio.toString("base64"),
                                            audio_size: opusAudio.length,
                                        }));
                                        console.log(`[CHEF] Sent ${opusAudio.length} bytes Opus audio for timer "${timerName}" (${opusPackets.length} packets)`);
                                    }
                                } catch (err) {
                                    console.error(`[CHEF] Failed to encode timer audio:`, err);
                                }
                            }

                            // Reset audio buffer
                            responseAudioBuffer = [];
                            pendingTimerName = null;
                        } else if (event.state === "thinking" || event.state === "speaking") {
                            // AI is starting a new turn
                            waitingForNewTurn = false;
                            // Check if this might be a duplicate (echo-triggered) response
                            // If AI starts speaking very quickly after listening and no meaningful user input
                            const timeSinceListening = Date.now() - lastAgentSpeechEndTime;
                            if (timeSinceListening < 1500 && !lastUserTranscript) {
                                suspectedDuplicate = true;
                                console.log(`[UV] Suspected duplicate response (${timeSinceListening}ms after listening, no user input)`);
                            } else {
                                suspectedDuplicate = false;
                            }
                            // Note: Don't reset buffer here - audio packets may have already arrived
                        }
                        break;

                    case "transcript":
                        console.log("[UV] transcript:", event.role, "final:", event.final, "text:", event.text);
                        if (event.role === "agent" && event.final) {
                            outputTranscript = event.text || "";
                            if (outputTranscript) {
                                // Detect duplicate responses (echo-triggered)
                                const isDuplicate = outputTranscript.trim() === lastOutputTranscript.trim();
                                if (isDuplicate) {
                                    console.log(`[UV] DUPLICATE response detected, skipping: "${outputTranscript.substring(0, 50)}..."`);
                                    // Don't send duplicate to ESP32 or save to database
                                } else {
                                    ws.send(JSON.stringify({ type: "server", msg: "TRANSCRIPT.ASSISTANT", text: outputTranscript }));
                                    addConversation(supabase, "assistant", outputTranscript, user);
                                    lastOutputTranscript = outputTranscript;
                                }
                            }
                        } else if (event.role === "user" && event.final) {
                            const userText = event.text || "";
                            if (userText) {
                                // Filter out echo/noise transcripts shortly after AI finishes speaking
                                // Common patterns from AEC failures: short English/Korean phrases when user speaks Chinese
                                const timeSinceAgentSpeech = Date.now() - lastAgentSpeechEndTime;
                                const inEchoWindow = timeSinceAgentSpeech < ECHO_FILTER_WINDOW_MS;

                                const echoPatterns = [
                                    /^(thank you|thanks|yeah|yes|ok|okay|bye|hi|hello|no|um|uh|oh|ah)\.?$/i,
                                    /^네.*수고/,  // Korean "thank you for your work"
                                    /^감사/,      // Korean "thanks"
                                    /^[a-z\s,.!?]{1,20}$/i,  // Very short English only (no Chinese)
                                ];
                                const matchesEchoPattern = echoPatterns.some(p => p.test(userText.trim()));

                                // Only filter if within echo window AND matches echo pattern
                                if (inEchoWindow && matchesEchoPattern) {
                                    console.log(`[UV] Filtered likely echo (${timeSinceAgentSpeech}ms after AI): "${userText}"`);
                                    lastUserTranscript = ""; // Echo doesn't count as user input
                                } else {
                                    ws.send(JSON.stringify({ type: "server", msg: "TRANSCRIPT.USER", text: userText }));
                                    addConversation(supabase, "user", userText, user);
                                    lastUserTranscript = userText; // Save meaningful user input

                                    // Chef mode: Server-side navigation command handling
                                    // This bypasses AI's unreliable tool calling during barge-in
                                    if (isChefMode) {
                                        const session = deviceRecipeSessions.get(deviceId);
                                        if (session) {
                                            const intent = classifyNavigationIntent(userText);
                                            console.log(`[CHEF] Navigation intent: "${intent}" for "${userText}"`);

                                            if (intent === "next" && session.currentStep < session.steps.length) {
                                                // Server-side step update
                                                const newStep = session.currentStep + 1;
                                                session.currentStep = newStep;
                                                console.log(`[CHEF] Server-side step update: ${newStep}/${session.steps.length}`);

                                                // Update database
                                                supabase
                                                    .from('recipe_sessions')
                                                    .select('id')
                                                    .eq('device_id', deviceId)
                                                    .eq('status', 'active')
                                                    .order('updated_at', { ascending: false })
                                                    .limit(1)
                                                    .single()
                                                    .then(({ data }) => {
                                                        if (data?.id) {
                                                            supabase
                                                                .from('recipe_sessions')
                                                                .update({ current_step: newStep })
                                                                .eq('id', data.id)
                                                                .then(() => console.log(`[CHEF] DB step updated to ${newStep}`));
                                                        }
                                                    });

                                                // Notify ESP32
                                                ws.send(JSON.stringify({
                                                    type: "server",
                                                    msg: "RECIPE.STEP",
                                                    current_step: newStep,
                                                    total_steps: session.steps.length,
                                                }));
                                                // Note: Removed input_text_message - it was being treated as user input
                                                // AI will use update_recipe_step tool call instead
                                            } else if (intent === "repeat") {
                                                // Just log - AI will handle based on user's "repeat" command
                                                console.log(`[CHEF] User requested repeat of step ${session.currentStep}`);
                                            } else if (intent === "prev" && session.currentStep > 1) {
                                                // Server-side previous step
                                                const newStep = session.currentStep - 1;
                                                session.currentStep = newStep;
                                                console.log(`[CHEF] Server-side step back: ${newStep}/${session.steps.length}`);

                                                // Update database
                                                supabase
                                                    .from('recipe_sessions')
                                                    .select('id')
                                                    .eq('device_id', deviceId)
                                                    .eq('status', 'active')
                                                    .order('updated_at', { ascending: false })
                                                    .limit(1)
                                                    .single()
                                                    .then(({ data }) => {
                                                        if (data?.id) {
                                                            supabase
                                                                .from('recipe_sessions')
                                                                .update({ current_step: newStep })
                                                                .eq('id', data.id);
                                                        }
                                                    });

                                                // Notify ESP32
                                                ws.send(JSON.stringify({
                                                    type: "server",
                                                    msg: "RECIPE.STEP",
                                                    current_step: newStep,
                                                    total_steps: session.steps.length,
                                                }));
                                                // Note: Removed input_text_message - AI will use update_recipe_step tool
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        break;

                    case "agent_audio_done":
                        console.log(`[DEBUG] agent_audio_done → pendingTimerName=${pendingTimerName}, bufferChunks=${responseAudioBuffer.length}`);
                        lastAgentSpeechEndTime = Date.now();  // Track when AI finishes for echo filtering
                        lastUserTranscript = ""; // Clear for next turn
                        suspectedDuplicate = false; // Reset
                        opus.flush(true);
                        ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                        createdSent = false;
                        createdAcked = false;
                        outputTranscript = "";

                        // Send buffered audio to ESP32 if a timer was set during this response
                        if (pendingTimerName && responseAudioBuffer.length > 0) {
                            const timerName = pendingTimerName;
                            const pcmBuffer = Buffer.concat(responseAudioBuffer);
                            console.log(`[CHEF] Captured ${pcmBuffer.length} bytes PCM for timer "${timerName}" (${responseAudioBuffer.length} chunks)`);

                            // Encode to Opus with length prefix for each packet
                            try {
                                const opusPackets: Buffer[] = [];
                                const timerEncoder = createOpusPacketizer((packet) => {
                                    // Add 2-byte length prefix (little-endian) for ESP32 to parse
                                    const lengthPrefix = Buffer.alloc(2);
                                    lengthPrefix.writeUInt16LE(packet.length, 0);
                                    opusPackets.push(Buffer.concat([lengthPrefix, Buffer.from(packet)]));
                                });
                                timerEncoder.push(pcmBuffer);
                                timerEncoder.flush(true);
                                timerEncoder.close();

                                if (opusPackets.length > 0) {
                                    const opusAudio = Buffer.concat(opusPackets);
                                    ws.send(JSON.stringify({
                                        type: "server",
                                        msg: "TIMER.AUDIO",
                                        timer_name: timerName,
                                        audio_base64: opusAudio.toString("base64"),
                                        audio_size: opusAudio.length,
                                    }));
                                    console.log(`[CHEF] Sent ${opusAudio.length} bytes Opus audio for timer "${timerName}" (${opusPackets.length} packets)`);
                                }
                            } catch (err) {
                                console.error(`[CHEF] Failed to encode timer audio:`, err);
                            }
                        }
                        // Reset buffer and timer name for next response
                        responseAudioBuffer = [];
                        pendingTimerName = null;
                        break;

                    case "user_speech_started": {
                        // Protect against false barge-in at session start (noise, wake word tail)
                        const elapsed = Date.now() - sessionStartTime;
                        if (elapsed < BARGE_IN_PROTECTION_MS) {
                            console.log(`[DEBUG] user_speech_started ignored (protection window: ${elapsed}ms < ${BARGE_IN_PROTECTION_MS}ms)`);
                            break;
                        }
                        console.log("[DEBUG] user_speech_started → sending AUDIO.COMMITTED to ESP32");
                        ws.send(JSON.stringify({ type: "server", msg: "AUDIO.COMMITTED" }));
                        break;
                    }

                    case "client_tool_invocation": {
                        // Handle tool calls from Ultravox (Chef mode timers, recipe steps, etc.)
                        console.log("[UV] Tool invocation:", event.toolName, event.parameters);
                        const toolResult = await handleToolCall(event, newUvWs, ws, deviceId, supabase, user.user_id, sessionDetectedLanguage);

                        // For set_timer: clear buffer and start fresh capture (only capture audio AFTER tool call)
                        if (toolResult.captureTimerAudio) {
                            const discardedChunks = responseAudioBuffer.length;
                            responseAudioBuffer = [];  // Clear previous audio (the "OK, setting timer..." part)
                            pendingTimerName = toolResult.captureTimerAudio;
                            console.log(`[CHEF] Timer "${pendingTimerName}" - cleared ${discardedChunks} chunks, capturing audio from now`);
                        }
                        break;
                    }

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
