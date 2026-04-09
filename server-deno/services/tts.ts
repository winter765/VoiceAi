/**
 * TTS Service for Chef AI Timer Reminders
 *
 * Generates reminder audio using ElevenLabs TTS API with the same voice
 * used for AI conversations, ensuring consistent voice experience.
 */

import { Buffer } from "node:buffer";
import { elevenLabsApiKey, createOpusEncoder, SAMPLE_RATE } from "../utils.ts";

// Default voice ID - can be overridden per request
// This should match the voice used in Ultravox/ElevenLabs conversations
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel - natural female voice

// TTS output format - we need PCM to encode to Opus for ESP32
const OUTPUT_FORMAT = "pcm_24000"; // 24kHz 16-bit PCM

interface TTSOptions {
    text: string;
    voiceId?: string;
    modelId?: string;
}

interface TTSResult {
    pcmAudio: Buffer;       // Raw PCM audio (24kHz, 16-bit, mono)
    opusAudio: Buffer;      // Opus-encoded audio for ESP32
    durationMs: number;     // Estimated duration
}

/**
 * Generate TTS audio using ElevenLabs
 */
export async function generateTTS(options: TTSOptions): Promise<TTSResult> {
    const { text, voiceId = DEFAULT_VOICE_ID, modelId = "eleven_turbo_v2_5" } = options;

    if (!elevenLabsApiKey) {
        throw new Error("ELEVENLABS_API_KEY is not set");
    }

    console.log(`[TTS] Generating audio for: "${text.substring(0, 50)}..."`);

    const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
            method: "POST",
            headers: {
                "xi-api-key": elevenLabsApiKey,
                "Content-Type": "application/json",
                "Accept": "audio/pcm",
            },
            body: JSON.stringify({
                text,
                model_id: modelId,
                output_format: OUTPUT_FORMAT,
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.0,
                    use_speaker_boost: true,
                },
            }),
        }
    );

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs TTS error (${response.status}): ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const pcmAudio = Buffer.from(arrayBuffer);

    // Encode to Opus for ESP32
    const opusAudio = encodeToOpus(pcmAudio);

    // Estimate duration (24kHz, 16-bit mono = 48000 bytes per second)
    const durationMs = Math.round((pcmAudio.length / 48000) * 1000);

    console.log(`[TTS] Generated ${pcmAudio.length} bytes PCM, ${opusAudio.length} bytes Opus, ~${durationMs}ms`);

    return {
        pcmAudio,
        opusAudio,
        durationMs,
    };
}

/**
 * Generate timer reminder audio with chef-style personality
 */
export async function generateTimerReminder(
    timerName: string,
    reminderPhrase: string,
    voiceId?: string
): Promise<Buffer> {
    // Use the provided reminder phrase directly
    // The AI should have already generated a chef-style phrase
    const result = await generateTTS({
        text: reminderPhrase,
        voiceId,
    });

    return result.opusAudio;
}

/**
 * Encode PCM audio to Opus format for ESP32
 * Input: 24kHz, 16-bit, mono PCM
 * Output: Opus packets concatenated
 */
function encodeToOpus(pcmBuffer: Buffer): Buffer {
    const encoder = createOpusEncoder();
    const FRAME_DURATION = 20; // ms
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 1;
    const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION / 1000) * CHANNELS * BYTES_PER_SAMPLE;

    const packets: Buffer[] = [];
    let offset = 0;

    while (offset + FRAME_SIZE <= pcmBuffer.length) {
        const frame = pcmBuffer.subarray(offset, offset + FRAME_SIZE);
        try {
            const packet = encoder.encode(frame);
            // Prepend packet length (2 bytes, little-endian) for ESP32 to parse
            const lengthPrefix = Buffer.alloc(2);
            lengthPrefix.writeUInt16LE(packet.length, 0);
            packets.push(Buffer.concat([lengthPrefix, Buffer.from(packet)]));
        } catch (err) {
            console.error("[TTS] Opus encode error:", err);
        }
        offset += FRAME_SIZE;
    }

    // Handle remaining samples (pad with silence)
    if (offset < pcmBuffer.length) {
        const remaining = pcmBuffer.subarray(offset);
        const padded = Buffer.alloc(FRAME_SIZE);
        remaining.copy(padded);
        try {
            const packet = encoder.encode(padded);
            const lengthPrefix = Buffer.alloc(2);
            lengthPrefix.writeUInt16LE(packet.length, 0);
            packets.push(Buffer.concat([lengthPrefix, Buffer.from(packet)]));
        } catch (err) {
            console.error("[TTS] Opus encode error:", err);
        }
    }

    return Buffer.concat(packets);
}

/**
 * Predefined reminder phrases with audio caching
 * These can be pre-generated and cached to reduce API calls
 */
const COMMON_REMINDERS: Record<string, string> = {
    "eggs": "The eggs are done! Quick, before they get old!",
    "egg": "The egg is ready! Time to take it off the heat!",
    "rice": "Your rice is done! Time to fluff it up!",
    "pasta": "Pasta's ready! Drain it now before it gets mushy!",
    "meat": "The meat is ready! Let it rest for a minute!",
    "water": "Water's boiling! Time to add your ingredients!",
    "timer": "Time's up! Go check on your food!",
};

/**
 * Get a reminder phrase for common items, or use AI-generated phrase
 */
export function getCommonReminderPhrase(timerName: string): string | null {
    const normalized = timerName.toLowerCase().trim();

    for (const [key, phrase] of Object.entries(COMMON_REMINDERS)) {
        if (normalized.includes(key)) {
            return phrase;
        }
    }

    return null;
}

/**
 * Audio cache for pre-generated reminders
 * In production, consider using Redis or file system
 */
const audioCache = new Map<string, Buffer>();

/**
 * Get or generate reminder audio with caching
 */
export async function getOrGenerateReminderAudio(
    timerName: string,
    reminderPhrase: string,
    voiceId?: string
): Promise<Buffer> {
    // Create cache key
    const cacheKey = `${voiceId || DEFAULT_VOICE_ID}:${reminderPhrase}`;

    // Check cache
    if (audioCache.has(cacheKey)) {
        console.log(`[TTS] Cache hit for: "${reminderPhrase.substring(0, 30)}..."`);
        return audioCache.get(cacheKey)!;
    }

    // Generate new audio
    const audio = await generateTimerReminder(timerName, reminderPhrase, voiceId);

    // Cache it (limit cache size to prevent memory issues)
    if (audioCache.size < 100) {
        audioCache.set(cacheKey, audio);
    }

    return audio;
}

/**
 * Clear audio cache (call periodically or on memory pressure)
 */
export function clearAudioCache(): void {
    const size = audioCache.size;
    audioCache.clear();
    console.log(`[TTS] Cleared ${size} cached audio entries`);
}
