#include "OTA.h"
#include "Audio.h"
#include "PitchShift.h"

#ifdef DISPLAY_ENABLED
#include "DisplayHandler.h"
#endif

// WEBSOCKET
SemaphoreHandle_t wsMutex;
WebSocketsClient webSocket;

// TASK HANDLES
TaskHandle_t speakerTaskHandle = NULL;
TaskHandle_t micTaskHandle = NULL;
TaskHandle_t networkTaskHandle = NULL;

// TIMING REGISTERS
volatile bool chatToggleRequested = false;
volatile bool scheduleListeningRestart = false;
unsigned long scheduledTime = 0;
unsigned long speakingStartTime = 0;

// AUDIO SETTINGS
int currentVolume = 100;
float currentPitchFactor = 1.0f;
const int CHANNELS = 1;         // Mono
const int BITS_PER_SAMPLE = 16; // 16-bit audio

// Audio send queue for decoupling mic task from network task
QueueHandle_t audioSendQueue = NULL;
static int queueDropCount = 0;  // Track dropped packets when queue is full

void clearAudioSendQueue() {
    if (audioSendQueue != NULL) {
        xQueueReset(audioSendQueue);
        queueDropCount = 0;
    }
}

// AUDIO OUTPUT
class BufferPrint : public Print {
public:
  explicit BufferPrint(BufferRTOS<uint8_t>& buf) : _buffer(buf) {}

  // networkTask -> webSocket.loop() -> webSocketEvent(WStype_BIN, ...) -> opusDecoder.write() -> bufferPrint.write()
  virtual size_t write(uint8_t data) override {
    if (webSocket.isConnected() && deviceState == SPEAKING) {
        return _buffer.writeArray(&data, 1);
    }
    return 1; //let opusDecoder write, otherwise thread will stuck
  }

  // networkTask -> webSocket.loop() -> webSocketEvent(WStype_BIN, ...) -> opusDecoder.write() -> bufferPrint.write()
  virtual size_t write(const uint8_t *buffer, size_t size) override {
    if (webSocket.isConnected() && deviceState == SPEAKING) {
        return _buffer.writeArray(buffer, size);
    }
    return size; //let opusDecoder write, otherwise thread will stuck
  }

private:
  BufferRTOS<uint8_t>& _buffer;
};

BufferPrint bufferPrint(audioBuffer);
OpusAudioDecoder opusDecoder;  //access guarded by wsmutex
BufferRTOS<uint8_t> audioBuffer(AUDIO_BUFFER_SIZE, AUDIO_CHUNK_SIZE);  //producer: networkTask, consumer: audioStreamTask. Thread safe in single producer->single consumer scenario.
I2SStream i2s; //access from audioStreamTask only

// 16→32 bit conversion buffers (matching xiaozhi: I2S TX uses 32-bit data width)
static const int SPK_COPY_SAMPLES = 240;  // match xiaozhi DMA frame num
static int16_t spkBuf16[SPK_COPY_SAMPLES];
static int32_t spkBuf32[SPK_COPY_SAMPLES * 2];  // stereo: 2 channels

// Keep legacy objects for compatibility (unused in new manual pipeline)
VolumeStream volume(i2s);
QueueStream<uint8_t> queue(audioBuffer);
StreamCopy copier(volume, queue);

// Pitch shift (lossy) - TODO: re-integrate with 32-bit output
PitchShiftFixedOutput pitchShift(i2s);
VolumeStream volumePitch(pitchShift);
StreamCopy pitchCopier(volumePitch, queue);

AudioInfo info(SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE);
volatile bool i2sOutputFlushScheduled = false;

unsigned long getSpeakingDuration() {
    if (deviceState == SPEAKING && speakingStartTime > 0) {
        return millis() - speakingStartTime;
    }
    return 0;
}

// networkTask -> webSocket.loop() -> webSocketEvent(WStype_TEXT, ...) -> transitionToSpeaking()
void transitionToSpeaking() {
    vTaskDelay(50);

    i2sInputFlushScheduled = true;
    
    deviceState = SPEAKING;
    // digitalWrite(I2S_SD_OUT, HIGH);  // disabled - xiaozhi has no PA pin
    speakingStartTime = millis();
    
    // webSocket.enableHeartbeat(30000, 15000, 3);
    
    Serial.println("Transitioned to speaking mode");
}

// networkTask -> transitionToListening()
// ( networkTask -> webSocket.loop() -> webSocketEvent(WStype_TEXT, ...) -> (sets scheduleListeningRestart) -> networkTask -> transitionToListening() )
void transitionToListening() {
    deviceState = PROCESSING;
    scheduleListeningRestart = false;
    Serial.println("Transitioning to listening mode");

    i2sInputFlushScheduled = true;
    i2sOutputFlushScheduled = true;

    // Clear audio send queue to discard any stale audio
    clearAudioSendQueue();

    Serial.println("Transitioned to listening mode");

    deviceState = LISTENING;
    // digitalWrite(I2S_SD_OUT, LOW);  // disabled - xiaozhi has no PA pin
    // webSocket.disableHeartbeat();
}

// audioStreamTask: manual 16→32 bit pipeline matching xiaozhi bread-compact-wifi
void audioStreamTask(void *parameter) {
    Serial.println("[SPK] Starting I2S output (ESP-IDF legacy driver, 32-bit)...");

    // Opus decoder outputs 16-bit PCM into audioBuffer
    OpusSettings cfg;
    cfg.sample_rate = SAMPLE_RATE;
    cfg.channels = CHANNELS;
    cfg.bits_per_sample = BITS_PER_SAMPLE;  // 16-bit decode
    cfg.max_buffer_size = 6144;

    xSemaphoreTake(wsMutex, portMAX_DELAY);
    opusDecoder.setOutput(bufferPrint);
    opusDecoder.begin(cfg);
    xSemaphoreGive(wsMutex);

    audioBuffer.setReadMaxWait(0);

    // === Configure I2S directly via ESP-IDF legacy API (bypass AudioTools) ===
    Serial.printf("[SPK] I2S pins: BCK=%d, WS=%d, DATA=%d, PORT=%d\n",
        I2S_BCK_OUT, I2S_WS_OUT, I2S_DATA_OUT, I2S_PORT_OUT);

    i2s_config_t i2s_config = {};
    i2s_config.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
    i2s_config.sample_rate = SAMPLE_RATE;                    // 24000
    i2s_config.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;  // 32-bit (matching xiaozhi)
    i2s_config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;   // standard stereo
    i2s_config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    i2s_config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
    i2s_config.dma_buf_count = 6;       // matching xiaozhi DMA_DESC_NUM
    i2s_config.dma_buf_len = 240;       // matching xiaozhi DMA_FRAME_NUM
    i2s_config.use_apll = false;
    i2s_config.tx_desc_auto_clear = true;

    esp_err_t err = i2s_driver_install(I2S_PORT_OUT, &i2s_config, 0, NULL);
    Serial.printf("[SPK] i2s_driver_install: %s\n", esp_err_to_name(err));

    i2s_pin_config_t pin_config = {};
    pin_config.mck_io_num = I2S_PIN_NO_CHANGE;  // no MCLK needed
    pin_config.bck_io_num = I2S_BCK_OUT;
    pin_config.ws_io_num = I2S_WS_OUT;
    pin_config.data_out_num = I2S_DATA_OUT;
    pin_config.data_in_num = I2S_PIN_NO_CHANGE;

    err = i2s_set_pin(I2S_PORT_OUT, &pin_config);
    Serial.printf("[SPK] i2s_set_pin: %s\n", esp_err_to_name(err));

    i2s_zero_dma_buffer(I2S_PORT_OUT);

    err = i2s_start(I2S_PORT_OUT);
    Serial.printf("[SPK] i2s_start: %s\n", esp_err_to_name(err));

    Serial.println("[SPK] I2S TX ready: 32-bit, 24kHz, stereo frame (legacy driver)");

    // === Main loop: read 16-bit PCM from audioBuffer, convert to 32-bit stereo, write to I2S ===
    while (1) {
        if (i2sOutputFlushScheduled) {
            i2sOutputFlushScheduled = false;
            audioBuffer.reset();
            i2s_zero_dma_buffer(I2S_PORT_OUT);
            Serial.println("[SPK] Output flushed");
        }

        if (deviceState == SPEAKING && audioBuffer.available() > 0) {
            // Read 16-bit mono PCM samples from audioBuffer
            size_t bytesRead = audioBuffer.readArray((uint8_t*)spkBuf16, SPK_COPY_SAMPLES * sizeof(int16_t));
            int samplesRead = bytesRead / sizeof(int16_t);

            if (samplesRead > 0) {
                // Apply volume (quadratic scaling, matching xiaozhi)
                // currentVolume: 0-100, convert to 0.0-1.0 scale
                float volScale = (float)currentVolume / 100.0f;
                volScale = volScale * volScale;  // quadratic for perceptual loudness

                // Convert 16-bit mono → 32-bit stereo (left+right same data)
                for (int i = 0; i < samplesRead; i++) {
                    int32_t sample = (int32_t)(spkBuf16[i] * volScale);
                    // Clamp to 16-bit range before shifting to 32-bit
                    if (sample > 32767) sample = 32767;
                    if (sample < -32768) sample = -32768;
                    int32_t sample32 = sample << 16;  // 16-bit → upper 16 bits of 32-bit
                    spkBuf32[i * 2] = sample32;       // left channel
                    spkBuf32[i * 2 + 1] = sample32;   // right channel (duplicate mono)
                }

                size_t bytes_written = 0;
                i2s_write(I2S_PORT_OUT, spkBuf32, samplesRead * 2 * sizeof(int32_t), &bytes_written, portMAX_DELAY);
            }

            vTaskDelay(1);
        } else {
            vTaskDelay(10);
        }
    }
}


class WebsocketStream : public Print {
public:
    // micTask -> micToWsCopier.copyBytes() -> wsStream.write()
    virtual size_t write(uint8_t b) override {
        if (!webSocket.isConnected() || deviceState != LISTENING) {
            return 1;
        }
        
        xSemaphoreTake(wsMutex, portMAX_DELAY);
        webSocket.sendBIN(&b, 1);
        xSemaphoreGive(wsMutex);
        return 1;
    }
    
    // micTask -> micToWsCopier.copyBytes() -> wsStream.write()
    virtual size_t write(const uint8_t *buffer, size_t size) override {
        if (size == 0 || !webSocket.isConnected() || deviceState != LISTENING) {
            return size;
        }
        
        xSemaphoreTake(wsMutex, portMAX_DELAY);
        webSocket.sendBIN(buffer, size);
        xSemaphoreGive(wsMutex);
        return size;
    }
};

WebsocketStream wsStream; //guard with wsMutex
I2SStream i2sInput; //access from micTask only
volatile bool i2sInputFlushScheduled = false;

// Read 32-bit I2S samples, convert to 16-bit (matching xiaozhi approach)
const int MIC_READ_SAMPLES = 160; // 160 samples = 10ms at 16kHz
static int32_t mic_buf_32[MIC_READ_SAMPLES];
static int16_t mic_buf_16[MIC_READ_SAMPLES];

// Opus encoder for uplink audio
static OpusEncoder* micOpusEncoder = nullptr;
static int16_t micOpusFrameBuf[MIC_OPUS_FRAME_SAMPLES];  // 320 samples for 20ms frame
static int micOpusFramePos = 0;  // Current position in frame buffer
static uint8_t micOpusPacket[MIC_OPUS_MAX_PACKET_SIZE];  // Encoded packet buffer
static int micOpusPacketCount = 0;  // For logging

void micTask(void *parameter) {
    Serial.println("[MIC] Initializing I2S input...");

    // Initialize Opus encoder for 16kHz mono voice
    int opusError;
    micOpusEncoder = opus_encoder_create(MIC_SAMPLE_RATE, CHANNELS, OPUS_APPLICATION_VOIP, &opusError);
    if (opusError != OPUS_OK || !micOpusEncoder) {
        Serial.printf("[MIC] Failed to create Opus encoder, error: %d\n", opusError);
        vTaskDelete(NULL);
        return;
    }

    // Configure encoder for voice
    opus_encoder_ctl(micOpusEncoder, OPUS_SET_BITRATE(MIC_OPUS_BITRATE));
    opus_encoder_ctl(micOpusEncoder, OPUS_SET_COMPLEXITY(5));  // Balance between quality and CPU
    opus_encoder_ctl(micOpusEncoder, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
    Serial.printf("[MIC] Opus encoder initialized: %dHz, %dkbps, %dms frames\n",
                  MIC_SAMPLE_RATE, MIC_OPUS_BITRATE/1000, MIC_OPUS_FRAME_MS);

    // Configure I2S input as 32-bit (mic outputs 24-bit data in 32-bit frame)
    auto i2sConfig = i2sInput.defaultConfig(RX_MODE);
    i2sConfig.bits_per_sample = 32;  // Read 32-bit from mic
    i2sConfig.sample_rate = MIC_SAMPLE_RATE;
    i2sConfig.channels = CHANNELS;
    i2sConfig.i2s_format = I2S_STD_FORMAT;
    i2sConfig.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    i2sConfig.pin_bck = I2S_SCK;
    i2sConfig.pin_ws  = I2S_WS;
    i2sConfig.pin_data = I2S_SD;
    i2sConfig.port_no = I2S_PORT_IN;
    i2sInput.begin(i2sConfig);

    while (1) {
        if (i2sInputFlushScheduled) {
            i2sInputFlushScheduled = false;
            i2sInput.flush();
            micOpusFramePos = 0;  // Reset Opus frame buffer on flush
        }

        if (deviceState == LISTENING && webSocket.isConnected()) {
            // Read 32-bit samples from I2S
            size_t bytesRead = i2sInput.readBytes((uint8_t*)mic_buf_32, MIC_READ_SAMPLES * sizeof(int32_t));
            int samplesRead = bytesRead / sizeof(int32_t);

            if (samplesRead > 0) {
                // Convert 32-bit to 16-bit (right shift 12 bits, matching xiaozhi)
                for (int i = 0; i < samplesRead; i++) {
                    int32_t val = mic_buf_32[i] >> 12;
                    if (val > 32767) val = 32767;
                    if (val < -32768) val = -32768;
                    mic_buf_16[i] = (int16_t)val;
                }

                // Accumulate samples into Opus frame buffer and encode when full
                int samplesProcessed = 0;
                while (samplesProcessed < samplesRead) {
                    // Copy samples to frame buffer
                    int samplesToCopy = min(samplesRead - samplesProcessed,
                                           MIC_OPUS_FRAME_SAMPLES - micOpusFramePos);
                    memcpy(&micOpusFrameBuf[micOpusFramePos],
                           &mic_buf_16[samplesProcessed],
                           samplesToCopy * sizeof(int16_t));
                    micOpusFramePos += samplesToCopy;
                    samplesProcessed += samplesToCopy;

                    // When frame buffer is full, encode and send
                    if (micOpusFramePos >= MIC_OPUS_FRAME_SAMPLES) {
                        int encodedBytes = opus_encode(micOpusEncoder,
                                                       micOpusFrameBuf,
                                                       MIC_OPUS_FRAME_SAMPLES,
                                                       micOpusPacket,
                                                       MIC_OPUS_MAX_PACKET_SIZE);

                        if (encodedBytes > 0) {
                            micOpusPacketCount++;
                            if (micOpusPacketCount <= 5 || micOpusPacketCount % 50 == 0) {
                                Serial.printf("[MIC-OPUS] pkt#%d encoded=%dB (from %dB PCM)\n",
                                              micOpusPacketCount, encodedBytes, MIC_OPUS_FRAME_BYTES);
                            }

                            // Put Opus packet into queue (non-blocking)
                            // networkTask will consume and send via WebSocket
                            if (audioSendQueue != NULL && deviceState == LISTENING) {
                                AudioPacket packet;
                                memcpy(packet.data, micOpusPacket, encodedBytes);
                                packet.length = encodedBytes;

                                // Use non-blocking send to avoid mic task being blocked
                                if (xQueueSend(audioSendQueue, &packet, 0) != pdTRUE) {
                                    // Queue full - drop oldest packet and try again
                                    AudioPacket discarded;
                                    xQueueReceive(audioSendQueue, &discarded, 0);
                                    xQueueSend(audioSendQueue, &packet, 0);
                                    queueDropCount++;
                                    if (queueDropCount % 10 == 1) {
                                        Serial.printf("[MIC-OPUS] Queue full, dropped %d packets\n", queueDropCount);
                                    }
                                }
                            }
                        } else {
                            Serial.printf("[MIC-OPUS] Encode error: %d\n", encodedBytes);
                        }

                        micOpusFramePos = 0;  // Reset for next frame
                    }
                }
            }

            vTaskDelay(1);
        } else {
            vTaskDelay(10);
        }
    }
}

// WEBSOCKET EVENTS
// networkTask -> webSocket.loop() -> webSocketEvent()
void webSocketEvent(WStype_t type, const uint8_t *payload, size_t length)
{
    switch (type)
    {
    case WStype_DISCONNECTED:
        Serial.printf("[WSc] Disconnected!\n");
        deviceState = IDLE;
        break;
    case WStype_CONNECTED:
        Serial.printf("[WSc] Connected to url: %s\n", payload);
        deviceState = IDLE;  // Stay IDLE until user presses button to START_SESSION
        break;
    case WStype_TEXT:
    {
        Serial.printf("[WSc] get text: %s\n", payload);

        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, (char *)payload);

        if (error)
        {
            Serial.println("Error deserializing JSON");
            deviceState = IDLE;
            return;
        }

        String type = doc["type"];

        // auth messages
        if (strcmp((char*)type.c_str(), "auth") == 0) {
            currentVolume = doc["volume_control"].as<int>();
            currentPitchFactor = doc["pitch_factor"].as<float>();

            bool is_ota = doc["is_ota"].as<bool>();
            bool is_reset = doc["is_reset"].as<bool>();

            // Volume is applied directly in audioStreamTask 16→32 bit conversion
            Serial.printf("[AUTH] Volume=%d, PitchFactor=%.2f\n", currentVolume, currentPitchFactor);

            if (is_ota) {
                Serial.println("OTA update received");
                setOTAStatusInNVS(OTA_IN_PROGRESS);
                ESP.restart();
            }

            if (is_reset) {
                Serial.println("Factory reset received");
                // setFactoryResetStatusInNVS(true);
                ESP.restart();
            }

        }

        // oai messages
        if (strcmp((char*)type.c_str(), "server") == 0) {
            String msg = doc["msg"];
            Serial.println(msg);

            if (strcmp((char*)msg.c_str(), "RESPONSE.COMPLETE") == 0 || strcmp((char*)msg.c_str(), "RESPONSE.ERROR") == 0) {
                Serial.println("Received RESPONSE.COMPLETE or RESPONSE.ERROR, starting listening again");

                // Check if volume_control is included in the message
                if (doc.containsKey("volume_control")) {
                    currentVolume = doc["volume_control"].as<int>();
                    Serial.printf("[VOL] Updated volume to %d\n", currentVolume);
                }

                scheduleListeningRestart = true;
                scheduledTime = millis() + 1000; // 1 second delay
            } else if (strcmp((char*)msg.c_str(), "AUDIO.COMMITTED") == 0) {
                deviceState = PROCESSING; 
            } else if (strcmp((char*)msg.c_str(), "RESPONSE.CREATED") == 0) {
                Serial.println("Received RESPONSE.CREATED, transitioning to speaking");
                transitionToSpeaking();
            } else if (strcmp((char*)msg.c_str(), "SESSION.END") == 0) {
                Serial.println("Received SESSION.END, going to sleep");
                sleepRequested = true;
            }
#ifdef DISPLAY_ENABLED
            else if (strcmp((char*)msg.c_str(), "TRANSCRIPT.USER") == 0) {
                const char *text = doc["text"] | "";
                Serial.printf("[DISPLAY] TRANSCRIPT.USER text='%s'\n", text);
                displaySetChatMessage("user", text);
            } else if (strcmp((char*)msg.c_str(), "TRANSCRIPT.ASSISTANT") == 0) {
                const char *text = doc["text"] | "";
                Serial.printf("[DISPLAY] TRANSCRIPT.ASSISTANT text='%s'\n", text);
                displaySetChatMessage("assistant", text);
            }
#endif
        }
    }
        break;
    case WStype_BIN:
    {
        if (scheduleListeningRestart || deviceState != SPEAKING) {
            break;
        }

        // Otherwise process the audio data normally
        static int binCount = 0;
        binCount++;
        size_t processed = opusDecoder.write(payload, length);
        if (binCount % 20 == 1) {
            Serial.printf("[OPUS] pkt#%d in=%d processed=%d bufAvail=%d\n",
                binCount, length, processed, audioBuffer.available());
        }
        if (processed != length) {
            Serial.printf("Warning: Only processed %d/%d bytes\n", processed, length);
        }
        break;
      }
    case WStype_ERROR:
        Serial.printf("[WSc] Error: %s\n", payload);    
        break;
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_PONG:
    case WStype_PING:
    case WStype_FRAGMENT_FIN:
        break;
    }
}

// wifiTask -> WIFIMANAGER::loop() -> WIFIMANAGER::tryConnect() -> connectCb() -> websocketSetup()
void websocketSetup(const String& server_domain, int port, const String& path)
{
    const String headers =
        "Authorization: Bearer " + String(authTokenGlobal) + "\r\n" +
        "X-Wifi-Rssi: " + String(WiFi.RSSI()) + "\r\n" +
        "X-Device-Mac: " + WiFi.macAddress();

    xSemaphoreTake(wsMutex, portMAX_DELAY);

    webSocket.setExtraHeaders(headers.c_str());
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(1000);
    webSocket.disableHeartbeat();

    // webSocket.enableHeartbeat(30000, 15000, 3); // 30s ping interval, 15s timeout, 3 retries

    #ifdef DEV_MODE
    webSocket.begin(server_domain.c_str(), port, path.c_str());
    #else
    webSocket.beginSslWithCA(server_domain.c_str(), port, path.c_str(), CA_cert);
    #endif

    xSemaphoreGive(wsMutex);
}

// Toggle chat state: IDLE/PROCESSING → LISTENING, LISTENING → IDLE, SPEAKING → interrupt
// Sends START_SESSION / STOP_SESSION instructions to Server for on-demand Ultravox call management
void toggleChatState() {
    Serial.printf("[CHAT] toggleChatState, current state: %d\n", deviceState);
    switch (deviceState) {
        case IDLE:
        case PROCESSING:
            if (webSocket.isConnected()) {
                Serial.println("[CHAT] Sending START_SESSION to server");
                xSemaphoreTake(wsMutex, portMAX_DELAY);
                webSocket.sendTXT("{\"type\":\"instruction\",\"msg\":\"START_SESSION\"}");
                xSemaphoreGive(wsMutex);
                transitionToListening();
            } else {
                Serial.println("[CHAT] WebSocket not connected, cannot start listening");
            }
            break;
        case LISTENING:
            Serial.println("[CHAT] Sending STOP_SESSION, back to IDLE");
            xSemaphoreTake(wsMutex, portMAX_DELAY);
            webSocket.sendTXT("{\"type\":\"instruction\",\"msg\":\"STOP_SESSION\"}");
            xSemaphoreGive(wsMutex);
            clearAudioSendQueue();  // Clear any pending audio
            deviceState = IDLE;
            break;
        case SPEAKING:
            Serial.println("[CHAT] Interrupting speech, sending STOP_SESSION");
            xSemaphoreTake(wsMutex, portMAX_DELAY);
            webSocket.sendTXT("{\"type\":\"instruction\",\"msg\":\"STOP_SESSION\"}");
            xSemaphoreGive(wsMutex);
            scheduleListeningRestart = false;
            i2sOutputFlushScheduled = true;
            clearAudioSendQueue();  // Clear any pending audio
            deviceState = IDLE;
            break;
        default:
            Serial.printf("[CHAT] Ignoring toggle in state %d\n", deviceState);
            break;
    }
}

// networkTask -> webSocket.loop()
void networkTask(void *parameter) {
    // Create audio send queue
    audioSendQueue = xQueueCreate(AUDIO_SEND_QUEUE_SIZE, sizeof(AudioPacket));
    if (audioSendQueue == NULL) {
        Serial.println("[NET] Failed to create audio send queue!");
    } else {
        Serial.printf("[NET] Audio send queue created, size=%d packets (~%dms buffer)\n",
                      AUDIO_SEND_QUEUE_SIZE, AUDIO_SEND_QUEUE_SIZE * MIC_OPUS_FRAME_MS);
    }

    static int sendCount = 0;

    while (1) {
        xSemaphoreTake(wsMutex, portMAX_DELAY);

        // Check to see if a transition to listening mode is scheduled.
        if (scheduleListeningRestart && millis() >= scheduledTime) {
            transitionToListening();
        }

        // Send queued audio packets (process multiple packets per loop for efficiency)
        if (audioSendQueue != NULL && webSocket.isConnected() && deviceState == LISTENING) {
            AudioPacket packet;
            int packetsSentThisLoop = 0;
            const int maxPacketsPerLoop = 5;  // Limit to avoid starving webSocket.loop()

            while (packetsSentThisLoop < maxPacketsPerLoop &&
                   xQueueReceive(audioSendQueue, &packet, 0) == pdTRUE) {
                webSocket.sendBIN(packet.data, packet.length);
                packetsSentThisLoop++;
                sendCount++;

                if (sendCount <= 5 || sendCount % 100 == 0) {
                    int queueRemaining = uxQueueMessagesWaiting(audioSendQueue);
                    Serial.printf("[NET] Sent pkt#%d, len=%d, queue=%d\n",
                                  sendCount, packet.length, queueRemaining);
                }
            }
        }

        webSocket.loop();
        xSemaphoreGive(wsMutex);

        vTaskDelay(1);
    }
}