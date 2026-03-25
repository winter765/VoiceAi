#include "FactoryReset.h"
#include "LEDHandler.h"
#include "OTA.h"
#include "WifiManager.h"
#include "Audio.h"
#include "Button.h"
#include <driver/touch_sensor.h>

#ifdef DISPLAY_ENABLED
#include "DisplayHandler.h"
#endif

#define TOUCH_THRESHOLD 28000
#define REQUIRED_RELEASE_CHECKS                                                \
  100 // how many consecutive times we need "below threshold" to confirm release
#define TOUCH_DEBOUNCE_DELAY 500 // milliseconds

AsyncWebServer webServer(80);
WIFIMANAGER WifiManager;
esp_err_t getErr = ESP_OK;

// Main Thread -> onButtonLongPressUpEventCb -> enterSleep()
// Main Thread -> onButtonDoubleClickCb -> enterSleep()
// Touch Task -> touchTask -> enterSleep()
// Main Thread -> loop() (inactivity timeout) -> enterSleep()
void enterSleep() {
  Serial.println("Going to sleep...");

  // First, change device state to prevent any new data processing
  deviceState = SLEEP;
  scheduleListeningRestart = false;
  i2sOutputFlushScheduled = true;
  i2sInputFlushScheduled = true;
  vTaskDelay(10); // let all tasks accept state

  xSemaphoreTake(wsMutex, portMAX_DELAY);

  // Stop audio tasks first
  i2s_stop(I2S_PORT_IN);
  i2s_stop(I2S_PORT_OUT);

  // Properly disconnect WebSocket and wait for it to complete
  if (webSocket.isConnected()) {
    webSocket.disconnect();
    // Give some time for the disconnect to process
  }
  xSemaphoreGive(wsMutex);
  delay(100);

  // Stop all tasks that might be using I2S or other peripherals
  i2s_driver_uninstall(I2S_PORT_IN);
  i2s_driver_uninstall(I2S_PORT_OUT);

  // Flush any remaining serial output
  Serial.flush();

#ifdef TOUCH_MODE
  touch_pad_intr_disable(TOUCH_PAD_INTR_MASK_ALL);
  while (touchRead(TOUCH_PAD_NUM2) > TOUCH_THRESHOLD) {
    delay(50);
  }
  delay(500);
  touchSleepWakeUpEnable(TOUCH_PAD_NUM2, TOUCH_THRESHOLD);
#endif

  esp_deep_sleep_start();
  delay(1000);
}

void processSleepRequest() {
  if (sleepRequested) {
    sleepRequested = false;
    enterSleep(); // Just call it directly - no state checking needed
  }
}

void printOutESP32Error(esp_err_t err) {
  switch (err) {
  case ESP_OK:
    Serial.println("ESP_OK no errors");
    break;
  case ESP_ERR_INVALID_ARG:
    Serial.println("ESP_ERR_INVALID_ARG if the selected GPIO is not an RTC "
                   "GPIO, or the mode is invalid");
    break;
  case ESP_ERR_INVALID_STATE:
    Serial.println("ESP_ERR_INVALID_STATE if wakeup triggers conflict or "
                   "wireless not stopped");
    break;
  default:
    Serial.printf("Unknown error code: %d\n", err);
    break;
  }
}

static void onButtonLongPressUpEventCb(void *button_handle, void *usr_data) {
  Serial.println("Button long press end");
  delay(10);
  sleepRequested = true;
}

// 双击已移除，避免影响单击检测速度

static void onButtonSingleClickCb(void *button_handle, void *usr_data) {
  Serial.println("Button single click -> toggle chat");
  chatToggleRequested = true;
}

// ---- Volume control callbacks ----
static void saveVolumeToNVS(int vol) {
  preferences.begin("audio", false);
  preferences.putInt("volume", vol);
  preferences.end();
}

static int loadVolumeFromNVS() {
  preferences.begin("audio", true);
  int vol = preferences.getInt("volume", 100);
  preferences.end();
  return vol;
}

static void applyVolume(int newVolume) {
  if (newVolume > 100) newVolume = 100;
  if (newVolume < 0) newVolume = 0;
  currentVolume = newVolume;
  saveVolumeToNVS(currentVolume);
  Serial.printf("Volume: %d\n", currentVolume);
#ifdef DISPLAY_ENABLED
  char buf[32];
  snprintf(buf, sizeof(buf), "Volume: %d%%", currentVolume);
  displaySetChatMessage("", buf);
#endif
}

// Volume button polling task with debounce, short press and long press detection
void volumeButtonTask(void *parameter) {
  const unsigned long DEBOUNCE_MS = 50;
  const unsigned long LONG_PRESS_MS = 800;

  bool upPressed = false, downPressed = false;
  unsigned long upPressTime = 0, downPressTime = 0;
  bool upLongHandled = false, downLongHandled = false;

  while (1) {
    bool upState = digitalRead(VOLUME_UP_PIN) == LOW;
    bool downState = digitalRead(VOLUME_DOWN_PIN) == LOW;
    unsigned long now = millis();

    // Volume Up button
    if (upState && !upPressed) {
      upPressed = true;
      upPressTime = now;
      upLongHandled = false;
    } else if (upState && upPressed && !upLongHandled &&
               (now - upPressTime >= LONG_PRESS_MS)) {
      applyVolume(100);
      upLongHandled = true;
    } else if (!upState && upPressed) {
      if (!upLongHandled && (now - upPressTime >= DEBOUNCE_MS)) {
        applyVolume(currentVolume + 10);
      }
      upPressed = false;
    }

    // Volume Down button
    if (downState && !downPressed) {
      downPressed = true;
      downPressTime = now;
      downLongHandled = false;
    } else if (downState && downPressed && !downLongHandled &&
               (now - downPressTime >= LONG_PRESS_MS)) {
      applyVolume(0);
      downLongHandled = true;
    } else if (!downState && downPressed) {
      if (!downLongHandled && (now - downPressTime >= DEBOUNCE_MS)) {
        applyVolume(currentVolume - 10);
      }
      downPressed = false;
    }

    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

void getAuthTokenFromNVS() {
  preferences.begin("auth", false);
  authTokenGlobal = preferences.getString("auth_token", "");
  preferences.end();
}

void setupWiFi() {
  WifiManager.fallbackToSoftAp(
      true); // Run a SoftAP if no known AP can be reached
  WifiManager.startBackgroundTask(
      "VOICE-DEVICE"); // Run the background task to take care of our Wifi
  WifiManager.attachWebServer(&webServer); // Attach our API to the Webserver
  WifiManager.attachUI();                  // Attach the UI to the Webserver

  // Run the Webserver and add your webpages to it
  webServer.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->redirect("/wifi");
  });
  webServer.onNotFound([](AsyncWebServerRequest *request) {
    request->send(404, "text/plain", "Not found");
  });
  webServer.begin();
}

void touchTask(void *parameter) {
  touch_pad_init();
  touch_pad_config(TOUCH_PAD_NUM2);

  bool touched = false;
  unsigned long pressStartTime = 0;
  unsigned long lastTouchTime = 0;
  bool longPressHandled = false;
  const unsigned long LONG_PRESS_DURATION = 1000; // 1s for long press (sleep)
  const unsigned long SHORT_PRESS_MAX = 500;      // <500ms = short press (toggle chat)

  while (1) {
    uint32_t touchValue = touchRead(TOUCH_PAD_NUM2);
    bool isTouched = (touchValue > TOUCH_THRESHOLD);
    unsigned long currentTime = millis();

    // Touch start
    if (isTouched && !touched &&
        (currentTime - lastTouchTime > TOUCH_DEBOUNCE_DELAY)) {
      touched = true;
      pressStartTime = currentTime;
      lastTouchTime = currentTime;
      longPressHandled = false;
    }

    // Long press detection (while still touching)
    if (touched && isTouched && !longPressHandled) {
      if (currentTime - pressStartTime >= LONG_PRESS_DURATION) {
        Serial.println("[TOUCH] Long press -> sleep");
        sleepRequested = true;
        longPressHandled = true;
      }
    }

    // Release detection
    if (!isTouched && touched) {
      unsigned long pressDuration = currentTime - pressStartTime;
      if (!longPressHandled && pressDuration < SHORT_PRESS_MAX) {
        Serial.println("[TOUCH] Short press -> toggle chat");
        toggleChatState();
      }
      touched = false;
      pressStartTime = 0;
    }

    vTaskDelay(20);
  }
  vTaskDelete(NULL);
}

void setupDeviceMetadata() {
  // factoryResetDevice();
  // resetAuth();

  deviceState = IDLE;

  getAuthTokenFromNVS();
  getOTAStatusFromNVS();

  if (otaState == OTA_IN_PROGRESS || otaState == OTA_COMPLETE) {
    deviceState = OTA;
  }
  if (factory_reset_status) {
    deviceState = FACTORY_RESET;
  }
}

void setup() {
  Serial.begin(921600);
  delay(500);

  // SETUP
  setupDeviceMetadata();
  wsMutex = xSemaphoreCreateMutex();

// INTERRUPT
#ifdef TOUCH_MODE
  xTaskCreate(touchTask, "Touch Task", 4096, NULL, configMAX_PRIORITIES - 2,
              NULL);
#else
  getErr = esp_sleep_enable_ext0_wakeup(BUTTON_PIN, LOW);
  printOutESP32Error(getErr);
  Button *btn = new Button(BUTTON_PIN, false);
  gpio_set_pull_mode((gpio_num_t)BUTTON_PIN, GPIO_PULLUP_ONLY); // BOOT按钮需要上拉
  btn->attachLongPressUpEventCb(&onButtonLongPressUpEventCb, NULL);
  btn->attachSingleClickEventCb(&onButtonSingleClickCb, NULL);
#endif

  // Load saved volume from NVS
  currentVolume = loadVolumeFromNVS();
  Serial.printf("Loaded volume from NVS: %d\n", currentVolume);


  // Pin audio tasks to Core 1 (application core)
  xTaskCreatePinnedToCore(ledTask,    // Function
                          "LED Task", // Name
                          4096,       // Stack size
                          NULL,       // Parameters
                          5,          // Priority
                          NULL,       // Handle
                          1           // Core 1 (application core)
  );

  xTaskCreatePinnedToCore(audioStreamTask, // Function
                          "Speaker Task",  // Name
                          4096,            // Stack size
                          NULL,            // Parameters
                          3,               // Priority
                          NULL,            // Handle
                          1                // Core 1 (application core)
  );

  xTaskCreatePinnedToCore(micTask,           // Function
                          "Microphone Task", // Name
                          16384,             // Stack size (16KB for Opus encoder)
                          NULL,              // Parameters
                          4,                 // Priority
                          NULL,              // Handle
                          1                  // Core 1 (application core)
  );

#ifdef DISPLAY_ENABLED
  displayInit();
  xTaskCreatePinnedToCore(displayTask,     // Function
                          "Display Task",  // Name
                          4096,            // Stack size
                          NULL,            // Parameters
                          2,               // Priority
                          NULL,            // Handle
                          1                // Core 1 (application core)
  );
#endif

  // Volume control buttons - init AFTER displayInit to avoid I2C pin conflict
  pinMode(VOLUME_UP_PIN, INPUT_PULLUP);
  pinMode(VOLUME_DOWN_PIN, INPUT_PULLUP);
  xTaskCreate(volumeButtonTask, "Volume Task", 4096, NULL, 3, NULL);

  // Pin network task to Core 0 (protocol core)
  xTaskCreatePinnedToCore(networkTask,              // Function
                          "Websocket Task",         // Name
                          8192,                     // Stack size
                          NULL,                     // Parameters
                          configMAX_PRIORITIES - 1, // Highest priority
                          &networkTaskHandle,       // Handle
                          0                         // Core 0 (protocol core)
  );

  // WIFI
  setupWiFi();
}

void loop() {
  processSleepRequest();
  if (chatToggleRequested) {
    chatToggleRequested = false;
    toggleChatState();
  }
  if (otaState == OTA_IN_PROGRESS) {
    loopOTA();
  }
}