#include "elato_protocol.h"
#include "board.h"
#include "system_info.h"
#include "application.h"
#include "settings.h"
#include "audio_service.h"
#include "timer_manager.h"

#include <cstring>
#include <cJSON.h>
#include <esp_log.h>
#include <wifi_manager.h>
#include "assets/lang_config.h"

// Base64 decoding helper
#include <mbedtls/base64.h>

#define TAG "ElatoProtocol"

ElatoProtocol::ElatoProtocol() {
    event_group_handle_ = xEventGroupCreate();
    // ElatoAI uses 24kHz output, 20ms frames
    server_sample_rate_ = 24000;
    server_frame_duration_ = 20;
}

ElatoProtocol::~ElatoProtocol() {
    vEventGroupDelete(event_group_handle_);
}

bool ElatoProtocol::Start() {
    // Only connect to server when audio channel is needed
    return true;
}

bool ElatoProtocol::SendAudio(std::unique_ptr<AudioStreamPacket> packet) {
    if (websocket_ == nullptr || !websocket_->IsConnected()) {
        return false;
    }

    // ElatoAI uses version 1: raw Opus payload, no header
    return websocket_->Send(packet->payload.data(), packet->payload.size(), true);
}

bool ElatoProtocol::SendText(const std::string& text) {
    if (websocket_ == nullptr || !websocket_->IsConnected()) {
        return false;
    }

    if (!websocket_->Send(text)) {
        ESP_LOGE(TAG, "Failed to send text: %s", text.c_str());
        SetError(Lang::Strings::SERVER_ERROR);
        return false;
    }

    return true;
}

bool ElatoProtocol::IsAudioChannelOpened() const {
    return websocket_ != nullptr && websocket_->IsConnected() && !error_occurred_ && !IsTimeout();
}

void ElatoProtocol::CloseAudioChannel(bool send_goodbye) {
    if (send_goodbye && websocket_ != nullptr && websocket_->IsConnected()) {
        // Send STOP_SESSION before closing
        SendText("{\"type\":\"instruction\",\"msg\":\"STOP_SESSION\"}");
    }
    websocket_.reset();
}

bool ElatoProtocol::OpenAudioChannel() {
    Settings settings("websocket", false);
    std::string url = settings.GetString("url");
    std::string token = settings.GetString("token");

    ESP_LOGI(TAG, "Connecting to ElatoAI server: %s", url.c_str());
    ESP_LOGI(TAG, "Token length: %d, empty: %s", (int)token.length(), token.empty() ? "yes" : "no");

    if (url.empty()) {
        // Default to Kconfig value
        url = CONFIG_ELATO_WS_URL;
        ESP_LOGW(TAG, "WebSocket URL not configured, using default: %s", url.c_str());
    }

    error_occurred_ = false;

    auto network = Board::GetInstance().GetNetwork();
    websocket_ = network->CreateWebSocket(1);
    if (websocket_ == nullptr) {
        ESP_LOGE(TAG, "Failed to create websocket");
        return false;
    }

    // Set ElatoAI specific headers
    if (!token.empty()) {
        std::string auth_header = "Bearer " + token;
        websocket_->SetHeader("Authorization", auth_header.c_str());
    }
    websocket_->SetHeader("X-Device-Mac", SystemInfo::GetMacAddress().c_str());

    // Get WiFi RSSI
    auto& wifi = WifiManager::GetInstance();
    websocket_->SetHeader("X-Wifi-Rssi", std::to_string(wifi.GetRssi()).c_str());

    websocket_->OnData([this](const char* data, size_t len, bool binary) {
        if (binary) {
            // Incoming Opus audio from server (raw payload, version 1)
            if (on_incoming_audio_ != nullptr) {
                on_incoming_audio_(std::make_unique<AudioStreamPacket>(AudioStreamPacket{
                    .sample_rate = server_sample_rate_,
                    .frame_duration = server_frame_duration_,
                    .timestamp = 0,
                    .payload = std::vector<uint8_t>((uint8_t*)data, (uint8_t*)data + len)
                }));
            }
        } else {
            // Parse JSON data
            auto root = cJSON_Parse(data);
            if (root == nullptr) {
                ESP_LOGE(TAG, "Failed to parse JSON: %s", data);
                return;
            }

            auto type = cJSON_GetObjectItem(root, "type");
            if (cJSON_IsString(type)) {
                if (strcmp(type->valuestring, "auth") == 0) {
                    ParseAuthMessage(root);
                } else if (strcmp(type->valuestring, "server") == 0) {
                    ParseServerMessage(root);
                } else {
                    // Forward other messages to application
                    if (on_incoming_json_ != nullptr) {
                        on_incoming_json_(root);
                    }
                }
            } else {
                ESP_LOGE(TAG, "Missing message type, data: %s", data);
            }
            cJSON_Delete(root);
        }
        last_incoming_time_ = std::chrono::steady_clock::now();
    });

    websocket_->OnDisconnected([this]() {
        ESP_LOGI(TAG, "Websocket disconnected");
        if (on_audio_channel_closed_ != nullptr) {
            on_audio_channel_closed_();
        }
    });

    ESP_LOGI(TAG, "Connecting to ElatoAI server: %s", url.c_str());
    if (!websocket_->Connect(url.c_str())) {
        ESP_LOGE(TAG, "Failed to connect to websocket server, code=%d", websocket_->GetLastError());
        SetError(Lang::Strings::SERVER_NOT_CONNECTED);
        return false;
    }

    // Wait for auth message from server
    EventBits_t bits = xEventGroupWaitBits(event_group_handle_, ELATO_PROTOCOL_SERVER_AUTH_EVENT,
                                            pdTRUE, pdFALSE, pdMS_TO_TICKS(10000));
    if (!(bits & ELATO_PROTOCOL_SERVER_AUTH_EVENT)) {
        ESP_LOGE(TAG, "Failed to receive auth message from server");
        SetError(Lang::Strings::SERVER_TIMEOUT);
        return false;
    }

    if (on_audio_channel_opened_ != nullptr) {
        on_audio_channel_opened_();
    }

    return true;
}

std::string ElatoProtocol::GetHelloMessage() {
    // ElatoAI server doesn't require client hello, but we can send device info
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "hello");
    cJSON_AddStringToObject(root, "device_mac", SystemInfo::GetMacAddress().c_str());
    cJSON_AddStringToObject(root, "board_id", Board::GetInstance().GetUuid().c_str());

    cJSON* audio_params = cJSON_CreateObject();
    cJSON_AddStringToObject(audio_params, "format", "opus");
    cJSON_AddNumberToObject(audio_params, "sample_rate", 16000);
    cJSON_AddNumberToObject(audio_params, "channels", 1);
    cJSON_AddNumberToObject(audio_params, "frame_duration", OPUS_FRAME_DURATION_MS);
    cJSON_AddItemToObject(root, "audio_params", audio_params);

    auto json_str = cJSON_PrintUnformatted(root);
    std::string message(json_str);
    cJSON_free(json_str);
    cJSON_Delete(root);
    return message;
}

void ElatoProtocol::ParseAuthMessage(const cJSON* root) {
    // Extract volume control and pitch factor from auth response
    auto volume_control = cJSON_GetObjectItem(root, "volume_control");
    if (cJSON_IsNumber(volume_control)) {
        ESP_LOGI(TAG, "Volume control: %d", volume_control->valueint);
        // Store or apply volume setting
        auto codec = Board::GetInstance().GetAudioCodec();
        if (codec) {
            codec->SetOutputVolume(volume_control->valueint);
        }
    }

    auto pitch_factor = cJSON_GetObjectItem(root, "pitch_factor");
    if (cJSON_IsNumber(pitch_factor)) {
        ESP_LOGI(TAG, "Pitch factor: %.2f", pitch_factor->valuedouble);
    }

    // Check for OTA or reset commands
    auto is_ota = cJSON_GetObjectItem(root, "is_ota");
    if (cJSON_IsTrue(is_ota)) {
        ESP_LOGI(TAG, "OTA update requested, rebooting device");
        // Reboot to trigger OTA check
        Application::GetInstance().Reboot();
        return;
    }

    auto is_reset = cJSON_GetObjectItem(root, "is_reset");
    if (cJSON_IsTrue(is_reset)) {
        ESP_LOGI(TAG, "Factory reset requested");
        esp_restart();
        return;
    }

    // Signal that auth was received
    xEventGroupSetBits(event_group_handle_, ELATO_PROTOCOL_SERVER_AUTH_EVENT);
}

void ElatoProtocol::ParseServerMessage(const cJSON* root) {
    auto msg = cJSON_GetObjectItem(root, "msg");
    if (!cJSON_IsString(msg)) {
        return;
    }

    const char* msg_str = msg->valuestring;
    ESP_LOGI(TAG, "Server message: %s", msg_str);

    if (on_incoming_json_ == nullptr) {
        return;
    }

    // Convert server messages to Application-expected format
    if (strcmp(msg_str, "RESPONSE.CREATED") == 0) {
        // AI is about to speak -> tts start
        cJSON* tts_msg = cJSON_CreateObject();
        cJSON_AddStringToObject(tts_msg, "type", "tts");
        cJSON_AddStringToObject(tts_msg, "state", "start");
        on_incoming_json_(tts_msg);
        cJSON_Delete(tts_msg);
    } else if (strcmp(msg_str, "RESPONSE.COMPLETE") == 0 ||
               strcmp(msg_str, "RESPONSE.ERROR") == 0) {
        // Response finished -> tts stop
        // Check for volume update first
        auto volume_control = cJSON_GetObjectItem(root, "volume_control");
        if (cJSON_IsNumber(volume_control)) {
            auto codec = Board::GetInstance().GetAudioCodec();
            if (codec) {
                codec->SetOutputVolume(volume_control->valueint);
            }
        }
        cJSON* tts_msg = cJSON_CreateObject();
        cJSON_AddStringToObject(tts_msg, "type", "tts");
        cJSON_AddStringToObject(tts_msg, "state", "stop");
        on_incoming_json_(tts_msg);
        cJSON_Delete(tts_msg);
    } else if (strcmp(msg_str, "TRANSCRIPT.USER") == 0) {
        // User transcript -> stt
        auto text = cJSON_GetObjectItem(root, "text");
        if (cJSON_IsString(text) && strlen(text->valuestring) > 0) {
            cJSON* stt_msg = cJSON_CreateObject();
            cJSON_AddStringToObject(stt_msg, "type", "stt");
            cJSON_AddStringToObject(stt_msg, "text", text->valuestring);
            on_incoming_json_(stt_msg);
            cJSON_Delete(stt_msg);
        }
    } else if (strcmp(msg_str, "TRANSCRIPT.ASSISTANT") == 0) {
        // Assistant transcript -> tts sentence_start
        auto text = cJSON_GetObjectItem(root, "text");
        if (cJSON_IsString(text) && strlen(text->valuestring) > 0) {
            cJSON* tts_msg = cJSON_CreateObject();
            cJSON_AddStringToObject(tts_msg, "type", "tts");
            cJSON_AddStringToObject(tts_msg, "state", "sentence_start");
            cJSON_AddStringToObject(tts_msg, "text", text->valuestring);
            on_incoming_json_(tts_msg);
            cJSON_Delete(tts_msg);
        }
    } else if (strcmp(msg_str, "AUDIO.COMMITTED") == 0) {
        // User speech detected by AI -> interrupt current playback
        // This enables barge-in: user can interrupt AI while it's speaking
        cJSON* interrupt_msg = cJSON_CreateObject();
        cJSON_AddStringToObject(interrupt_msg, "type", "tts");
        cJSON_AddStringToObject(interrupt_msg, "state", "interrupt");
        on_incoming_json_(interrupt_msg);
        cJSON_Delete(interrupt_msg);
    } else if (strcmp(msg_str, "SESSION.END") == 0) {
        // Session ended -> tts stop
        cJSON* tts_msg = cJSON_CreateObject();
        cJSON_AddStringToObject(tts_msg, "type", "tts");
        cJSON_AddStringToObject(tts_msg, "state", "stop");
        on_incoming_json_(tts_msg);
        cJSON_Delete(tts_msg);
    }
    // Chef AI: Timer messages
    else if (strcmp(msg_str, "TIMER.SET") == 0) {
        ParseTimerSetMessage(root);
    } else if (strcmp(msg_str, "TIMER.CANCEL") == 0) {
        ParseTimerCancelMessage(root);
    } else if (strcmp(msg_str, "TIMER.AUDIO") == 0) {
        ParseTimerAudioMessage(root);
    }
    // Chef AI: Recipe session messages
    else if (strcmp(msg_str, "RECIPE.SESSION") == 0) {
        ParseRecipeSessionMessage(root);
    }
}

void ElatoProtocol::ParseTimerSetMessage(const cJSON* root) {
    auto timer_name = cJSON_GetObjectItem(root, "timer_name");
    auto duration = cJSON_GetObjectItem(root, "duration_seconds");
    auto reminder = cJSON_GetObjectItem(root, "reminder_phrase");

    if (!cJSON_IsString(timer_name) || !cJSON_IsNumber(duration)) {
        ESP_LOGE(TAG, "Invalid TIMER.SET message");
        return;
    }

    const char* name = timer_name->valuestring;
    uint32_t seconds = duration->valueint;
    const char* phrase = cJSON_IsString(reminder) ? reminder->valuestring : "Time's up!";

    auto& timerMgr = TimerManager::GetInstance();
    if (timerMgr.SetTimer(name, seconds, phrase)) {
        ESP_LOGI(TAG, "Timer set: %s for %lu seconds", name, (unsigned long)seconds);
    } else {
        ESP_LOGE(TAG, "Failed to set timer: %s", name);
    }
}

void ElatoProtocol::ParseTimerCancelMessage(const cJSON* root) {
    auto timer_name = cJSON_GetObjectItem(root, "timer_name");
    if (!cJSON_IsString(timer_name)) {
        ESP_LOGE(TAG, "Invalid TIMER.CANCEL message");
        return;
    }

    auto& timerMgr = TimerManager::GetInstance();
    if (timerMgr.CancelTimer(timer_name->valuestring)) {
        ESP_LOGI(TAG, "Timer cancelled: %s", timer_name->valuestring);
    }
}

void ElatoProtocol::ParseTimerAudioMessage(const cJSON* root) {
    auto timer_name = cJSON_GetObjectItem(root, "timer_name");
    auto audio_base64 = cJSON_GetObjectItem(root, "audio_base64");
    auto audio_size = cJSON_GetObjectItem(root, "audio_size");

    if (!cJSON_IsString(timer_name) || !cJSON_IsString(audio_base64)) {
        ESP_LOGE(TAG, "Invalid TIMER.AUDIO message");
        return;
    }

    // Decode base64 audio
    const char* b64_data = audio_base64->valuestring;
    size_t b64_len = strlen(b64_data);
    size_t decoded_len = 0;

    // Calculate required buffer size
    size_t max_decoded_len = (b64_len * 3) / 4 + 4;
    uint8_t* decoded_audio = (uint8_t*)malloc(max_decoded_len);
    if (!decoded_audio) {
        ESP_LOGE(TAG, "Failed to allocate memory for audio decode");
        return;
    }

    int ret = mbedtls_base64_decode(decoded_audio, max_decoded_len, &decoded_len,
                                     (const unsigned char*)b64_data, b64_len);
    if (ret != 0) {
        ESP_LOGE(TAG, "Base64 decode failed: %d", ret);
        free(decoded_audio);
        return;
    }

    // Set audio on timer
    auto& timerMgr = TimerManager::GetInstance();
    if (timerMgr.SetTimerAudio(timer_name->valuestring, decoded_audio, decoded_len)) {
        ESP_LOGI(TAG, "Timer audio set: %s (%zu bytes)", timer_name->valuestring, decoded_len);
    }

    free(decoded_audio);
}

void ElatoProtocol::ParseRecipeSessionMessage(const cJSON* root) {
    auto recipe_name = cJSON_GetObjectItem(root, "recipe_name");
    auto total_steps = cJSON_GetObjectItem(root, "total_steps");
    auto current_step = cJSON_GetObjectItem(root, "current_step");

    if (!cJSON_IsString(recipe_name) || !cJSON_IsNumber(total_steps)) {
        ESP_LOGE(TAG, "Invalid RECIPE.SESSION message");
        return;
    }

    ESP_LOGI(TAG, "Recipe session: %s, step %d/%d",
             recipe_name->valuestring,
             cJSON_IsNumber(current_step) ? current_step->valueint : 1,
             total_steps->valueint);

    // Forward to application for display
    if (on_incoming_json_ != nullptr) {
        cJSON* recipe_msg = cJSON_CreateObject();
        cJSON_AddStringToObject(recipe_msg, "type", "recipe");
        cJSON_AddStringToObject(recipe_msg, "recipe_name", recipe_name->valuestring);
        cJSON_AddNumberToObject(recipe_msg, "total_steps", total_steps->valueint);
        cJSON_AddNumberToObject(recipe_msg, "current_step",
                                cJSON_IsNumber(current_step) ? current_step->valueint : 1);
        on_incoming_json_(recipe_msg);
        cJSON_Delete(recipe_msg);
    }
}

void ElatoProtocol::SendWakeWordDetected(const std::string& wake_word) {
    // Only log wake word info, do NOT send START_SESSION here
    // START_SESSION will be sent by SendStartListening() in HandleStateChangedEvent
    // This prevents duplicate START_SESSION causing multiple sessions on server
    ESP_LOGI(TAG, "Wake word detected: %s (session will start via SendStartListening)", wake_word.c_str());
}

void ElatoProtocol::SendStartListening(ListeningMode mode) {
    // Send START_SESSION instruction to ElatoAI server
    ESP_LOGI(TAG, "Start listening, mode: %d", mode);
    SendText("{\"type\":\"instruction\",\"msg\":\"START_SESSION\"}");
}

void ElatoProtocol::SendStopListening() {
    // Send STOP_SESSION instruction to ElatoAI server
    ESP_LOGI(TAG, "Stop listening");
    SendText("{\"type\":\"instruction\",\"msg\":\"STOP_SESSION\"}");
}

void ElatoProtocol::SendAbortSpeaking(AbortReason reason) {
    // Interrupt current response
    ESP_LOGI(TAG, "Abort speaking, reason: %d", reason);
    SendText("{\"type\":\"instruction\",\"msg\":\"STOP_SESSION\"}");
}
