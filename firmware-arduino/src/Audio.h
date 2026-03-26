#ifndef AUDIO_H
#define AUDIO_H

#include "AudioTools.h"
#include "AudioTools/AudioCodecs/CodecOpus.h"
#include "Config.h"
#include <opus.h>

extern SemaphoreHandle_t wsMutex;
extern WebSocketsClient webSocket;

extern TaskHandle_t speakerTaskHandle;
extern TaskHandle_t micTaskHandle;
extern TaskHandle_t networkTaskHandle;

extern volatile bool scheduleListeningRestart;
extern unsigned long scheduledTime;
extern unsigned long speakingStartTime;

extern int currentVolume;
extern const int CHANNELS;         // Mono
extern const int BITS_PER_SAMPLE; // 16-bit audio

// AUDIO OUTPUT
constexpr size_t AUDIO_BUFFER_SIZE = 1024 * 6;      // 6KB buffer (reduced from 10KB)
constexpr size_t AUDIO_CHUNK_SIZE  = 1024;         // ideal read/write chunk size
extern OpusAudioDecoder opusDecoder;
extern BufferRTOS<uint8_t> audioBuffer;
extern I2SStream i2s;
extern VolumeStream volume;
extern QueueStream<uint8_t> queue;
extern StreamCopy copier;

// AUDIO INPUT - Opus Encoder
// Opus frame: 20ms at 16kHz = 320 samples = 640 bytes PCM
constexpr int MIC_OPUS_FRAME_MS = 20;
constexpr int MIC_OPUS_SAMPLE_RATE = 16000;  // Must match MIC_SAMPLE_RATE in Config.cpp
constexpr int MIC_OPUS_FRAME_SAMPLES = (MIC_OPUS_SAMPLE_RATE * MIC_OPUS_FRAME_MS / 1000);  // 320 samples
constexpr int MIC_OPUS_FRAME_BYTES = MIC_OPUS_FRAME_SAMPLES * 2;  // 640 bytes (16-bit)
constexpr int MIC_OPUS_MAX_PACKET_SIZE = 256;  // Max Opus packet size for voice
constexpr int MIC_OPUS_BITRATE = 16000;  // 16 kbps for voice (optimized for public network)

// Audio send queue for decoupling mic task from network task
// This prevents network latency from blocking audio capture
constexpr int AUDIO_SEND_QUEUE_SIZE = 15;  // ~300ms buffer (reduced from 30)

// Structure for audio packet in queue
struct AudioPacket {
    uint8_t data[MIC_OPUS_MAX_PACKET_SIZE];
    size_t length;
};

extern QueueHandle_t audioSendQueue;
void clearAudioSendQueue();

// NEW for pitch shift
extern VolumeStream volumePitch;
extern StreamCopy pitchCopier;

extern AudioInfo info;
extern volatile bool i2sOutputFlushScheduled;

// AUDIO INPUT
extern I2SStream i2sInput;
extern StreamCopy micToWsCopier;
extern volatile bool i2sInputFlushScheduled;

// WEBSOCKET
void webSocketEvent(WStype_t type, const uint8_t *payload, size_t length);
void websocketSetup(const String& server_domain, int port, const String& path);
void networkTask(void *parameter);

// AUDIO OUTPUT
unsigned long getSpeakingDuration();
void audioStreamTask(void *parameter);

// AUDIO INPUT
void micTask(void *parameter);

// STATE CONTROL
void transitionToListening();
void toggleChatState();
extern volatile bool chatToggleRequested;

#endif