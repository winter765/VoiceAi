import { Buffer } from "node:buffer";
import type { RawData } from "npm:@types/ws";
import { WebSocket } from "npm:ws";
import { addConversation, getDeviceInfo } from "../supabase.ts";
import { createOpusPacketizer, createOpusDecoder, isDev, ultravoxApiKey } from "../utils.ts";

const ULTRAVOX_API_URL = "https://api.ultravox.ai/api/calls";

interface UltravoxCallResponse {
    callId: string;
    joinUrl: string;
    [key: string]: any;
}

async function createUltravoxCall(
    systemPrompt: string,
    voice: string,
    firstMessage: string,
): Promise<UltravoxCallResponse> {
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
    let createdSent = false;
    let createdAcked = false; // true after RESPONSE.CREATED text msg is actually sent
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
            callData = await createUltravoxCall(systemPrompt, voice, firstMessage);
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
                if (uvAudioChunks % 50 === 1) {
                    console.log(`[UV] Ultravox audio: chunk #${uvAudioChunks}, size=${data.length}B, total=${uvAudioBytes}B`);
                }
                if (!createdSent) {
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
    }

    // Listen for ESP32 messages (text instructions + binary audio)
    ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
            // Only forward audio when session is active
            if (isSessionActive && uvWs?.readyState === WebSocket.OPEN) {
                audioPacketCount++;
                totalAudioBytes += (data as Buffer).length;

                // Decode Opus to PCM (16kHz) before forwarding to Ultravox
                try {
                    const pcmData = inputDecoder.decode(data as Buffer);
                    decodedPcmBytes += pcmData.length;

                    if (audioPacketCount % 100 === 1) {
                        console.log(`[DEBUG] ESP32 audio: packet #${audioPacketCount}, opus=${(data as Buffer).length}B, pcm=${pcmData.length}B, totalPcm=${decodedPcmBytes}B`);
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
        if (isDev) {
            console.log(`[DEBUG] ESP32 text message:`, (data as Buffer).toString("utf-8"));
        }

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
        stopSession();
    });

    ws.on("close", async (code: number, reason: string) => {
        console.log(`[UV] ESP32 WebSocket closed with code ${code}, reason: ${reason}`);
        console.log(`[DEBUG] Audio summary: ${audioPacketCount} packets, ${totalAudioBytes} bytes total`);
        stopSession();
        await closeHandler();
        opus.close();
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
        }
    });

    // Resolve immediately — no Ultravox connection yet, just listening for instructions
    console.log("[UV] Ultravox handler ready, waiting for START_SESSION from ESP32");
};
