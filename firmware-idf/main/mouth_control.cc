#include "mouth_control.h"
#include "application.h"
#include <esp_log.h>

#define TAG "MouthControl"

MouthControl::MouthControl(gpio_num_t gpio) : gpio_(gpio) {
    // Configure GPIO as output
    gpio_config_t io_conf = {};
    io_conf.intr_type = GPIO_INTR_DISABLE;
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pin_bit_mask = (1ULL << gpio_);
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
    ESP_ERROR_CHECK(gpio_config(&io_conf));

    // Start with mouth closed (LOW)
    gpio_set_level(gpio_, 0);

    ESP_LOGI(TAG, "Mouth control initialized on GPIO %d", gpio_);

    // Register state change listener
    auto& app = Application::GetInstance();
    listener_id_ = app.GetStateMachine().AddStateChangeListener(
        [this](DeviceState old_state, DeviceState new_state) {
            OnStateChanged(old_state, new_state);
        });
}

MouthControl::~MouthControl() {
    // Unregister listener
    if (listener_id_ >= 0) {
        auto& app = Application::GetInstance();
        app.GetStateMachine().RemoveStateChangeListener(listener_id_);
    }

    // Ensure mouth is closed on cleanup
    gpio_set_level(gpio_, 0);
}

void MouthControl::OnStateChanged(DeviceState old_state, DeviceState new_state) {
    if (!enabled_) {
        return;
    }

    // Set mouth open (HIGH) when AI is speaking, closed (LOW) otherwise
    bool should_open = (new_state == kDeviceStateSpeaking);
    SetMouthOpen(should_open);
}

void MouthControl::SetEnabled(bool enabled) {
    enabled_ = enabled;
    if (!enabled_) {
        // Close mouth when disabled
        SetMouthOpen(false);
    }
}

void MouthControl::SetMouthOpen(bool open) {
    gpio_set_level(gpio_, open ? 1 : 0);
    ESP_LOGD(TAG, "Mouth %s", open ? "OPEN" : "CLOSED");
}
