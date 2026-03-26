#include "elato_rgb_led.h"
#include "application.h"
#include "device_state.h"
#include <esp_log.h>

#define TAG "ElatoRgbLed"

// Brightness levels (0-255)
#define BRIGHTNESS_HIGH   200
#define BRIGHTNESS_MED    100
#define BRIGHTNESS_LOW    50
#define BRIGHTNESS_DIM    20

// Blink infinite marker
#define BLINK_INFINITE -1

// LEDC timer configuration
#define LEDC_LS_MODE      LEDC_LOW_SPEED_MODE
#define LEDC_TIMER_NUM    LEDC_TIMER_2  // Use different timer to avoid conflict

ElatoRgbLed::ElatoRgbLed(gpio_num_t gpio_green, gpio_num_t gpio_red, gpio_num_t gpio_blue)
    : gpio_green_(gpio_green), gpio_red_(gpio_red), gpio_blue_(gpio_blue) {

    // Configure LEDC timer
    ledc_timer_config_t ledc_timer = {};
    ledc_timer.duty_resolution = LEDC_TIMER_13_BIT;
    ledc_timer.freq_hz = LEDC_FREQ_HZ;
    ledc_timer.speed_mode = LEDC_LS_MODE;
    ledc_timer.timer_num = LEDC_TIMER_NUM;
    ledc_timer.clk_cfg = LEDC_AUTO_CLK;
    ESP_ERROR_CHECK(ledc_timer_config(&ledc_timer));

    // Initialize each channel
    InitChannel(gpio_green_, LEDC_CHANNEL_3, channel_green_);
    InitChannel(gpio_red_, LEDC_CHANNEL_4, channel_red_);
    InitChannel(gpio_blue_, LEDC_CHANNEL_5, channel_blue_);

    // Create blink timer
    esp_timer_create_args_t timer_args = {
        .callback = [](void* arg) {
            auto led = static_cast<ElatoRgbLed*>(arg);
            led->OnBlinkTimer();
        },
        .arg = this,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "rgb_blink_timer",
        .skip_unhandled_events = false,
    };
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &blink_timer_));

    ESP_LOGI(TAG, "ElatoRgbLed initialized: G=%d, R=%d, B=%d", gpio_green_, gpio_red_, gpio_blue_);
}

ElatoRgbLed::~ElatoRgbLed() {
    if (blink_timer_) {
        esp_timer_stop(blink_timer_);
        esp_timer_delete(blink_timer_);
    }
}

void ElatoRgbLed::InitChannel(gpio_num_t gpio, ledc_channel_t channel, ledc_channel_config_t& config) {
    config.channel = channel;
    config.duty = 0;
    config.gpio_num = gpio;
    config.speed_mode = LEDC_LS_MODE;
    config.hpoint = 0;
    config.timer_sel = LEDC_TIMER_NUM;
    config.flags.output_invert = 0;

    ESP_ERROR_CHECK(ledc_channel_config(&config));
}

void ElatoRgbLed::SetColor(uint8_t r, uint8_t g, uint8_t b) {
    r_ = r;
    g_ = g;
    b_ = b;
}

void ElatoRgbLed::ApplyColor() {
    // Convert 0-255 to duty cycle (0 to LEDC_DUTY_MAX)
    uint32_t duty_r = (r_ * LEDC_DUTY_MAX) / 255;
    uint32_t duty_g = (g_ * LEDC_DUTY_MAX) / 255;
    uint32_t duty_b = (b_ * LEDC_DUTY_MAX) / 255;

    ledc_set_duty(LEDC_LS_MODE, channel_red_.channel, duty_r);
    ledc_update_duty(LEDC_LS_MODE, channel_red_.channel);

    ledc_set_duty(LEDC_LS_MODE, channel_green_.channel, duty_g);
    ledc_update_duty(LEDC_LS_MODE, channel_green_.channel);

    ledc_set_duty(LEDC_LS_MODE, channel_blue_.channel, duty_b);
    ledc_update_duty(LEDC_LS_MODE, channel_blue_.channel);
}

void ElatoRgbLed::TurnOn() {
    std::lock_guard<std::mutex> lock(mutex_);
    StopEffects();
    ApplyColor();
}

void ElatoRgbLed::TurnOff() {
    std::lock_guard<std::mutex> lock(mutex_);
    StopEffects();

    ledc_set_duty(LEDC_LS_MODE, channel_red_.channel, 0);
    ledc_update_duty(LEDC_LS_MODE, channel_red_.channel);

    ledc_set_duty(LEDC_LS_MODE, channel_green_.channel, 0);
    ledc_update_duty(LEDC_LS_MODE, channel_green_.channel);

    ledc_set_duty(LEDC_LS_MODE, channel_blue_.channel, 0);
    ledc_update_duty(LEDC_LS_MODE, channel_blue_.channel);
}

void ElatoRgbLed::StopEffects() {
    esp_timer_stop(blink_timer_);
    blink_counter_ = 0;
}

void ElatoRgbLed::StartContinuousBlink(int interval_ms) {
    std::lock_guard<std::mutex> lock(mutex_);
    StopEffects();
    blink_counter_ = BLINK_INFINITE;
    blink_interval_ms_ = interval_ms;
    esp_timer_start_periodic(blink_timer_, interval_ms * 1000);
}

void ElatoRgbLed::StartFade(int fade_time_ms) {
    // Simple fade using blink timer with short intervals
    std::lock_guard<std::mutex> lock(mutex_);
    StopEffects();
    fade_up_ = true;
    blink_counter_ = BLINK_INFINITE;
    blink_interval_ms_ = 50;  // 50ms steps for smooth fade
    esp_timer_start_periodic(blink_timer_, 50 * 1000);
}

void ElatoRgbLed::OnBlinkTimer() {
    std::lock_guard<std::mutex> lock(mutex_);

    if (blink_counter_ == BLINK_INFINITE) {
        // Continuous blink or fade mode
        static bool on = false;
        on = !on;

        if (on) {
            ApplyColor();
        } else {
            ledc_set_duty(LEDC_LS_MODE, channel_red_.channel, 0);
            ledc_update_duty(LEDC_LS_MODE, channel_red_.channel);
            ledc_set_duty(LEDC_LS_MODE, channel_green_.channel, 0);
            ledc_update_duty(LEDC_LS_MODE, channel_green_.channel);
            ledc_set_duty(LEDC_LS_MODE, channel_blue_.channel, 0);
            ledc_update_duty(LEDC_LS_MODE, channel_blue_.channel);
        }
    } else {
        // Finite blink
        blink_counter_--;
        if (blink_counter_ & 1) {
            ApplyColor();
        } else {
            ledc_set_duty(LEDC_LS_MODE, channel_red_.channel, 0);
            ledc_update_duty(LEDC_LS_MODE, channel_red_.channel);
            ledc_set_duty(LEDC_LS_MODE, channel_green_.channel, 0);
            ledc_update_duty(LEDC_LS_MODE, channel_green_.channel);
            ledc_set_duty(LEDC_LS_MODE, channel_blue_.channel, 0);
            ledc_update_duty(LEDC_LS_MODE, channel_blue_.channel);

            if (blink_counter_ == 0) {
                esp_timer_stop(blink_timer_);
            }
        }
    }
}

void ElatoRgbLed::OnStateChanged() {
    auto& app = Application::GetInstance();
    auto device_state = app.GetDeviceState();

    switch (device_state) {
        case kDeviceStateStarting:
            // Blue blink during startup
            SetColor(0, 0, BRIGHTNESS_MED);
            StartContinuousBlink(100);
            break;

        case kDeviceStateWifiConfiguring:
            // Magenta pulse (Red + Blue) during WiFi config
            SetColor(BRIGHTNESS_MED, 0, BRIGHTNESS_MED);
            StartFade(1000);
            break;

        case kDeviceStateIdle:
            // Green solid when idle
            SetColor(0, BRIGHTNESS_DIM, 0);
            TurnOn();
            break;

        case kDeviceStateConnecting:
            // Blue blink during connection
            SetColor(0, 0, BRIGHTNESS_MED);
            StartContinuousBlink(200);
            break;

        case kDeviceStateListening:
        case kDeviceStateAudioTesting:
            // Yellow solid when listening (Red + Green)
            if (app.IsVoiceDetected()) {
                SetColor(BRIGHTNESS_HIGH, BRIGHTNESS_HIGH, 0);
            } else {
                SetColor(BRIGHTNESS_MED, BRIGHTNESS_MED, 0);
            }
            TurnOn();
            break;

        case kDeviceStateSpeaking:
            // Blue solid when speaking
            SetColor(0, 0, BRIGHTNESS_MED);
            TurnOn();
            break;

        case kDeviceStateUpgrading:
            // Green blink during OTA
            SetColor(0, BRIGHTNESS_MED, 0);
            StartContinuousBlink(100);
            break;

        case kDeviceStateActivating:
            // Cyan pulse during activation (Green + Blue)
            SetColor(0, BRIGHTNESS_MED, BRIGHTNESS_MED);
            StartContinuousBlink(500);
            break;

        default:
            ESP_LOGW(TAG, "Unknown device state: %d", device_state);
            break;
    }
}
