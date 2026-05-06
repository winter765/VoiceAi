import { Buffer } from "node:buffer";
import type { RawData } from "npm:@types/ws";
import { WebSocket } from "npm:ws";
import { addConversation, getDeviceInfo } from "../supabase.ts";
import { createOpusPacketizer, createOpusDecoder, isDev, xaiApiKey, defaultGrokVoice } from "../utils.ts";
import { usageTracker } from "../usage-tracker.ts";

const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime";

export const connectToGrok = async ({
    ws,
    payload,
    connectionPcmFile,
    firstMessage,
    systemPrompt,
    closeHandler,
}: ProviderArgs) => {
    const { user, supabase } = payload;

    if (!xaiApiKey) {
        throw new Error("XAI_API_KEY is not set");
    }

    // Get device ID for usage tracking
    const deviceId = user.device?.mac_address || user.device_id || "unknown";
    let usageLogId: string | null = null;

    const voice = user.personality?.oai_voice ?? defaultGrokVoice;

    const opus = createOpusPacketizer((packet) => {
        // Track output audio usage (20ms per Opus frame)
        usageTracker.addAudioOutput(deviceId, packet.length, 20);
        ws.send(packet);
    });
    const inputDecoder = createOpusDecoder();  // Decode 16kHz Opus from ESP32

    const grokWs = new WebSocket(XAI_REALTIME_URL, {
        headers: {
            Authorization: `Bearer ${xaiApiKey}`,
            "Content-Type": "application/json",
        },
    });

    let isConnected = false;
    const messageQueue: RawData[] = [];

    let createdSent = false;
    let outputTranscript = "";

    const sendResponseCreated = async () => {
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

    const sendFirstMessage = () => {
        if (!firstMessage) return;
        grokWs.send(
            JSON.stringify({
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: firstMessage }],
                },
            }),
        );
        grokWs.send(JSON.stringify({ type: "response.create" }));
    };

    grokWs.on("open", async () => {
        isConnected = true;

        // Start usage tracking session
        usageLogId = await usageTracker.startSession(supabase, {
            deviceId,
            deviceMac: user.device?.mac_address || null,
            deviceUuid: user.device_id || null,
            userId: user.user_id || null,
            provider: "grok",
            sessionId: null,
        });

        grokWs.send(
            JSON.stringify({
                type: "session.update",
                session: {
                    voice,
                    instructions: systemPrompt,
                    turn_detection: { type: "server_vad" },
                    audio: {
                        input: { format: { type: "audio/pcm", rate: 16000 } },
                        output: { format: { type: "audio/pcm", rate: 24000 } },
                    },
                },
            }),
        );

        sendFirstMessage();

        while (messageQueue.length > 0) {
            const queuedMessage = messageQueue.shift();
            if (queuedMessage) {
                messageHandler(queuedMessage, true);
            }
        }
    });

    grokWs.on("message", async (data: Buffer) => {
        let event: any;
        try {
            event = JSON.parse(data.toString("utf-8"));
        } catch {
            return;
        }

        try {
            switch (event.type) {
                case "response.created":
                    if (!createdSent) {
                        await sendResponseCreated();
                        createdSent = true;
                    }
                    break;

                case "response.output_audio_transcript.delta":
                    if (typeof event.delta === "string") {
                        outputTranscript += event.delta;
                    }
                    break;

                case "response.output_audio.delta":
                    if (typeof event.delta === "string") {
                        const pcmChunk = Buffer.from(event.delta, "base64");
                        // Use Opus packetizer to encode and send audio
                        opus.push(pcmChunk);
                    }
                    break;

                case "conversation.item.input_audio_transcription.completed":
                    if (typeof event.transcript === "string" && event.transcript.length > 0) {
                        // Get pending input usage for this message
                        const userUsage = usageTracker.getPendingUsage(deviceId, "user");
                        await addConversation(supabase, "user", event.transcript, user, userUsage ? {
                            usageLogId: userUsage.usageLogId,
                            audioDurationMs: userUsage.audioDurationMs,
                            audioBytes: userUsage.audioBytes,
                        } : undefined);
                        ws.send(JSON.stringify({ type: "server", msg: "TRANSCRIPT.USER", text: event.transcript }));
                    }
                    break;

                case "input_audio_buffer.committed":
                    ws.send(JSON.stringify({ type: "server", msg: "AUDIO.COMMITTED" }));
                    break;

                case "response.done":
                    // Flush any remaining audio
                    opus.flush(true);

                    if (outputTranscript) {
                        // Get pending output usage for this message
                        const assistantUsage = usageTracker.getPendingUsage(deviceId, "assistant");
                        await addConversation(supabase, "assistant", outputTranscript, user, assistantUsage ? {
                            usageLogId: assistantUsage.usageLogId,
                            audioDurationMs: assistantUsage.audioDurationMs,
                            audioBytes: assistantUsage.audioBytes,
                        } : undefined);
                        ws.send(JSON.stringify({ type: "server", msg: "TRANSCRIPT.ASSISTANT", text: outputTranscript }));
                        outputTranscript = "";
                    }
                    ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                    createdSent = false;
                    break;

                case "error":
                    ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
                    createdSent = false;
                    break;
            }
        } catch (err) {
            console.error("Error processing Grok event:", err);
            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
            createdSent = false;
        }
    });

    grokWs.on("close", () => {
        ws.close();
    });

    grokWs.on("error", (error: any) => {
        console.error("Grok WebSocket error:", error);
        ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
    });

    const messageHandler = async (data: RawData, isBinary: boolean) => {
        if (isBinary) {
            // Track input audio usage (20ms per Opus frame)
            usageTracker.addAudioInput(deviceId, (data as Buffer).length, 20);

            // Decode Opus to PCM (16kHz) from ESP32
            try {
                const pcmData = inputDecoder.decode(data as Buffer);
                const pcmBuffer = Buffer.from(pcmData);
                const base64Data = pcmBuffer.toString("base64");
                grokWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Data }));

                if (isDev && connectionPcmFile) {
                    await connectionPcmFile.write(pcmBuffer);
                }
            } catch (err) {
                console.error("Opus decode error:", err);
            }
            return;
        }

        let message: any;
        try {
            message = JSON.parse((data as Buffer).toString("utf-8"));
        } catch {
            return;
        }

        if (message?.type !== "instruction") return;

        if (message.msg === "end_of_speech") {
            grokWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            grokWs.send(JSON.stringify({ type: "response.create" }));
            grokWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        } else if (message.msg === "INTERRUPT") {
            grokWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        }
    };

    ws.on("message", (data: RawData, isBinary: boolean) => {
        if (!isConnected) {
            messageQueue.push(data);
        } else {
            messageHandler(data, isBinary);
        }
    });

    ws.on("error", (error: any) => {
        console.error("ESP32 WebSocket error:", error);
        grokWs.close();
    });

    ws.on("close", async (code: number, reason: string) => {
        console.log(`ESP32 WebSocket closed with code ${code}, reason: ${reason}`);

        // End usage tracking session
        if (usageLogId) {
            await usageTracker.endSession(supabase, deviceId);
        }

        await closeHandler();
        opus.close();
        grokWs.close();
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
        }
    });

    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Grok connection timeout")), 10000);
        grokWs.on("open", () => {
            clearTimeout(timeout);
            resolve();
        });
        grokWs.on("error", (error: any) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
};
