# firmware-arduino 代码架构文档

## 目录结构

```
firmware-arduino/
├── platformio.ini              # 构建配置、依赖库、编译标志
├── partition.csv               # Flash 分区表 (20K NVS, 2M×2 OTA, 3M SPIFFS)
└── src/
    ├── Config.h / Config.cpp   # 全局常量、引脚定义、模式配置、状态枚举
    ├── main.cpp                # setup/loop、任务创建、按钮/触摸输入、睡眠管理
    ├── Audio.h / Audio.cpp     # 音频管道（I2S 输入输出）、WebSocket 通信、Opus 解码、状态转换
    ├── WifiManager.h/cpp       # WiFi 管理、SoftAP 配网门户、NVS 存储、认证回调
    ├── LEDHandler.h/cpp        # RGB LED 状态指示
    ├── DisplayHandler.h/cpp    # SSD1306 OLED 显示（硬件 I2C）
    ├── OTA.h / OTA.cpp         # 固件空中升级（HTTPS OTA）
    ├── FactoryReset.h          # 出厂重置逻辑（header-only）
    └── PitchShift.h/cpp        # 音调变换（当前未启用）
```

## 构建配置 (platformio.ini)

| 配置项 | 值 |
|---|---|
| 目标板 | esp32-s3-devkitc-1 |
| 平台 | Espressif32 6.10.0 |
| 框架 | Arduino |
| C++ 标准 | gnu++17 |
| Flash 大小 | 16 MB |
| 串口波特率 | 921600 |

**编译标志：**
- `CORE_DEBUG_LEVEL=5` — ESP32 详细调试日志
- `DISPLAY_ENABLED=1` — 启用 OLED 显示屏
- `TOUCH_SENSOR_ENABLE=1` — 启用触摸传感器驱动

**Flash 分区 (partition.csv)：**
| 名称 | 大小 | 用途 |
|---|---|---|
| nvs | 20 KB | NVS 键值存储 |
| otadata | 8 KB | OTA 引导数据 |
| app0 | 2 MB | OTA 槽位 0 |
| app1 | 2 MB | OTA 槽位 1 |
| spiffs | 3 MB | SPIFFS 文件系统 |

**依赖库：**
| 库 | 版本 | 用途 |
|---|---|---|
| ArduinoJson | ^7.1.0 | JSON 解析 |
| WebSockets (links2004) | ^2.4.1 | WebSocket 客户端 |
| ESPAsyncWebServer | ^3.7.6 | WiFi 配网 Web 服务器 |
| ESP32_Button | v0.0.1 | 按钮事件检测 |
| arduino-audio-tools | v1.0.1 | I2S 音频框架 |
| arduino-libopus | a1.1.0 | Opus 编解码 |
| U8g2 | ^2.35.19 | SSD1306 OLED 驱动 |

## 核心模块

### Config.h / Config.cpp — 全局配置

**设备状态枚举 `DeviceState`：**
```
SETUP → IDLE ←→ LISTENING ←→ SPEAKING
                    ↓              ↓
              PROCESSING      PROCESSING
              SOFT_AP / WAITING / OTA / FACTORY_RESET / SLEEP
```

**部署模式（互斥宏）：**
| 宏 | 连接方式 | 用途 |
|---|---|---|
| `DEV_MODE` | HTTP/WS | 开发环境 |
| `PROD_MODE` | HTTPS/WSS (自签证书) | 自建服务器 |
| `ELATO_MODE` | HTTPS/WSS (ISRG Root X1) | Elato 官方 |

**音频常量：**
- `SAMPLE_RATE = 24000` (扬声器输出 Hz)
- `MIC_SAMPLE_RATE = 16000` (麦克风输入 Hz)

**全局变量：**
| 变量 | 类型 | 说明 |
|---|---|---|
| `deviceState` | `volatile DeviceState` | 当前设备状态 |
| `preferences` | `Preferences` | NVS 存储句柄 |
| `otaState` | `OtaStatus` | OTA 状态 |
| `sleepRequested` | `volatile bool` | 睡眠请求标志 |
| `authTokenGlobal` | `String` | JWT 认证令牌 |

### Audio.h / Audio.cpp — 音频引擎

**职责：** 全双工语音管道（麦克风采集、Opus 解码、扬声器输出）、WebSocket 通信、状态转换逻辑

**关键常量：**
- `AUDIO_BUFFER_SIZE = 10240` bytes — PCM 环形缓冲区
- `AUDIO_CHUNK_SIZE = 1024` bytes — 读写块大小

**FreeRTOS 任务：**

#### audioStreamTask (Core 1, 优先级 3)
- 使用 ESP-IDF legacy I2S API (非 AudioTools)
- 配置：32-bit, 24kHz, stereo, DMA 6×240
- 流程：读取 audioBuffer → 二次方音量缩放 → 16-bit mono → 32-bit stereo → `i2s_write()`

#### micTask (Core 1, 优先级 4)
- 使用 AudioTools `I2SStream` RX_MODE
- 配置：32-bit, 16kHz, mono, 左声道
- 流程：读 160 样本 → 右移 12 bit 转 16-bit → WebSocket binary 发送
- 仅在 `LISTENING` 状态且 WebSocket 已连接时发送

#### networkTask (Core 0, 优先级 MAX-1)
- 每 1ms 调用 `webSocket.loop()`
- 轮询 `scheduleListeningRestart`，`RESPONSE.COMPLETE` 后 1 秒延迟重回 LISTENING

**WebSocket 事件处理 `webSocketEvent()`：**

| type | msg | 动作 |
|---|---|---|
| `auth` | — | 读取 volume_control、pitch_factor、is_ota、is_reset |
| `server` | `RESPONSE.CREATED` | → `transitionToSpeaking()` |
| `server` | `RESPONSE.COMPLETE` / `RESPONSE.ERROR` | → 1s 延迟 → `transitionToListening()` |
| `server` | `AUDIO.COMMITTED` | → `deviceState = PROCESSING` |
| `server` | `SESSION.END` | → `sleepRequested = true` |
| `server` | `TRANSCRIPT.USER` | → 显示屏显示用户文本 |
| `server` | `TRANSCRIPT.ASSISTANT` | → 显示屏显示 AI 文本 |
| — | (二进制) | → Opus 解码 → audioBuffer |

**状态转换函数：**
| 函数 | 说明 |
|---|---|
| `transitionToSpeaking()` | 50ms 延迟, 清空麦克风, 状态→SPEAKING |
| `transitionToListening()` | 短暂 PROCESSING, 清空双向 I2S, 状态→LISTENING |
| `toggleChatState()` | IDLE/PROCESSING→发送 START_SESSION→LISTENING; LISTENING→STOP_SESSION→IDLE; SPEAKING→STOP_SESSION→打断→IDLE |

**WebSocket 初始化 `websocketSetup()`：**
- 自定义 Headers: `Authorization: Bearer <jwt>`, `X-Wifi-Rssi`, `X-Device-Mac`
- DEV_MODE: `webSocket.begin()` (明文)
- 非 DEV: `webSocket.beginSslWithCA()` (TLS)

### main.cpp — 入口与输入处理

**`setup()` 执行顺序：**
1. `Serial.begin(921600)`
2. `setupDeviceMetadata()` — 读 NVS (authToken, otaState)
3. 创建 `wsMutex` 互斥锁
4. 输入模式配置：
   - `TOUCH_MODE`: 创建 touchTask
   - `BUTTON_MODE` (默认): 配置深度睡眠唤醒源, 创建 Button, 设置回调
5. 从 NVS 加载音量 (默认 100)
6. 创建 FreeRTOS 任务 (LED → 扬声器 → 麦克风)
7. `displayInit()` + displayTask (DISPLAY_ENABLED)
8. 音量按钮 GPIO 初始化 (**必须在 displayInit 之后**)
9. 创建 volumeButtonTask
10. 创建 networkTask (Core 0)
11. `setupWiFi()` — 启动 WifiManager

**`loop()` (Core 1)：**
- 处理睡眠请求
- 处理 chatToggle 请求 → `toggleChatState()`
- OTA 轮询

**睡眠管理 `enterSleep()`：**
- 停止 I2S 驱动, 断开 WebSocket
- TOUCH_MODE: 等待释放 → `touchSleepWakeUpEnable()`
- BUTTON_MODE: `esp_sleep_enable_ext0_wakeup(BUTTON_PIN, LOW)`
- `esp_deep_sleep_start()`

**音量控制 `volumeButtonTask`：**
- GPIO 轮询 (20ms 间隔, 50ms 防抖)
- 短按: ±10 音量
- 长按 (800ms): 直接到 0 或 100
- 自动保存 NVS + 显示屏显示

### WifiManager.h / WifiManager.cpp — WiFi 管理

**职责：** WiFi 连接管理、SoftAP 配网门户、NVS 凭证存储

**主要功能：**
- 最多存储 4 组 SSID/密码 (NVS `"wifimanager"` 命名空间)
- 多 SSID 时自动扫描并连接最强信号
- 无可用 WiFi 时启动 SoftAP (`ELATO-DEVICE`), 120 秒超时
- 后台 WiFi 健康检查任务 (Core 0, 10 秒间隔)

**REST API (SoftAP 配网门户)：**
| 端点 | 方法 | 功能 |
|---|---|---|
| `/api/wifi/add` | POST | 添加 WiFi (JSON: apName, apPass) |
| `/api/wifi/scan` | GET | 扫描周围 WiFi |
| `/api/wifi/configlist` | GET | 已保存的 WiFi 列表 |
| `/api/wifi/status` | GET | 连接状态、IP、RSSI |
| `/api/wifi/id` | DELETE | 按索引删除 |
| `/api/wifi/apName` | DELETE | 按名称删除 |

**连接回调 `connectCb()`：**
```
WiFi 连接成功
  → OTA_IN_PROGRESS → performOTAUpdate()
  → OTA_COMPLETE → markOTAUpdateComplete() → 重启
  → 正常 → isDeviceRegistered() → websocketSetup()
```

**设备注册 `isDeviceRegistered()`：**
- 检查 NVS 中的 authToken
- 为空则调用 `GET /api/generate_auth_token?macAddress=<MAC>` 获取 JWT
- 存入 NVS `"auth"/"auth_token"`

### LEDHandler.h / LEDHandler.cpp — LED 状态指示

**状态-颜色映射：**
| 状态 | LED 颜色 |
|---|---|
| IDLE | 绿色 |
| LISTENING | 黄色 |
| SPEAKING | 蓝色 |
| PROCESSING | 红色 |
| SOFT_AP | 品红 |
| OTA | 青色 |

**注意：** LED 引脚使用反转逻辑 (LOW = 亮), 适配共阳极 RGB LED。

### DisplayHandler.h / DisplayHandler.cpp — OLED 显示

**硬件：** SSD1306 128×32, 硬件 I2C (400kHz)

**显示布局：**
| 行 | Y 坐标 | 内容 |
|---|---|---|
| 第一行 | y=10 | 设备状态 (Ready / Listening... / Speaking...) |
| 第二行 | y=28 | 对话文本 (You: ... / AI: ...) |

**文本滚动：** 超出 128px 宽度时水平滚动 (每 150ms 移动 6px, 首尾暂停 2 秒)

**线程安全：** `displayMutex` 保护共享数据

### OTA.h / OTA.cpp — 固件升级

| 函数 | 说明 |
|---|---|
| `performOTAUpdate()` | HTTPS 下载固件并写入 OTA 分区 |
| `markOTAUpdateComplete()` | POST 通知后端清除 OTA 标志 |
| `loopOTA()` | 轮询 OTA 状态, 成功→重启, 失败→重试 |

### FactoryReset.h — 出厂重置

| 函数 | 说明 |
|---|---|
| `factoryResetDevice()` | `nvs_flash_erase()` + `nvs_flash_init()` |
| `resetAuth()` | 清除 NVS 中的 auth_token |
| `setResetComplete()` | 通知后端 + 擦除 NVS |

## GPIO 引脚分配

| GPIO | 常量 | 用途 |
|---|---|---|
| 0 | `BUTTON_PIN` | BOOT 按钮 (单击=对话, 长按=睡眠) |
| 4 | `I2S_WS` | 麦克风 WS |
| 5 | `I2S_SCK` | 麦克风 SCK |
| 6 | `I2S_SD` | 麦克风 DATA |
| 7 | `I2S_DATA_OUT` | 扬声器 DATA |
| 8 | `GREEN_LED_PIN` | 绿色 LED |
| 9 | `RED_LED_PIN` | 红色 LED |
| 10 | `I2S_SD_OUT` | 扬声器 Enable |
| 13 | `BLUE_LED_PIN` | 蓝色 LED |
| 15 | `I2S_BCK_OUT` | 扬声器 BCLK |
| 16 | `I2S_WS_OUT` | 扬声器 LRCK |
| 39 | `VOLUME_DOWN_PIN` | 音量- |
| 40 | `VOLUME_UP_PIN` | 音量+ |
| 41 | `DISPLAY_SDA` | OLED I2C SDA |
| 42 | `DISPLAY_SCL` | OLED I2C SCL |
| 47 | `TOUCH_PAD_NUM2` | 触摸传感器 (仅 TOUCH_MODE) |

## FreeRTOS 任务分配

| 任务 | 核心 | 优先级 | 栈大小 | 功能 |
|---|---|---|---|---|
| networkTask | Core 0 | MAX-1 | 8192 | WebSocket.loop(), 状态调度 |
| wifiTask | Core 0 | 1 | 4096 | WiFi 健康检查/重连 |
| ledTask | Core 1 | 5 | 4096 | RGB LED 状态指示 |
| micTask | Core 1 | 4 | 4096 | I2S 麦克风采集 + WS 发送 |
| audioStreamTask | Core 1 | 3 | 4096 | Opus 解码 + I2S 扬声器输出 |
| volumeButtonTask | 任意 | 3 | 4096 | 音量按钮 GPIO 轮询 |
| displayTask | Core 1 | 2 | 4096 | OLED 刷新 (条件编译) |
| touchTask | 任意 | MAX-2 | 4096 | 触摸输入 (TOUCH_MODE) |
| Arduino loop() | Core 1 | 1 | — | 睡眠/OTA/按钮标志分发 |

## 音频管道

### 上行（麦克风 → 服务器）

```
I2S_PORT_IN (I2S_NUM_1) @16kHz mono 32-bit
  → 右移 12 bit → 截断为 int16_t (16-bit PCM)
  → webSocket.sendBIN(pcm_16bit)
  → Deno 服务器
```

### 下行（服务器 → 扬声器）

```
WebSocket 收到 Opus 二进制包
  → opusDecoder.write() → PCM → audioBuffer (10KB 环形缓冲区)
  → audioStreamTask 消费:
    读取 240 个 16-bit 样本
    → 二次方音量缩放 (vol² / 10000.0)
    → 16-bit mono → 32-bit stereo (sample << 16, 复制 L+R)
    → i2s_write(I2S_PORT_OUT) @24kHz
```

## NVS 存储布局

| 命名空间 | 键 | 类型 | 用途 |
|---|---|---|---|
| `auth` | `auth_token` | String | JWT 认证令牌 |
| `ota` | `status` | UInt | OTA 状态 |
| `is_reset` | `is_reset` | Bool | 出厂重置标志 |
| `wifimanager` | `apName0..3`, `apPass0..3` | String | WiFi 凭证 |
| `audio` | `volume` | Int | 音量 (0-100) |

## WebSocket 消息协议

**设备 → 服务器（二进制）：** 原始 16-bit PCM @16kHz

**设备 → 服务器（文本 JSON）：**
```json
{"type":"instruction","msg":"START_SESSION"}
{"type":"instruction","msg":"STOP_SESSION"}
{"type":"instruction","msg":"INTERRUPT"}
```

**服务器 → 设备（文本 JSON）：**
```json
{"type":"auth","volume_control":70,"is_ota":false,"is_reset":false,"pitch_factor":1.0}
{"type":"server","msg":"RESPONSE.CREATED","volume_control":70}
{"type":"server","msg":"RESPONSE.COMPLETE"}
{"type":"server","msg":"RESPONSE.ERROR"}
{"type":"server","msg":"AUDIO.COMMITTED"}
{"type":"server","msg":"SESSION.END"}
{"type":"server","msg":"TRANSCRIPT.USER","text":"..."}
{"type":"server","msg":"TRANSCRIPT.ASSISTANT","text":"..."}
```

**服务器 → 设备（二进制）：** Opus 编码音频包 @24kHz

## 模块依赖关系

```
main.cpp
  ├── Config.h (全局常量)
  ├── Audio.h (音频引擎)
  ├── WifiManager.h (WiFi)
  ├── LEDHandler.h (LED)
  ├── OTA.h (固件升级)
  ├── FactoryReset.h (出厂重置)
  ├── Button.h (按钮库)
  └── DisplayHandler.h (OLED, 条件编译)

Audio.cpp
  ├── Config.h (状态/引脚/常量)
  ├── OTA.h
  ├── PitchShift.h
  └── DisplayHandler.h (条件编译)

WifiManager.cpp
  ├── Config.h
  ├── OTA.h
  └── Audio.h (websocketSetup)
```

## 开发指南

**环境要求：**
- PlatformIO CLI（macOS: `~/.platformio/penv/bin/pio`）
- ESP32-S3 开发板, USB 连接

**编译与烧录：**
```bash
cd firmware-arduino
pio run -t upload          # 编译并烧录
pio device monitor -b 921600  # 串口监控
```

**模式切换（Config.h）：**
```cpp
#define DEV_MODE      // 开发模式
// #define PROD_MODE  // 生产模式
// #define ELATO_MODE // Elato 官方
```

**服务器地址（Config.cpp）：**
- DEV_MODE: `ws_server`, `ws_port`, `ws_path`, `backend_server`, `backend_port`

**WiFi 配网：**
- 设备无已存 WiFi 时自动创建 `ELATO-DEVICE` 热点
- 手机连接后访问 `http://192.168.4.1/wifi` 配置 WiFi
- WiFi 信息存入 NVS, 最多存储 4 组

## 关键设计决策

1. **BOOT 按钮需手动设置上拉** — ESP32_Button 库 `pullup=false` 设置下拉, 需构造后调用 `gpio_set_pull_mode(GPIO_PULLUP_ONLY)`
2. **音量按钮必须在 `displayInit()` 之后初始化** — U8G2 软件 I2C 会覆盖 GPIO 39/40 配置
3. **音量按钮使用 GPIO 轮询** — ESP32_Button 库无法单独设置上拉+低电平触发
4. **扬声器使用 ESP-IDF legacy I2S** — AudioTools I2SStream 不满足 32-bit stereo 帧需求
5. **音频 16→32bit 转换** — I2S TX 使用 32-bit 帧宽, 数据在高 16 位
6. **wsMutex 互斥锁** — networkTask 和 micTask 共享 WebSocket, 防止数据竞争
7. **无 PSRAM 要求** — audioBuffer 仅 10KB, 运行在 ESP32-S3 内部 RAM
