/**
 * UsageTracker - AI 使用量追踪服务
 *
 * 功能：
 * - 会话开始时创建 usage_log 记录
 * - 追踪音频输入/输出的时长和字节数
 * - 会话结束时计算费用并更新记录
 */

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Opus frame duration (ms) - standard is 20ms per frame
const OPUS_FRAME_DURATION_MS = 20;

export interface UsageSession {
    usageLogId: string;          // Database record ID
    deviceId: string;
    deviceMac: string | null;
    userId: string | null;
    provider: string;
    sessionId: string | null;    // AI provider session ID (e.g., Ultravox callId)
    sessionStart: Date;

    // Accumulated metrics
    audioInputMs: number;
    audioOutputMs: number;
    inputBytes: number;
    outputBytes: number;
    inputTokens: number;
    outputTokens: number;

    // Pending metrics for current turn (reset after each conversation message)
    pendingInputMs: number;
    pendingInputBytes: number;
    pendingOutputMs: number;
    pendingOutputBytes: number;
}

export interface ConversationUsage {
    usageLogId: string;
    audioDurationMs: number;
    audioBytes: number;
    tokens: number;
}

interface PricingConfig {
    audio_input_per_min_usd: number;
    audio_output_per_min_usd: number;
}

class UsageTracker {
    private sessions: Map<string, UsageSession> = new Map();
    private pricingCache: Map<string, PricingConfig> = new Map();
    private pricingLoaded = false;

    /**
     * Load pricing configuration from database
     */
    async loadPricing(supabase: SupabaseClient): Promise<void> {
        if (this.pricingLoaded) return;

        try {
            const { data, error } = await supabase
                .from("pricing_config")
                .select("provider, pricing")
                .eq("is_active", true);

            if (error) {
                console.error("[UsageTracker] Failed to load pricing:", error);
                return;
            }

            for (const row of data || []) {
                this.pricingCache.set(row.provider, row.pricing as PricingConfig);
            }

            this.pricingLoaded = true;
            console.log(`[UsageTracker] Loaded pricing for ${this.pricingCache.size} providers`);
        } catch (e) {
            console.error("[UsageTracker] Error loading pricing:", e);
        }
    }

    /**
     * Start tracking a new session
     * Creates a usage_log record in the database and returns the usageLogId
     */
    async startSession(
        supabase: SupabaseClient,
        data: {
            deviceId: string;
            deviceMac: string | null;
            deviceUuid: string | null;  // devices.device_id
            userId: string | null;
            provider: string;
            sessionId: string | null;
        }
    ): Promise<string | null> {
        // Ensure pricing is loaded
        await this.loadPricing(supabase);

        const sessionStart = new Date();

        // Insert usage_log record
        const { data: insertedData, error } = await supabase
            .from("usage_logs")
            .insert({
                device_id: data.deviceUuid,
                device_mac: data.deviceMac,
                user_id: data.userId,
                provider: data.provider,
                session_id: data.sessionId,
                session_start: sessionStart.toISOString(),
            })
            .select("id")
            .single();

        if (error) {
            console.error("[UsageTracker] Failed to create usage_log:", error);
            return null;
        }

        const usageLogId = insertedData.id;

        // Create in-memory session
        const session: UsageSession = {
            usageLogId,
            deviceId: data.deviceId,
            deviceMac: data.deviceMac,
            userId: data.userId,
            provider: data.provider,
            sessionId: data.sessionId,
            sessionStart,
            audioInputMs: 0,
            audioOutputMs: 0,
            inputBytes: 0,
            outputBytes: 0,
            inputTokens: 0,
            outputTokens: 0,
            pendingInputMs: 0,
            pendingInputBytes: 0,
            pendingOutputMs: 0,
            pendingOutputBytes: 0,
        };

        this.sessions.set(data.deviceId, session);
        console.log(`[UsageTracker] Started session for device ${data.deviceId}, usageLogId: ${usageLogId}`);

        return usageLogId;
    }

    /**
     * Update the session ID (e.g., when Ultravox call is created after session start)
     */
    async updateSessionId(
        supabase: SupabaseClient,
        deviceId: string,
        sessionId: string
    ): Promise<void> {
        const session = this.sessions.get(deviceId);
        if (!session) return;

        session.sessionId = sessionId;

        // Update database
        await supabase
            .from("usage_logs")
            .update({ session_id: sessionId })
            .eq("id", session.usageLogId);
    }

    /**
     * Add audio input (from user/ESP32)
     * @param deviceId - Device identifier
     * @param bytes - Number of bytes received
     * @param durationMs - Optional duration in ms (default: OPUS_FRAME_DURATION_MS)
     */
    addAudioInput(deviceId: string, bytes: number, durationMs: number = OPUS_FRAME_DURATION_MS): void {
        const session = this.sessions.get(deviceId);
        if (!session) return;

        session.audioInputMs += durationMs;
        session.inputBytes += bytes;
        session.pendingInputMs += durationMs;
        session.pendingInputBytes += bytes;
    }

    /**
     * Add audio output (to user/ESP32)
     * @param deviceId - Device identifier
     * @param bytes - Number of bytes sent
     * @param durationMs - Optional duration in ms (default: OPUS_FRAME_DURATION_MS)
     */
    addAudioOutput(deviceId: string, bytes: number, durationMs: number = OPUS_FRAME_DURATION_MS): void {
        const session = this.sessions.get(deviceId);
        if (!session) return;

        session.audioOutputMs += durationMs;
        session.outputBytes += bytes;
        session.pendingOutputMs += durationMs;
        session.pendingOutputBytes += bytes;
    }

    /**
     * Add token usage (for text-based AI)
     */
    addTokens(deviceId: string, inputTokens: number, outputTokens: number): void {
        const session = this.sessions.get(deviceId);
        if (!session) return;

        session.inputTokens += inputTokens;
        session.outputTokens += outputTokens;
    }

    /**
     * Get pending usage for a conversation message and reset pending counters
     * Call this when saving a conversation record
     */
    getPendingUsage(deviceId: string, role: "user" | "assistant"): ConversationUsage | null {
        const session = this.sessions.get(deviceId);
        if (!session) return null;

        let usage: ConversationUsage;

        if (role === "user") {
            usage = {
                usageLogId: session.usageLogId,
                audioDurationMs: session.pendingInputMs,
                audioBytes: session.pendingInputBytes,
                tokens: 0,
            };
            // Reset pending input
            session.pendingInputMs = 0;
            session.pendingInputBytes = 0;
        } else {
            usage = {
                usageLogId: session.usageLogId,
                audioDurationMs: session.pendingOutputMs,
                audioBytes: session.pendingOutputBytes,
                tokens: 0,
            };
            // Reset pending output
            session.pendingOutputMs = 0;
            session.pendingOutputBytes = 0;
        }

        return usage;
    }

    /**
     * Get the current session's usageLogId
     */
    getUsageLogId(deviceId: string): string | null {
        return this.sessions.get(deviceId)?.usageLogId || null;
    }

    /**
     * Get session info (for debugging/API)
     */
    getSession(deviceId: string): UsageSession | null {
        return this.sessions.get(deviceId) || null;
    }

    /**
     * End session and write final metrics to database
     */
    async endSession(supabase: SupabaseClient, deviceId: string): Promise<void> {
        const session = this.sessions.get(deviceId);
        if (!session) {
            console.log(`[UsageTracker] No session found for device ${deviceId}`);
            return;
        }

        const sessionEnd = new Date();
        const durationMs = sessionEnd.getTime() - session.sessionStart.getTime();

        // Calculate cost
        const cost = this.calculateCost(session);

        // Update database
        const { error } = await supabase
            .from("usage_logs")
            .update({
                audio_input_ms: session.audioInputMs,
                audio_output_ms: session.audioOutputMs,
                input_bytes: session.inputBytes,
                output_bytes: session.outputBytes,
                input_tokens: session.inputTokens,
                output_tokens: session.outputTokens,
                cost_usd: cost,
                session_end: sessionEnd.toISOString(),
                duration_ms: durationMs,
            })
            .eq("id", session.usageLogId);

        if (error) {
            console.error("[UsageTracker] Failed to update usage_log:", error);
        } else {
            console.log(
                `[UsageTracker] Session ended for device ${deviceId}: ` +
                `input=${session.audioInputMs}ms, output=${session.audioOutputMs}ms, ` +
                `cost=$${cost.toFixed(6)}, duration=${Math.round(durationMs / 1000)}s`
            );
        }

        // Remove from memory
        this.sessions.delete(deviceId);
    }

    /**
     * Calculate cost based on usage and pricing config
     */
    private calculateCost(session: UsageSession): number {
        const pricing = this.pricingCache.get(session.provider);
        if (!pricing) {
            console.warn(`[UsageTracker] No pricing config for provider: ${session.provider}`);
            return 0;
        }

        const inputMinutes = session.audioInputMs / 60000;
        const outputMinutes = session.audioOutputMs / 60000;

        const inputCost = inputMinutes * (pricing.audio_input_per_min_usd || 0);
        const outputCost = outputMinutes * (pricing.audio_output_per_min_usd || 0);

        return inputCost + outputCost;
    }

    /**
     * Get all active sessions (for API/debugging)
     */
    getAllSessions(): UsageSession[] {
        return Array.from(this.sessions.values());
    }

    /**
     * Check if a device has an active session
     */
    hasSession(deviceId: string): boolean {
        return this.sessions.has(deviceId);
    }
}

// Export singleton
export const usageTracker = new UsageTracker();
