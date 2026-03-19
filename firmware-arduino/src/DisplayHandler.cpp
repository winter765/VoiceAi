#include "DisplayHandler.h"
#include "Config.h"
#include <U8g2lib.h>

// SSD1306 128x32 Software I2C
static U8G2_SSD1306_128X32_UNIVISION_F_SW_I2C u8g2(U8G2_R0, DISPLAY_SCL, DISPLAY_SDA, /* reset=*/U8X8_PIN_NONE);

// Thread-safe shared state
static SemaphoreHandle_t displayMutex = NULL;
static char chatRole[16] = "";
static char chatMessage[256] = "";
static bool dirty = true; // start dirty to draw initial screen

// Horizontal scroll state
static int scrollOffset = 0;
static unsigned long lastScrollTime = 0;
static const int SCROLL_INTERVAL_MS = 150;
static const int SCROLL_PAUSE_MS = 2000;
static unsigned long scrollPauseUntil = 0;

static const char *stateToString(DeviceState state) {
    switch (state) {
    case IDLE:
        return "Ready";
    case LISTENING:
        return "Listening...";
    case SPEAKING:
        return "Speaking...";
    case PROCESSING:
        return "Processing...";
    case SETUP:
        return "Setup...";
    case SOFT_AP:
        return "WiFi Setup";
    case WAITING:
        return "Waiting...";
    case OTA:
        return "Updating...";
    case FACTORY_RESET:
        return "Resetting...";
    case SLEEP:
        return "Sleep";
    default:
        return "Unknown";
    }
}

void displayInit() {
    u8g2.begin();
    u8g2.setFont(u8g2_font_6x10_tf);
    displayMutex = xSemaphoreCreateMutex();
}

void displaySetChatMessage(const char *role, const char *text) {
    if (!displayMutex) return;
    xSemaphoreTake(displayMutex, portMAX_DELAY);
    strncpy(chatRole, role, sizeof(chatRole) - 1);
    chatRole[sizeof(chatRole) - 1] = '\0';
    strncpy(chatMessage, text, sizeof(chatMessage) - 1);
    chatMessage[sizeof(chatMessage) - 1] = '\0';
    dirty = true;
    scrollOffset = 0;
    scrollPauseUntil = millis() + SCROLL_PAUSE_MS;
    xSemaphoreGive(displayMutex);
}

void displayTask(void *parameter) {
    static DeviceState lastState = SETUP;
    char localRole[16];
    char localMessage[256];
    bool localDirty;

    while (1) {
        // Check if state changed
        DeviceState currentState = deviceState;
        if (currentState != lastState) {
            lastState = currentState;
            dirty = true;
        }

        // Copy shared data under mutex
        xSemaphoreTake(displayMutex, portMAX_DELAY);
        localDirty = dirty;
        strncpy(localRole, chatRole, sizeof(localRole));
        strncpy(localMessage, chatMessage, sizeof(localMessage));
        dirty = false;
        xSemaphoreGive(displayMutex);

        // Build prefix "You: " or "AI: "
        char prefix[8] = "";
        if (localRole[0] != '\0') {
            if (strcmp(localRole, "user") == 0) {
                strcpy(prefix, "You: ");
            } else {
                strcpy(prefix, "AI: ");
            }
        }

        // Calculate full display line
        char fullLine[280];
        snprintf(fullLine, sizeof(fullLine), "%s%s", prefix, localMessage);
        int textWidthPx = strlen(fullLine) * 6; // 6px per char with 6x10 font
        int displayWidth = 128;

        // Handle horizontal scrolling for long text
        bool needsScroll = textWidthPx > displayWidth;
        if (needsScroll) {
            unsigned long now = millis();
            if (now >= scrollPauseUntil && now - lastScrollTime >= SCROLL_INTERVAL_MS) {
                lastScrollTime = now;
                scrollOffset += 6; // scroll by one character width
                int maxScroll = textWidthPx - displayWidth;
                if (scrollOffset > maxScroll) {
                    scrollOffset = 0;
                    scrollPauseUntil = now + SCROLL_PAUSE_MS;
                }
                localDirty = true;
            }
        } else {
            scrollOffset = 0;
        }

        if (!localDirty) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        // Redraw (128x32 layout)
        u8g2.clearBuffer();
        u8g2.setFont(u8g2_font_6x10_tf);

        // --- Top line: status (y=10) ---
        const char *statusStr = stateToString(lastState);
        u8g2.drawStr(0, 10, statusStr);

        // --- Bottom line: chat text (y=28) ---
        if (fullLine[0] != '\0') {
            u8g2.drawStr(-scrollOffset, 28, fullLine);
        }

        u8g2.sendBuffer();

        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
