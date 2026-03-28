#include "wifi_board.h"

#include "display.h"
#include "application.h"
#include "system_info.h"
#include "settings.h"
#include "assets/lang_config.h"

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_network.h>
#include <esp_log.h>
#include <utility>

#include <font_awesome.h>
#include <wifi_manager.h>
#include <wifi_station.h>
#include <ssid_manager.h>
#include "afsk_demod.h"
#ifdef CONFIG_USE_ESP_BLUFI_WIFI_PROVISIONING
#include "blufi.h"
#endif

static const char *TAG = "WifiBoard";

// Connection timeout in seconds
static constexpr int CONNECT_TIMEOUT_SEC = 60;

WifiBoard::WifiBoard() {
    // Create connection timeout timer
    esp_timer_create_args_t timer_args = {
        .callback = OnWifiConnectTimeout,
        .arg = this,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "wifi_connect_timer",
        .skip_unhandled_events = true
    };
    esp_timer_create(&timer_args, &connect_timer_);
}

WifiBoard::~WifiBoard() {
    if (connect_timer_) {
        esp_timer_stop(connect_timer_);
        esp_timer_delete(connect_timer_);
    }
}

std::string WifiBoard::GetBoardType() {
    return "wifi";
}

void WifiBoard::StartNetwork() {
    auto& wifi_manager = WifiManager::GetInstance();

    // Initialize WiFi manager
    WifiManagerConfig config;
    config.ssid_prefix = "ELATO-DEVICE";
    config.language = Lang::CODE;
    wifi_manager.Initialize(config);

    // Set unified event callback - forward to NetworkEvent with SSID data
    wifi_manager.SetEventCallback([this](WifiEvent event, const std::string& data) {
        switch (event) {
            case WifiEvent::Scanning:
                OnNetworkEvent(NetworkEvent::Scanning);
                break;
            case WifiEvent::Connecting:
                OnNetworkEvent(NetworkEvent::Connecting, data);
                break;
            case WifiEvent::Connected:
                OnNetworkEvent(NetworkEvent::Connected, data);
                break;
            case WifiEvent::Disconnected:
                OnNetworkEvent(NetworkEvent::Disconnected);
                break;
            case WifiEvent::ConfigModeEnter:
                OnNetworkEvent(NetworkEvent::WifiConfigModeEnter);
                break;
            case WifiEvent::ConfigModeExit:
                OnNetworkEvent(NetworkEvent::WifiConfigModeExit);
                break;
        }
    });

    // Try to connect or enter config mode
    TryWifiConnect();
}

void WifiBoard::TryWifiConnect() {
    auto& ssid_manager = SsidManager::GetInstance();
    bool have_ssid = !ssid_manager.GetSsidList().empty();

    if (have_ssid) {
        // Start connection attempt with timeout
        ESP_LOGI(TAG, "Starting WiFi connection attempt");
        esp_timer_start_once(connect_timer_, CONNECT_TIMEOUT_SEC * 1000000ULL);
        WifiManager::GetInstance().StartStation();
    } else {
        // No SSID configured, enter config mode
        // Wait for the board version to be shown
        vTaskDelay(pdMS_TO_TICKS(1500));
        StartWifiConfigMode();
    }
}

void WifiBoard::OnNetworkEvent(NetworkEvent event, const std::string& data) {
    switch (event) {
        case NetworkEvent::Connected:
            // Stop timeout timer
            esp_timer_stop(connect_timer_);
#ifdef CONFIG_USE_ESP_BLUFI_WIFI_PROVISIONING
            // make sure blufi resources has been released
            Blufi::GetInstance().deinit();
#endif
            in_config_mode_ = false;
            ESP_LOGI(TAG, "Connected to WiFi: %s", data.c_str());
            // Fetch ElatoAI auth token after WiFi connects
            FetchElatoToken();
            break;
        case NetworkEvent::Scanning:
            ESP_LOGI(TAG, "WiFi scanning");
            break;
        case NetworkEvent::Connecting:
            ESP_LOGI(TAG, "WiFi connecting to %s", data.c_str());
            break;
        case NetworkEvent::Disconnected:
            ESP_LOGW(TAG, "WiFi disconnected");
            break;
        case NetworkEvent::WifiConfigModeEnter:
            ESP_LOGI(TAG, "WiFi config mode entered");
            in_config_mode_ = true;
            break;
        case NetworkEvent::WifiConfigModeExit:
            ESP_LOGI(TAG, "WiFi config mode exited");
            in_config_mode_ = false;
            // Try to connect with the new credentials
            TryWifiConnect();
            break;
        default:
            break;
    }

    // Notify external callback if set
    if (network_event_callback_) {
        network_event_callback_(event, data);
    }
}

void WifiBoard::SetNetworkEventCallback(NetworkEventCallback callback) {
    network_event_callback_ = std::move(callback);
}

void WifiBoard::OnWifiConnectTimeout(void* arg) {
    auto* board = static_cast<WifiBoard*>(arg);
    ESP_LOGW(TAG, "WiFi connection timeout, entering config mode");

    WifiManager::GetInstance().StopStation();
    board->StartWifiConfigMode();
}

void WifiBoard::StartWifiConfigMode() {
    in_config_mode_ = true;
    // Transition to wifi configuring state
    Application::GetInstance().SetDeviceState(kDeviceStateWifiConfiguring);
#ifdef CONFIG_USE_HOTSPOT_WIFI_PROVISIONING
    auto& wifi_manager = WifiManager::GetInstance();

    wifi_manager.StartConfigAp();

    // Show config prompt after a short delay
    Application::GetInstance().Schedule([&wifi_manager]() {
        std::string hint = Lang::Strings::CONNECT_TO_HOTSPOT;
        hint += wifi_manager.GetApSsid();
        hint += Lang::Strings::ACCESS_VIA_BROWSER;
        hint += wifi_manager.GetApWebUrl();

        Application::GetInstance().Alert(Lang::Strings::WIFI_CONFIG_MODE, hint.c_str(), "gear", Lang::Sounds::OGG_WIFICONFIG);
    });
#elif CONFIG_USE_ESP_BLUFI_WIFI_PROVISIONING
    auto &blufi = Blufi::GetInstance();
    // initialize esp-blufi protocol
    blufi.init();
#endif
#if CONFIG_USE_ACOUSTIC_WIFI_PROVISIONING
    // Start acoustic provisioning task
    auto codec = Board::GetInstance().GetAudioCodec();
    int channel = codec ? codec->input_channels() : 1;
    ESP_LOGI(TAG, "Starting acoustic WiFi provisioning, channels: %d", channel);

    xTaskCreate([](void* arg) {
        auto ch = reinterpret_cast<intptr_t>(arg);
        auto& app = Application::GetInstance();
        auto& wifi = WifiManager::GetInstance();
        auto disp = Board::GetInstance().GetDisplay();
        audio_wifi_config::ReceiveWifiCredentialsFromAudio(&app, &wifi, disp, ch);
        vTaskDelete(NULL);
    }, "acoustic_wifi", 4096, reinterpret_cast<void*>(channel), 2, NULL);
#endif
}

void WifiBoard::EnterWifiConfigMode() {
    ESP_LOGI(TAG, "EnterWifiConfigMode called");
    GetDisplay()->ShowNotification(Lang::Strings::ENTERING_WIFI_CONFIG_MODE);

    auto& app = Application::GetInstance();
    auto state = app.GetDeviceState();

    if (state == kDeviceStateSpeaking || state == kDeviceStateListening || state == kDeviceStateIdle) {
        // Reset protocol (close audio channel, reset protocol)
        Application::GetInstance().ResetProtocol();

        xTaskCreate([](void* arg) {
            auto* board = static_cast<WifiBoard*>(arg);

            // Wait for 1 second to allow speaking to finish gracefully
            vTaskDelay(pdMS_TO_TICKS(1000));

            // Stop any ongoing connection attempt
            esp_timer_stop(board->connect_timer_);
            WifiManager::GetInstance().StopStation();

            // Enter config mode
            board->StartWifiConfigMode();

            vTaskDelete(NULL);
        }, "wifi_cfg_delay", 4096, this, 2, NULL);
        return;
    }

    if (state != kDeviceStateStarting) {
        ESP_LOGE(TAG, "EnterWifiConfigMode called but device state is not starting or speaking, device state: %d", state);
        return;
    }

    // Stop any ongoing connection attempt
    esp_timer_stop(connect_timer_);
    WifiManager::GetInstance().StopStation();

    StartWifiConfigMode();
}

bool WifiBoard::IsInWifiConfigMode() const {
    return WifiManager::GetInstance().IsConfigMode();
}

NetworkInterface* WifiBoard::GetNetwork() {
    static EspNetwork network;
    return &network;
}

const char* WifiBoard::GetNetworkStateIcon() {
    auto& wifi = WifiManager::GetInstance();

    if (wifi.IsConfigMode()) {
        return FONT_AWESOME_WIFI;
    }
    if (!wifi.IsConnected()) {
        return FONT_AWESOME_WIFI_SLASH;
    }

    int rssi = wifi.GetRssi();
    if (rssi >= -65) {
        return FONT_AWESOME_WIFI;
    } else if (rssi >= -75) {
        return FONT_AWESOME_WIFI_FAIR;
    }
    return FONT_AWESOME_WIFI_WEAK;
}

std::string WifiBoard::GetBoardJson() {
    auto& wifi = WifiManager::GetInstance();
    std::string json = R"({"type":")" + std::string(BOARD_TYPE) + R"(",)";
    json += R"("name":")" + std::string(BOARD_NAME) + R"(",)";

    if (!wifi.IsConfigMode()) {
        json += R"("ssid":")" + wifi.GetSsid() + R"(",)";
        json += R"("rssi":)" + std::to_string(wifi.GetRssi()) + R"(,)";
        json += R"("channel":)" + std::to_string(wifi.GetChannel()) + R"(,)";
        json += R"("ip":")" + wifi.GetIpAddress() + R"(",)";
    }

    json += R"("mac":")" + SystemInfo::GetMacAddress() + R"("})";
    return json;
}

void WifiBoard::SetPowerSaveLevel(PowerSaveLevel level) {
    WifiPowerSaveLevel wifi_level;
    switch (level) {
        case PowerSaveLevel::LOW_POWER:
            wifi_level = WifiPowerSaveLevel::LOW_POWER;
            break;
        case PowerSaveLevel::BALANCED:
            wifi_level = WifiPowerSaveLevel::BALANCED;
            break;
        case PowerSaveLevel::PERFORMANCE:
        default:
            wifi_level = WifiPowerSaveLevel::PERFORMANCE;
            break;
    }
    WifiManager::GetInstance().SetPowerSaveLevel(wifi_level);
}

std::string WifiBoard::GetDeviceStatusJson() {
    auto& board = Board::GetInstance();
    auto root = cJSON_CreateObject();

    // Audio speaker
    auto audio_speaker = cJSON_CreateObject();
    if (auto codec = board.GetAudioCodec()) {
        cJSON_AddNumberToObject(audio_speaker, "volume", codec->output_volume());
    }
    cJSON_AddItemToObject(root, "audio_speaker", audio_speaker);

    // Screen
    auto screen = cJSON_CreateObject();
    if (auto backlight = board.GetBacklight()) {
        cJSON_AddNumberToObject(screen, "brightness", backlight->brightness());
    }
    if (auto display = board.GetDisplay(); display && display->height() > 64) {
        if (auto theme = display->GetTheme()) {
            cJSON_AddStringToObject(screen, "theme", theme->name().c_str());
        }
    }
    cJSON_AddItemToObject(root, "screen", screen);

    // Battery
    int level = 0;
    bool charging = false, discharging = false;
    if (board.GetBatteryLevel(level, charging, discharging)) {
        auto battery = cJSON_CreateObject();
        cJSON_AddNumberToObject(battery, "level", level);
        cJSON_AddBoolToObject(battery, "charging", charging);
        cJSON_AddItemToObject(root, "battery", battery);
    }

    // Network
    auto& wifi = WifiManager::GetInstance();
    auto network = cJSON_CreateObject();
    cJSON_AddStringToObject(network, "type", "wifi");
    cJSON_AddStringToObject(network, "ssid", wifi.GetSsid().c_str());
    int rssi = wifi.GetRssi();
    const char* signal = rssi >= -60 ? "strong" : (rssi >= -70 ? "medium" : "weak");
    cJSON_AddStringToObject(network, "signal", signal);
    cJSON_AddItemToObject(root, "network", network);

    // Chip temperature
    float temp = 0.0f;
    if (board.GetTemperature(temp)) {
        auto chip = cJSON_CreateObject();
        cJSON_AddNumberToObject(chip, "temperature", temp);
        cJSON_AddItemToObject(root, "chip", chip);
    }

    auto str = cJSON_PrintUnformatted(root);
    std::string result(str);
    cJSON_free(str);
    cJSON_Delete(root);
    return result;
}

void WifiBoard::FetchElatoToken() {
    ESP_LOGI(TAG, "Fetching ElatoAI auth token...");

    // Get MAC address
    std::string mac = SystemInfo::GetMacAddress();

    // Build URL for token endpoint
    Settings wifi_settings("wifi", false);
    std::string backend_url = wifi_settings.GetString("backend_url", "http://35.162.7.133");
    std::string token_url = backend_url + "/api/generate_auth_token?macAddress=" + mac;

    ESP_LOGI(TAG, "Token URL: %s", token_url.c_str());

    auto network = GetNetwork();
    auto http = network->CreateHttp(0);
    if (!http) {
        ESP_LOGE(TAG, "Failed to create HTTP client");
        return;
    }

    http->SetHeader("User-Agent", SystemInfo::GetUserAgent());
    http->SetHeader("Content-Type", "application/json");

    if (!http->Open("GET", token_url)) {
        ESP_LOGE(TAG, "Failed to connect to token endpoint");
        return;
    }

    auto response = http->ReadAll();
    int status_code = http->GetStatusCode();
    http->Close();

    if (status_code != 200) {
        ESP_LOGE(TAG, "Token request failed with status %d", status_code);
        return;
    }

    // Parse JSON response
    auto root = cJSON_Parse(response.c_str());
    if (!root) {
        ESP_LOGE(TAG, "Failed to parse token response");
        return;
    }

    // Check for pending status (device not yet registered)
    auto status = cJSON_GetObjectItem(root, "status");
    if (cJSON_IsString(status) && strcmp(status->valuestring, "pending") == 0) {
        ESP_LOGI(TAG, "Device pending registration, MAC: %s", mac.c_str());
        registration_pending_ = true;

        // Show MAC address on display for user to register
        auto display = GetDisplay();
        if (display) {
            std::string hint = Lang::Strings::REGISTER_PENDING;
            hint += "\n";
            hint += mac;
            display->ShowNotification(hint);
        }

        // Start polling for registration completion
        StartRegistrationPolling();

        cJSON_Delete(root);
        return;
    }

    auto token = cJSON_GetObjectItem(root, "token");
    auto ws_url = cJSON_GetObjectItem(root, "ws_url");

    if (!cJSON_IsString(token)) {
        ESP_LOGE(TAG, "Token not found in response");
        cJSON_Delete(root);
        return;
    }

    // Store token in NVS
    Settings settings("websocket", true);
    settings.SetString("token", token->valuestring);

    // Store WebSocket URL if provided, otherwise construct from backend_url
    if (cJSON_IsString(ws_url)) {
        settings.SetString("url", ws_url->valuestring);
        ESP_LOGI(TAG, "Token received, WS URL: %s", ws_url->valuestring);
    } else {
        // Default WebSocket URL based on backend (direct to Deno, bypass nginx)
        std::string default_ws_url = "ws://35.162.7.133:8080";
        settings.SetString("url", default_ws_url);
        ESP_LOGI(TAG, "Token received, using default WS URL: %s", default_ws_url.c_str());
    }

    cJSON_Delete(root);
    registration_pending_ = false;
    ESP_LOGI(TAG, "ElatoAI token stored successfully");
}

void WifiBoard::StartRegistrationPolling() {
    if (registration_poll_task_ != nullptr) {
        ESP_LOGW(TAG, "Registration polling already running");
        return;
    }

    ESP_LOGI(TAG, "Starting registration polling task");
    xTaskCreate(RegistrationPollTask, "reg_poll", 4096, this, 2, &registration_poll_task_);
}

void WifiBoard::StopRegistrationPolling() {
    if (registration_poll_task_ != nullptr) {
        ESP_LOGI(TAG, "Stopping registration polling task");
        vTaskDelete(registration_poll_task_);
        registration_poll_task_ = nullptr;
    }
    registration_pending_ = false;
}

void WifiBoard::RegistrationPollTask(void* arg) {
    auto* board = static_cast<WifiBoard*>(arg);
    const int POLL_INTERVAL_MS = 10000;  // Poll every 10 seconds

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(POLL_INTERVAL_MS));

        ESP_LOGI(TAG, "Polling for registration completion...");

        std::string mac = SystemInfo::GetMacAddress();
        Settings wifi_settings("wifi", false);
        std::string backend_url = wifi_settings.GetString("backend_url", "http://35.162.7.133");
        std::string token_url = backend_url + "/api/generate_auth_token?macAddress=" + mac;

        auto network = board->GetNetwork();
        auto http = network->CreateHttp(0);
        if (!http) {
            ESP_LOGE(TAG, "Failed to create HTTP client for polling");
            continue;
        }

        http->SetHeader("User-Agent", SystemInfo::GetUserAgent());
        http->SetHeader("Content-Type", "application/json");

        if (!http->Open("GET", token_url)) {
            ESP_LOGE(TAG, "Failed to connect during polling");
            continue;
        }

        auto response = http->ReadAll();
        int status_code = http->GetStatusCode();
        http->Close();

        if (status_code != 200) {
            ESP_LOGE(TAG, "Polling request failed with status %d", status_code);
            continue;
        }

        auto root = cJSON_Parse(response.c_str());
        if (!root) {
            ESP_LOGE(TAG, "Failed to parse polling response");
            continue;
        }

        // Check if still pending
        auto status = cJSON_GetObjectItem(root, "status");
        if (cJSON_IsString(status) && strcmp(status->valuestring, "pending") == 0) {
            ESP_LOGI(TAG, "Still pending registration...");
            cJSON_Delete(root);
            continue;
        }

        // Check for token (registration complete)
        auto token = cJSON_GetObjectItem(root, "token");
        auto ws_url = cJSON_GetObjectItem(root, "ws_url");

        if (cJSON_IsString(token)) {
            ESP_LOGI(TAG, "Registration complete! Token received.");

            // Store token in NVS
            Settings settings("websocket", true);
            settings.SetString("token", token->valuestring);

            if (cJSON_IsString(ws_url)) {
                settings.SetString("url", ws_url->valuestring);
                ESP_LOGI(TAG, "WS URL: %s", ws_url->valuestring);
            } else {
                std::string default_ws_url = "ws://35.162.7.133:8080";
                settings.SetString("url", default_ws_url);
            }

            cJSON_Delete(root);

            // Clear pending state
            board->registration_pending_ = false;
            board->registration_poll_task_ = nullptr;

            // Show success notification
            auto display = board->GetDisplay();
            if (display) {
                display->ShowNotification(Lang::Strings::REGISTER_SUCCESS);
            }

            // Schedule reboot to apply new token
            ESP_LOGI(TAG, "Rebooting to apply registration...");
            vTaskDelay(pdMS_TO_TICKS(2000));
            esp_restart();

            vTaskDelete(NULL);
            return;
        }

        cJSON_Delete(root);
    }
}
