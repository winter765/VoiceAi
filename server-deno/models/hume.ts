import { Buffer } from "node:buffer";
import type { RawData } from "npm:@types/ws";
import { WebSocket } from "npm:ws";
import { addConversation, getDeviceInfo } from "../supabase.ts";
import { createOpusPacketizer, createOpusDecoder, isDev, humeApiKey, downsamplePcm, extractPcmFromWav, boostLimitPCM16LEInPlace, INPUT_SAMPLE_RATE } from "../utils.ts";
import { usageTracker } from "../usage-tracker.ts";

export const connectToHume = ({
    ws,
    payload,
    connectionPcmFile,
    firstMessage,
    systemPrompt,
    closeHandler,
}: ProviderArgs) => {
    const { user, supabase } = payload;
    const { personality } = user;

    // Get device ID for usage tracking
    const deviceId = user.device?.mac_address || user.device_id || "unknown";
    let usageLogId: string | null = null;

    const opus = createOpusPacketizer((packet) => {
        // Track output audio usage (20ms per Opus frame)
        usageTracker.addAudioOutput(deviceId, packet.length, 20);
        ws.send(packet);
    });
    const inputDecoder = createOpusDecoder();  // Decode 16kHz Opus from ESP32

    console.log(`Connecting to Hume with key "${humeApiKey?.slice(0, 3)}..."`);

    // Build Hume WebSocket URL
    const configId = personality?.oai_voice ?? "";
    const queryParams = new URLSearchParams({
        api_key: humeApiKey!,
        config_id: configId,
    });

    const humeWsUrl = `wss://api.hume.ai/v0/evi/chat?${queryParams.toString()}`;

    console.log(`Connecting to Hume WebSocket at: ${humeWsUrl.replace(humeApiKey!, "API_KEY_HIDDEN")}`);
    const humeWs = new WebSocket(humeWsUrl);

    let isConnected = false;
    const messageQueue: RawData[] = [];
    let createdSent = false;

    // Handle Hume WebSocket connection
    humeWs.on("open", async () => {
        console.log("✅ Connected to Hume WebSocket API successfully");
        isConnected = true;

        // Start usage tracking session
        usageLogId = await usageTracker.startSession(supabase, {
            deviceId,
            deviceMac: user.device?.mac_address || null,
            deviceUuid: user.device_id || null,
            userId: user.user_id || null,
            provider: "hume",
            sessionId: null,
        });

        // Configure Hume session settings for input audio format (16kHz to match ESP32 mic)
        humeWs.send(JSON.stringify({
            type: "session_settings",
            audio: {
                encoding: "linear16",
                channels: 1,
                sample_rate: INPUT_SAMPLE_RATE,  // 16000 Hz - same as ESP32 mic
            },
            system_prompt: systemPrompt,
        }));

        // Send simple first message if provided
        humeWs.send(JSON.stringify({
            type: "user_input",
            text: firstMessage,
        }));

        // Process queued messages
        while (messageQueue.length > 0) {
            const queuedMessage = messageQueue.shift();
            if (queuedMessage) {
                messageHandler(queuedMessage, true); // Assume binary for queued audio
            }
        }
    });

    // Handle messages from Hume
    humeWs.on("message", async (data: Buffer) => {
        try {
            const message: HumeMessage = JSON.parse(data.toString());
            console.log(`Received from Hume: ${message.type}`);

            switch (message.type) {
                case "assistant_end":
                    // Flush any remaining audio
                    opus.flush(true);

                    // Send RESPONSE.COMPLETE when assistant message is done
                    ws.send(JSON.stringify({
                        type: "server",
                        msg: "RESPONSE.COMPLETE",
                    }));

                    // Reset for next turn
                    createdSent = false;
                    break;

                case "assistant_message":
                    const assistantMsg = message as HumeAssistantMessage;

                    // Get pending output usage for this message
                    const assistantUsage = usageTracker.getPendingUsage(deviceId, "assistant");
                    // Store conversation in database
                    await addConversation(
                        supabase,
                        "assistant",
                        assistantMsg.message.content,
                        user,
                        assistantUsage ? {
                            usageLogId: assistantUsage.usageLogId,
                            audioDurationMs: assistantUsage.audioDurationMs,
                            audioBytes: assistantUsage.audioBytes,
                        } : undefined,
                    );
                    ws.send(JSON.stringify({ type: "server", msg: "TRANSCRIPT.ASSISTANT", text: assistantMsg.message.content }));
                    break;

                case "audio_output":
                    const audioMsg = message as HumeAudioOutput;

                    // Send RESPONSE.CREATED before first audio chunk
                    if (!createdSent) {
                        try {
                            const device = await getDeviceInfo(supabase, user.user_id);
                            opus.reset();

                            if (device) {
                                ws.send(JSON.stringify({
                                    type: "server",
                                    msg: "RESPONSE.CREATED",
                                    volume_control: device.volume ?? 70,
                                }));
                            } else {
                                ws.send(JSON.stringify({
                                    type: "server",
                                    msg: "RESPONSE.CREATED",
                                }));
                            }
                        } catch (error) {
                            console.error("Error fetching device info:", error);
                            ws.send(JSON.stringify({
                                type: "server",
                                msg: "RESPONSE.CREATED",
                            }));
                        }
                        createdSent = true;
                    }

                    try {
                        // Decode base64 audio data from Hume (this is a WAV file, not raw PCM!)
                        const wavBuffer = Buffer.from(audioMsg.data, "base64");

                        // Extract PCM data from WAV file
                        const pcmData = extractPcmFromWav(wavBuffer);

                        if (!pcmData) {
                            console.error("Failed to extract PCM data from WAV");
                            return;
                        }

                        // Downsample from 48kHz to 24kHz to match our system
                        const downsampledPcm = downsamplePcm(pcmData, 48000, 24000);
                        boostLimitPCM16LEInPlace(downsampledPcm, /*gainDb=*/6.0, /*ceiling=*/0.89);

                        // Use Opus packetizer to encode and send audio
                        opus.push(downsampledPcm);
                    } catch (audioError) {
                        console.error("Error processing Hume audio output:", audioError);
                    }
                    break;

                case "chat_metadata":
                    console.log("Chat metadata received:", message);
                    break;

                case "user_message":
                    console.log("User message acknowledged:", message);
                    // Get pending input usage for this message
                    const userUsage = usageTracker.getPendingUsage(deviceId, "user");
                    await addConversation(
                        supabase,
                        "user",
                        message.message.content,
                        user,
                        userUsage ? {
                            usageLogId: userUsage.usageLogId,
                            audioDurationMs: userUsage.audioDurationMs,
                            audioBytes: userUsage.audioBytes,
                        } : undefined,
                    );
                    ws.send(JSON.stringify({ type: "server", msg: "TRANSCRIPT.USER", text: message.message.content }));
                    break;

                case "user_input":
                    // This is an echo of our own input, we can log it but don't need to store it again
                    console.log("User input acknowledged by Hume");
                    break;

                case "error":
                    const errorMsg = message as HumeError;
                    console.error(`Hume error: ${errorMsg.code} - ${errorMsg.message}`);

                    ws.send(JSON.stringify({
                        type: "server",
                        msg: "RESPONSE.ERROR",
                        error: errorMsg.message,
                    }));
                    break;

                case "session_created":
                    console.log("Hume session created");
                    ws.send(JSON.stringify({
                        type: "server",
                        msg: "SESSION.CREATED",
                    }));
                    break;

                case "session_ended":
                    console.log("Hume session ended");
                    ws.send(JSON.stringify({
                        type: "server",
                        msg: "SESSION.END",
                    }));
                    break;

                default:
                    console.log(`Unhandled Hume message type: ${message.type}`);
            }
        } catch (error) {
            console.error("Error processing Hume message:", error);
        }
    });

    humeWs.on("close", (code: number, reason: Buffer) => {
        console.log(`Hume WebSocket closed: ${code} - ${reason.toString()}`);
        // If there was an active response, notify ESP32 that it's complete
        if (createdSent) {
            console.log("[DEBUG] Hume closed during active response, sending RESPONSE.COMPLETE to ESP32");
            opus.flush(true);
            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
            createdSent = false;
        }
        ws.send(JSON.stringify({
            type: "server",
            msg: "SESSION.END",
        }));
        isConnected = false;
        ws.close();
    });

    humeWs.on("error", (error: Error) => {
        console.error("Hume WebSocket error:", error);
        console.error("Error details:", {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        ws.send(JSON.stringify({
            type: "server",
            msg: "RESPONSE.ERROR",
            error: "Connection to Hume failed",
        }));
    });

    // Handle messages from ESP32 client
    const messageHandler = async (data: RawData, isBinary: boolean) => {
        try {
            if (isBinary) {
                // Track input audio usage (20ms per Opus frame)
                usageTracker.addAudioInput(deviceId, (data as Buffer).length, 20);

                // Decode Opus to PCM (16kHz) from ESP32
                try {
                    const pcmData = inputDecoder.decode(data as Buffer);
                    const pcmBuffer = Buffer.from(pcmData);
                    const base64Audio = pcmBuffer.toString("base64");

                    const audioMessage: HumeAudioInput = {
                        type: "audio_input",
                        data: base64Audio,
                    };

                    if (isConnected) {
                        humeWs.send(JSON.stringify(audioMessage));
                    }

                    // Write decoded PCM to debug file if enabled
                    if (isDev && connectionPcmFile) {
                        await connectionPcmFile.write(pcmBuffer);
                    }
                } catch (err) {
                    console.error("Opus decode error:", err);
                }
            }
        } catch (error) {
            console.error("Error handling message:", error);
        }
    };

    // Set up ESP32 WebSocket handlers
    ws.on("message", (data: RawData, isBinary: boolean) => {
        if (!isConnected) {
            messageQueue.push(data);
        } else {
            messageHandler(data, isBinary);
        }
    });

    ws.on("error", (error: Error) => {
        console.error("ESP32 WebSocket error:", error);
        humeWs.close();
    });

    ws.on("close", async (code: number, reason: string) => {
        console.log(`ESP32 WebSocket closed: ${code} - ${reason}`);

        // End usage tracking session
        if (usageLogId) {
            await usageTracker.endSession(supabase, deviceId);
        }

        await closeHandler();
        opus.close();
        humeWs.close();

        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
            console.log("Closed debug audio file");
        }
    });

    // Wait for Hume connection to be established
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("Hume connection timeout"));
        }, 10000);

        humeWs.on("open", () => {
            clearTimeout(timeout);
            resolve();
        });

        humeWs.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
};
