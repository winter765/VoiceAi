#ifndef _ELATO_RGB_LED_H_
#define _ELATO_RGB_LED_H_

#include "led.h"
#include <driver/gpio.h>
#include <driver/ledc.h>
#include <esp_timer.h>
#include <mutex>

/**
 * ElatoRgbLed - RGB LED driver using 3 separate GPIO pins with PWM
 *
 * GPIO mapping for ElatoAI hardware:
 * - GPIO 8  = Green
 * - GPIO 9  = Red
 * - GPIO 13 = Blue
 *
 * State colors:
 * - IDLE: Green solid
 * - LISTENING: Yellow solid (Red + Green)
 * - SPEAKING: Blue solid
 * - CONNECTING: Blue blink
 * - WIFI_CONFIG: Magenta pulse (Red + Blue)
 */
class ElatoRgbLed : public Led {
public:
    ElatoRgbLed(gpio_num_t gpio_green, gpio_num_t gpio_red, gpio_num_t gpio_blue);
    virtual ~ElatoRgbLed();

    void OnStateChanged() override;

private:
    std::mutex mutex_;

    // GPIO pins
    gpio_num_t gpio_green_;
    gpio_num_t gpio_red_;
    gpio_num_t gpio_blue_;

    // LEDC channels for PWM
    ledc_channel_config_t channel_green_;
    ledc_channel_config_t channel_red_;
    ledc_channel_config_t channel_blue_;

    // Current color values (0-255)
    uint8_t r_ = 0, g_ = 0, b_ = 0;

    // Blink/fade state
    int blink_counter_ = 0;
    int blink_interval_ms_ = 0;
    bool fade_up_ = true;
    esp_timer_handle_t blink_timer_ = nullptr;

    // Initialize LEDC for a single channel
    void InitChannel(gpio_num_t gpio, ledc_channel_t channel, ledc_channel_config_t& config);

    // Color control
    void SetColor(uint8_t r, uint8_t g, uint8_t b);
    void ApplyColor();
    void TurnOn();
    void TurnOff();

    // Blink control
    void StartContinuousBlink(int interval_ms);
    void StartFade(int fade_time_ms);
    void StopEffects();
    void OnBlinkTimer();

    static constexpr uint32_t LEDC_DUTY_MAX = 8191;  // 13-bit resolution
    static constexpr int LEDC_FREQ_HZ = 4000;
};

#endif // _ELATO_RGB_LED_H_
