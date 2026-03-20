import { Buffer } from "node:buffer";
import type { RawData } from "npm:@types/ws";
import { WebSocket } from "npm:ws";
import { addConversation, getDeviceInfo } from "../supabase.ts";
import { createOpusPacketizer, isDev, ultravoxApiKey } from "../utils.ts";

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

    const voice = "Mark"; // TODO: add ultravox_voice field to personality
    let opusPacketsSent = 0;
    const opus = createOpusPacketizer((packet) => {
        opusPacketsSent++;
        if (opusPacketsSent % 10 === 1) {
            console.log(`[DEBUG] Opus→ESP32: packet #${opusPacketsSent}, size=${packet.length}B`);
        }
        ws.send(packet);
    });

    // Step 1: Create call via REST API
    console.log("Creating Ultravox call...");
    let callData: UltravoxCallResponse;
    try {
        callData = await createUltravoxCall(systemPrompt, voice, firstMessage);
        console.log(`Ultravox call created: ${callData.callId}`);
    } catch (e) {
        console.error("Failed to create Ultravox call:", e);
        ws.close();
        return;
    }

    // Step 2: Connect to the joinUrl via WebSocket
    const uvWs = new WebSocket(callData.joinUrl);

    let isConnected = false;
    const messageQueue: RawData[] = [];
    let createdSent = false;
    let outputTranscript = "";

    const sendResponseCreated = async () => {
        console.log("[DEBUG] Sending RESPONSE.CREATED to ESP32");
        try {
            const device = await getDeviceInfo(supabase, user.user_id);
            opus.reset();
            ws.send(
                JSON.stringify({
                    type: "server",
                    msg: "RESPONSE.CREATED",
                    volume_control: device?.volume ?? 100,
                }),
            );
        } catch {
            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.CREATED" }));
        }
    };

    uvWs.on("open", () => {
        console.log("Connected to Ultravox WebSocket");
        isConnected = true;

        // Process queued messages
        while (messageQueue.length > 0) {
            const queuedMessage = messageQueue.shift();
            if (queuedMessage) {
                messageHandler(queuedMessage, true);
            }
        }
    });

    let uvAudioChunks = 0;
    let uvAudioBytes = 0;
    uvWs.on("message", async (data: Buffer, isBinary: boolean) => {
        // Binary data = audio output from Ultravox
        if (isBinary) {
            uvAudioChunks++;
            uvAudioBytes += data.length;
            if (uvAudioChunks % 20 === 1) {
                console.log(`[DEBUG] Ultravox→Server audio: chunk #${uvAudioChunks}, size=${data.length}B, total=${uvAudioBytes}B, opusBuffered=${opus.bufferedBytes()}B`);
            }
            if (!createdSent) {
                createdSent = true; // Set flag BEFORE async call to prevent race condition
                await sendResponseCreated();
            }
            // PCM 16-bit LE audio at 24kHz - encode to Opus and send to ESP32
            opus.push(data);
            return;
        }

        // Text data = JSON control messages
        let event: any;
        try {
            event = JSON.parse(data.toString("utf-8"));
        } catch {
            return;
        }

        try {
            switch (event.type) {
                case "state":
                    console.log("Ultravox state:", event.state);
                    // If Ultravox transitions to listening, treat it as audio done
                    if (event.state === "listening" && createdSent) {
                        console.log("[DEBUG] state→listening with createdSent=true → sending RESPONSE.COMPLETE");
                        opus.flush(true);
                        ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                        createdSent = false;
                        outputTranscript = "";
                    }
                    break;

                case "transcript":
                    console.log("Ultravox transcript:", event.role, "final:", event.final, "text:", event.text);
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
                    outputTranscript = "";
                    break;

                case "user_speech_started":
                    console.log("[DEBUG] user_speech_started → sending AUDIO.COMMITTED to ESP32");
                    ws.send(JSON.stringify({ type: "server", msg: "AUDIO.COMMITTED" }));
                    break;

                case "error":
                    console.error("Ultravox error:", event);
                    ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
                    createdSent = false;
                    break;

                default:
                    if (isDev) {
                        console.log("Ultravox event:", event.type, event);
                    }
                    break;
            }
        } catch (err) {
            console.error("Error processing Ultravox event:", err);
            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
            createdSent = false;
        }
    });

    uvWs.on("close", () => {
        console.log("Ultravox WebSocket closed");
        ws.close();
    });

    uvWs.on("error", (error: any) => {
        console.error("Ultravox WebSocket error:", error);
        ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
    });

    // Handle messages from ESP32
    let audioPacketCount = 0;
    let totalAudioBytes = 0;
    const messageHandler = (data: RawData, isBinary: boolean) => {
        if (isBinary) {
            audioPacketCount++;
            totalAudioBytes += (data as Buffer).length;
            if (audioPacketCount % 100 === 1) {
                console.log(`[DEBUG] ESP32 audio: packet #${audioPacketCount}, this=${(data as Buffer).length}B, total=${totalAudioBytes}B`);
            }
            // Forward raw PCM audio to Ultravox as binary
            uvWs.send(data as Buffer);

            if (isDev && connectionPcmFile) {
                connectionPcmFile.write(data as Buffer);
            }
            return;
        }

        // Handle text control messages from ESP32
        let message: any;
        try {
            message = JSON.parse((data as Buffer).toString("utf-8"));
        } catch {
            return;
        }

        if (message?.type !== "instruction") return;

        if (message.msg === "INTERRUPT") {
            // Ultravox handles interruption automatically via VAD,
            // but we can flush the opus buffer
            opus.reset();
        }
    };

    ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isDev && !isBinary) {
            console.log(`[DEBUG] ESP32 text message:`, (data as Buffer).toString("utf-8"));
        }
        if (!isConnected) {
            console.log(`[DEBUG] Ultravox not connected yet, queuing message (binary=${isBinary}, size=${(data as Buffer).length})`);
            messageQueue.push(data);
        } else {
            messageHandler(data, isBinary);
        }
    });

    ws.on("error", (error: any) => {
        console.error("ESP32 WebSocket error:", error);
        uvWs.close();
    });

    ws.on("close", async (code: number, reason: string) => {
        console.log(`ESP32 WebSocket closed with code ${code}, reason: ${reason}`);
        console.log(`[DEBUG] Audio summary: ${audioPacketCount} packets, ${totalAudioBytes} bytes total`);
        await closeHandler();
        opus.close();
        uvWs.close();
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
        }
    });

    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Ultravox connection timeout")), 10000);
        uvWs.on("open", () => {
            clearTimeout(timeout);
            resolve();
        });
        uvWs.on("error", (error: any) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
};
