#include <esp_log.h>
#include <esp_err.h>
#include <nvs.h>
#include <nvs_flash.h>
#include <driver/gpio.h>
#include <esp_event.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <cstdlib>
#include <ctime>

#include "application.h"

#define TAG "main"

static void InitTimezone() {
    // Try to read saved timezone from NVS
    nvs_handle_t nvs_handle;
    char tz_str[32] = "CST-8";  // Default to China Standard Time

    if (nvs_open("system", NVS_READONLY, &nvs_handle) == ESP_OK) {
        size_t len = sizeof(tz_str);
        if (nvs_get_str(nvs_handle, "timezone", tz_str, &len) == ESP_OK) {
            ESP_LOGI(TAG, "Loaded timezone from NVS: %s", tz_str);
        }
        nvs_close(nvs_handle);
    }

    setenv("TZ", tz_str, 1);
    tzset();
}

extern "C" void app_main(void)
{
    // Initialize NVS flash for WiFi configuration
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "Erasing NVS flash to fix corruption");
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // Initialize timezone from NVS or use default
    InitTimezone();

    // Initialize and run the application
    auto& app = Application::GetInstance();
    app.Initialize();
    app.Run();  // This function runs the main event loop and never returns
}
