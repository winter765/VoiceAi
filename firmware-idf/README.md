# firmware-idf 代码架构文档

## 目录结构

```
firmware-idf/
├── CMakeLists.txt              # 顶层 CMake 配置
├── sdkconfig                   # ESP-IDF 配置
├── partitions/v2/16m.csv       # Flash 分区表 (16MB)
└── main/
    ├── CMakeLists.txt          # 组件 CMake 配置、源文件列表
    ├── Kconfig.projbuild       # 项目级 Kconfig 配置
    ├── main.cc                 # 入口函数 app_main()
    ├── application.cc/h        # 核心应用逻辑、状态机、事件循环
    ├── device_state.h          # 设备状态枚举
    ├── device_state_machine.cc/h # 状态机实现
    ├── settings.cc/h           # NVS 设置管理
    ├── system_info.cc/h        # 系统信息（MAC、版本等）
    ├── ota.cc/h                # OTA 固件升级
    ├── assets.cc/h             # 资源管理（字体、表情、唤醒词模型）
    ├── mcp_server.cc/h         # MCP 协议服务端
    ├── mouth_control.cc/h      # 口型控制（外接玩具动嘴）
    ├── audio/                  # 音频子系统
    │   ├── audio_service.cc/h  # 音频服务（编解码、队列管理）
    │   ├── audio_codec.cc/h    # 音频编解码抽象层
    │   ├── audio_processor.h   # 音频处理器接口（AFE/VAD）
    │   ├── wake_word.h         # 唤醒词检测接口
    │   ├── codecs/             # 硬件编解码器驱动
    │   │   ├── no_audio_codec.cc    # 纯软件 I2S 编解码
    │   │   ├── es8311_audio_codec.cc
    │   │   ├── es8388_audio_codec.cc
    │   │   └── ...
    │   ├── processors/         # 音频处理器实现
    │   │   ├── afe_audio_processor.cc  # ESP-SR AFE
    │   │   └── no_audio_processor.cc   # 无处理
    │   ├── wake_words/         # 唤醒词实现
    │   │   ├── afe_wake_word.cc       # ESP-SR WakeNet
    │   │   └── custom_wake_word.cc    # 自定义唤醒词
    │   └── demuxer/
    │       └── ogg_demuxer.cc  # OGG 解封装（本地音效）
    ├── protocols/              # 通信协议
    │   ├── protocol.cc/h       # 协议抽象基类
    │   ├── elato_protocol.cc/h # ElatoAI WebSocket 协议
    │   ├── websocket_protocol.cc/h  # 通用 WebSocket 协议
    │   └── mqtt_protocol.cc/h  # MQTT+UDP 协议
    ├── display/                # 显示子系统
    │   ├── display.cc/h        # 显示抽象层
    │   ├── oled_display.cc/h   # SSD1306 OLED 驱动
    │   ├── lcd_display.cc/h    # LCD 驱动
    │   └── lvgl_display/       # LVGL 图形界面
    ├── led/                    # LED 子系统
    │   ├── led.h               # LED 抽象接口
    │   ├── gpio_led.cc/h       # 单色 GPIO LED
    │   ├── single_led.cc/h     # WS2812 单灯
    │   ├── circular_strip.cc/h # WS2812 灯环
    │   └── elato_rgb_led.cc/h  # ElatoAI RGB LED（分立 GPIO）
    ├── boards/                 # 板级支持包
    │   ├── common/             # 通用板级组件
    │   │   ├── board.cc/h      # Board 基类
    │   │   ├── wifi_board.cc/h # WiFi 板基类
    │   │   ├── ml307_board.cc/h # 4G 模块板基类
    │   │   ├── button.cc/h     # 按钮驱动
    │   │   ├── system_reset.cc/h # 系统重置
    │   │   └── ...
    │   └── bread-compact-wifi/ # ElatoAI 默认板
    │       ├── config.h        # GPIO 引脚定义
    │       └── compact_wifi_board.cc
    └── assets/                 # 语言资源
        ├── lang_config.h       # 自动生成的语言字符串
        └── locales/            # 多语言 JSON
```

## 构建配置

| 配置项 | 值 |
|---|---|
| 框架 | ESP-IDF 5.5.2 |
| 目标芯片 | ESP32-S3 |
| Flash 大小 | 16 MB |
| PSRAM | 8 MB (Octal) |
| C++ 标准 | C++17 |

**Kconfig 配置项：**
| 配置项 | 默认值 | 说明 |
|---|---|---|
| `CONFIG_ELATO_BACKEND_URL` | `https://console.novarian.ai` | 后端 API 地址 |
| `CONFIG_ELATO_WS_URL` | `wss://voice.novarian.ai` | WebSocket 地址 |
| `CONFIG_OTA_URL` | (空) | OTA 检查 URL，空则使用 backend+/api/ota |

**Flash 分区表 (partitions/v2/16m.csv)：**
| 名称 | 类型 | 偏移 | 大小 | 用途 |
|---|---|---|---|---|
| nvs | data | 0x9000 | 16 KB | NVS 键值存储 |
| otadata | data | 0xd000 | 8 KB | OTA 引导数据 |
| phy_init | data | 0xf000 | 4 KB | PHY 校准数据 |
| ota_0 | app | 0x20000 | ~4 MB | OTA 槽位 0 |
| ota_1 | app | - | ~4 MB | OTA 槽位 1 |
| assets | data | 0x800000 | 8 MB | 资源分区（字体、表情、模型） |

## 核心模块

### main.cc — 入口函数

```cpp
extern "C" void app_main(void) {
    nvs_flash_init();
    Application::GetInstance().Initialize();
    Application::GetInstance().Run();  // 主事件循环，永不返回
}
```

### device_state.h — 设备状态枚举

```
Unknown → Starting → WifiConfiguring → Activating → Idle
                                            ↓
                          Connecting → Listening ↔ Speaking
                                            ↓
                                       Upgrading / AudioTesting / FatalError
```

| 状态 | 说明 |
|---|---|
| `kDeviceStateUnknown` | 初始状态 |
| `kDeviceStateStarting` | 系统启动中 |
| `kDeviceStateWifiConfiguring` | WiFi 配网模式 |
| `kDeviceStateActivating` | 激活流程（OTA 检查、资源加载） |
| `kDeviceStateIdle` | 空闲，等待唤醒 |
| `kDeviceStateConnecting` | 连接服务器中 |
| `kDeviceStateListening` | 监听用户语音 |
| `kDeviceStateSpeaking` | AI 语音播放中 |
| `kDeviceStateUpgrading` | OTA 升级中 |
| `kDeviceStateAudioTesting` | 音频测试模式 |
| `kDeviceStateFatalError` | 致命错误 |

### application.cc — 核心应用

**职责：** 初始化、事件分发、状态管理、协议调度

**FreeRTOS 事件位：**
| 事件 | 说明 |
|---|---|
| `MAIN_EVENT_SCHEDULE` | 有待执行的调度任务 |
| `MAIN_EVENT_WAKE_WORD_DETECTED` | 检测到唤醒词 |
| `MAIN_EVENT_NETWORK_CONNECTED` | 网络已连接 |
| `MAIN_EVENT_NETWORK_DISCONNECTED` | 网络断开 |
| `MAIN_EVENT_TOGGLE_CHAT` | 切换对话状态 |
| `MAIN_EVENT_STATE_CHANGED` | 设备状态变化 |
| `MAIN_EVENT_LISTENING_TIMEOUT` | 监听超时 |

**主要方法：**
| 方法 | 说明 |
|---|---|
| `Initialize()` | 初始化显示、音频、网络回调 |
| `Run()` | 主事件循环（阻塞） |
| `SetDeviceState()` | 状态转换 |
| `Schedule()` | 调度回调到主任务执行 |
| `ToggleChatState()` | 切换对话状态 |
| `WakeWordInvoke()` | 处理唤醒词事件 |
| `AbortSpeaking()` | 打断 AI 语音 |

**ActivationTask 流程：**
1. 创建 OTA 对象
2. 标记当前固件有效
3. 检查 OTA 版本，有新版则升级
4. 加载资源（字体、唤醒词模型）
5. 初始化协议
6. 发送 `MAIN_EVENT_ACTIVATION_DONE`

### audio/audio_service.cc — 音频服务

**音频管道：**
```
上行：MIC → [AFE/VAD] → {Encode Queue} → [Opus Encoder] → {Send Queue} → Server
下行：Server → {Decode Queue} → [Opus Decoder] → {Playback Queue} → Speaker
```

**关键常量：**
- `OPUS_FRAME_DURATION_MS = 20` — Opus 帧时长
- `MAX_DECODE_PACKETS_IN_QUEUE = 120` — 解码队列最大包数
- `MAX_SEND_PACKETS_IN_QUEUE = 120` — 发送队列最大包数

**Opus 编码器配置：**
```cpp
sample_rate = 16000 Hz
channel = mono
bits_per_sample = 16
bitrate = AUTO
frame_duration = 20ms
enable_dtx = true  // 静音时节省带宽
enable_vbr = true  // 可变比特率
```

**FreeRTOS 任务：**
| 任务 | 核心 | 优先级 | 功能 |
|---|---|---|---|
| AudioInputTask | - | 4 | I2S 输入 → AFE/VAD → 编码队列 |
| AudioOutputTask | - | 4 | 播放队列 → I2S 输出 |
| OpusCodecTask | - | 5 | Opus 编解码 |

### protocols/elato_protocol.cc — ElatoAI 协议

**职责：** WebSocket 通信、消息解析、音频流转发

**音频格式：**
- 输入：Opus 编码，16kHz mono，20ms 帧
- 输出：Opus 编码，24kHz mono，20ms 帧

**WebSocket 消息类型：**

**设备 → 服务器（文本 JSON）：**
```json
{"type":"instruction","msg":"START_SESSION"}
{"type":"instruction","msg":"STOP_SESSION"}
{"type":"instruction","msg":"INTERRUPT"}
```

**设备 → 服务器（二进制）：** 原始 Opus 包

**服务器 → 设备（文本 JSON）：**
```json
{"type":"auth","volume_control":70,"is_ota":false,"is_reset":false}
{"type":"server","msg":"RESPONSE.CREATED","volume_control":70}
{"type":"server","msg":"RESPONSE.COMPLETE"}
{"type":"server","msg":"RESPONSE.ERROR"}
{"type":"server","msg":"AUDIO.COMMITTED"}
{"type":"server","msg":"TRANSCRIPT.USER","text":"..."}
{"type":"server","msg":"TRANSCRIPT.ASSISTANT","text":"..."}
```

**服务器 → 设备（二进制）：** Opus 编码音频包

**消息处理：**
| 消息 | 动作 |
|---|---|
| `auth` | 设置音量、检查 OTA/重置标志 |
| `RESPONSE.CREATED` | → `kDeviceStateSpeaking` |
| `RESPONSE.COMPLETE` | → `kDeviceStateListening` 或 `kDeviceStateIdle` |
| `AUDIO.COMMITTED` | 打断当前播放（Barge-in） |
| `TRANSCRIPT.*` | 更新显示屏文本 |

### boards/bread-compact-wifi — ElatoAI 默认板

**初始化流程：**
1. 初始化显示屏 I2C
2. 初始化 SSD1306 OLED
3. 初始化按钮（BOOT、音量+/-）
4. 初始化外设（LED、MCP 工具、口型控制）

**组件获取：**
| 方法 | 返回 |
|---|---|
| `GetLed()` | ElatoRgbLed (GPIO 8/9/13) |
| `GetAudioCodec()` | NoAudioCodecSimplex |
| `GetDisplay()` | OledDisplay (128×32) |

## GPIO 引脚分配 (bread-compact-wifi)

| GPIO | 常量 | 用途 |
|---|---|---|
| 0 | `BOOT_BUTTON_GPIO` | BOOT 按钮（单击=对话，长按=睡眠） |
| 4 | `AUDIO_I2S_MIC_GPIO_WS` | 麦克风 I2S WS |
| 5 | `AUDIO_I2S_MIC_GPIO_SCK` | 麦克风 I2S SCK |
| 6 | `AUDIO_I2S_MIC_GPIO_DIN` | 麦克风 I2S DATA |
| 7 | `AUDIO_I2S_SPK_GPIO_DOUT` | 扬声器 I2S DATA |
| 8 | `ELATO_LED_GREEN_GPIO` | RGB LED 绿色 |
| 9 | `ELATO_LED_RED_GPIO` | RGB LED 红色 |
| 13 | `ELATO_LED_BLUE_GPIO` | RGB LED 蓝色 |
| 15 | `AUDIO_I2S_SPK_GPIO_BCLK` | 扬声器 I2S BCLK |
| 16 | `AUDIO_I2S_SPK_GPIO_LRCK` | 扬声器 I2S LRCK |
| 17 | `MOUTH_GPIO` | 口型控制（AI 说话时高电平） |
| 18 | `LAMP_GPIO` | MCP 灯控测试 |
| 39 | `VOLUME_DOWN_BUTTON_GPIO` | 音量- 按钮 |
| 40 | `VOLUME_UP_BUTTON_GPIO` | 音量+ 按钮 |
| 41 | `DISPLAY_SDA_PIN` | OLED I2C SDA |
| 42 | `DISPLAY_SCL_PIN` | OLED I2C SCL |
| 47 | `TOUCH_BUTTON_GPIO` | 触摸按钮 |
| 48 | `BUILTIN_LED_GPIO` | WS2812 LED（未使用） |

## LED 状态指示 (ElatoRgbLed)

| 状态 | 颜色 | 效果 |
|---|---|---|
| Starting | 蓝色 | 闪烁 |
| WifiConfiguring | 蓝色 | 慢闪 |
| Idle | 绿色 | 常亮（低亮度） |
| Connecting | 绿色 | 常亮 |
| Listening | 绿色 | 渐变呼吸 |
| Speaking | 蓝色 | 常亮 |
| Upgrading | 蓝色 | 快闪 |
| Error | 红色 | 常亮 |

## NVS 存储布局

| 命名空间 | 键 | 类型 | 用途 |
|---|---|---|---|
| `websocket` | `url` | String | WebSocket URL |
| `websocket` | `token` | String | JWT 认证令牌 |
| `wifi` | `backend_url` | String | 后端 URL |
| `wifi` | `ota_url` | String | OTA URL |
| `audio` | `volume` | Int | 音量 (0-100) |
| `mqtt` | `endpoint` | String | MQTT 端点 |
| `assets` | `download_url` | String | 待下载资源 URL |

## 模块依赖关系

```
main.cc
  └── Application
        ├── Board (硬件抽象)
        │     ├── Display
        │     ├── Led
        │     ├── AudioCodec
        │     └── Network
        ├── AudioService
        │     ├── AudioProcessor (AFE/VAD)
        │     ├── WakeWord (ESP-SR)
        │     └── Opus Encoder/Decoder
        ├── Protocol (ElatoProtocol)
        │     └── WebSocket
        ├── Ota
        ├── Assets
        └── DeviceStateMachine
```

## 开发指南

**环境要求：**
- ESP-IDF 5.5.2+
- Python 3.8+

**首次配置：**
```bash
cd firmware-idf
./build_elato.sh  # 选择 bread-compact-wifi + SSD1306 128*32
```

**编译与烧录：**
```bash
source ~/esp/esp-idf/export.sh
idf.py build
idf.py flash monitor
```

**清除配置重新烧录：**
```bash
idf.py erase-flash
idf.py flash monitor
```

**串口监控：**
```bash
idf.py monitor  # 波特率 115200
```

## 关键设计决策

1. **状态机驱动** — 所有状态转换通过 `DeviceStateMachine` 管理，支持监听器模式
2. **事件循环架构** — 主任务通过 FreeRTOS 事件组等待事件，避免轮询
3. **音频双队列** — 编解码与 I/O 解耦，使用独立任务处理 Opus 编解码
4. **板级抽象** — Board 基类提供统一接口，各板实现自己的硬件初始化
5. **协议抽象** — Protocol 基类支持 WebSocket/MQTT 等多种通信方式
6. **资源分区** — 8MB 资源分区用于存储字体、表情、唤醒词模型，支持 OTA 更新
7. **唤醒词检测** — 使用 ESP-SR WakeNet，支持自定义唤醒词
8. **口型同步** — MouthControl 监听状态变化，AI 说话时输出高电平

## 与 firmware-arduino 的主要差异

| 特性 | firmware-idf | firmware-arduino |
|---|---|---|
| 框架 | ESP-IDF 5.5 | Arduino + PlatformIO |
| 唤醒词 | ESP-SR WakeNet ✅ | 不支持 ❌ |
| 音频处理 | AFE (AEC/VAD) ✅ | 简单 VAD |
| 资源分区 | 8MB (字体/表情/模型) | 3MB SPIFFS |
| 状态机 | 完整实现 | 简单枚举 |
| 多板支持 | 70+ 板型 | 1 板型 |
| 编译时间 | ~2 分钟 | ~40 秒 |
