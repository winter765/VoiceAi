import { Buffer } from "node:buffer";
import type { RawData } from "npm:@types/ws";
import { createOpusPacketizer, isDev } from "../utils.ts";
import * as path from "node:path";

// Create a WAV header for PCM data
function createWavBuffer(pcmData: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
    const dataSize = pcmData.length;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);           // fmt chunk size
    header.writeUInt16LE(1, 20);            // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28); // byte rate
    header.writeUInt16LE(channels * bitsPerSample / 8, 32);              // block align
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcmData]);
}

const RECORD_DURATION_MS = 3000; // Record 3 seconds then echo back

// Save PCM to firmware-arduino/tmp/ for debugging
const TMP_DIR = path.resolve(import.meta.dirname ?? ".", "../../firmware-arduino/tmp");

export const connectToEcho = async ({
    ws,
    payload,
    connectionPcmFile,
}: ProviderArgs) => {
    console.log("[ECHO] Echo test mode started");
    console.log("[ECHO] PCM output will be saved to:", TMP_DIR);

    const opus = createOpusPacketizer((packet) => ws.send(packet));
    let audioChunks: Buffer[] = [];
    let isRecording = false;
    let recordTimer: ReturnType<typeof setTimeout> | null = null;

    const startRecording = () => {
        audioChunks = [];
        isRecording = true;
        console.log("[ECHO] Recording started...");

        // Send RESPONSE.COMPLETE to put ESP32 in LISTENING mode
        ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));

        recordTimer = setTimeout(async () => {
            isRecording = false;
            const totalBytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
            console.log(`[ECHO] Recording done: ${audioChunks.length} chunks, ${totalBytes} bytes`);

            // Check if audio has actual data
            let nonZeroBytes = 0;
            for (const chunk of audioChunks) {
                for (let i = 0; i < chunk.length; i++) {
                    if (chunk[i] !== 0) nonZeroBytes++;
                }
            }
            console.log(`[ECHO] Non-zero bytes: ${nonZeroBytes}/${totalBytes} (${(nonZeroBytes/totalBytes*100).toFixed(1)}%)`);

            if (nonZeroBytes === 0) {
                console.log("[ECHO] WARNING: All audio is silence (zeros)! Microphone may not be working.");
            }

            // Now play it back - send RESPONSE.CREATED first
            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.CREATED" }));

            // Concatenate recorded 16kHz PCM and upsample to 24kHz for playback
            const recordedPcm = Buffer.concat(audioChunks);
            const playbackPcm = upsample16kTo24k(recordedPcm);
            console.log(`[ECHO] Echoing mic audio: ${recordedPcm.length} bytes @16kHz -> ${playbackPcm.length} bytes @24kHz`);

            opus.push(playbackPcm);
            opus.flush(true);

            // Signal playback complete, then start recording again
            setTimeout(() => {
                ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                console.log("[ECHO] Playback done, starting next recording cycle...");
                // Start next cycle after a short delay
                setTimeout(() => startRecording(), 1000);
            }, 500);
        }, RECORD_DURATION_MS);
    };

    // Handle messages from ESP32
    ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary && isRecording) {
            audioChunks.push(Buffer.from(data as Buffer));
            if (isDev && connectionPcmFile) {
                connectionPcmFile.write(data as Buffer);
            }
        } else if (!isBinary) {
            console.log("[ECHO] ESP32 text:", (data as Buffer).toString("utf-8"));
        }
    });

    ws.on("close", () => {
        console.log("[ECHO] Connection closed");
        if (recordTimer) clearTimeout(recordTimer);
        opus.close();
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
        }
    });

    ws.on("error", (err: any) => {
        console.error("[ECHO] Error:", err);
    });

    // Start first recording cycle after a short delay (let auth message arrive first)
    setTimeout(() => startRecording(), 500);
};

// Simple upsample from 16kHz to 24kHz (linear interpolation)
function upsample16kTo24k(input: Buffer): Buffer {
    const inputSamples = input.length / 2;
    const ratio = 16000 / 24000; // 2/3
    const outputSamples = Math.ceil(inputSamples / ratio);
    const output = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const srcPos = i * ratio;
        const srcIndex = Math.floor(srcPos);
        const frac = srcPos - srcIndex;

        if (srcIndex + 1 < inputSamples) {
            const s0 = input.readInt16LE(srcIndex * 2);
            const s1 = input.readInt16LE((srcIndex + 1) * 2);
            const interpolated = Math.round(s0 + frac * (s1 - s0));
            output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
        } else if (srcIndex < inputSamples) {
            output.writeInt16LE(input.readInt16LE(srcIndex * 2), i * 2);
        }
    }

    return output;
}
