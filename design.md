# ElatoAI 技术设计文档

## 1. 总体架构

ElatoAI 是一个实时语音 AI 系统，由三层组成：

```
用户语音 → ESP32-S3 设备 ←WebSocket→ Deno 边缘服务器 ←WebSocket/API→ AI 提供商
                                              ↕
                                         Supabase DB
                                              ↑
                               Next.js 前端 Web 应用
```

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 固件 | ESP32-S3, PlatformIO/Arduino, C++ |
| 音频编解码 | Opus (arduino-libopus, @evan/opus) |
| I2S 音频 | arduino-audio-tools |
| WebSocket (设备) | arduinoWebSockets (links2004) |
| 设备 HTTP | ESPAsyncWebServer |
| 边缘服务器 | Deno (TypeScript), ws npm 包 |
| AI SDK | OpenAI Realtime, Google GenAI, ElevenLabs, Hume, xAI, Ultravox |
| 数据库 | Supabase (PostgreSQL + RLS) |
| 认证 | Supabase Auth + 自定义 JWT (HS256) |
| 前端 | Next.js 15, Tailwind CSS, Radix UI, shadcn |
| 支付 | Stripe |
| 部署 | Vercel (前端), AWS Lightsail (边缘), Supabase Cloud (DB) |

## 3. 固件架构 (firmware-arduino/)

### 3.1 核心文件

| 文件 | 职责 |
|---|---|
| Config.h / Config.cpp | 引脚定义、模式配置 (DEV/PROD/ELATO)、全局变量 |
| main.cpp | setup/loop，FreeRTOS 任务创建，按钮/触摸注册，睡眠管理 |
| Audio.cpp / Audio.h | 音频管道（I2S 输入输出）、WebSocket 事件处理、Opus 解码 |
| WifiManager.cpp / WifiManager.h | WiFi 管理、SoftAP 配网门户、NVS 存储 |
| LEDHandler.cpp / LEDHandler.h | RGB LED 状态指示 |
| DisplayHandler.cpp / DisplayHandler.h | SSD1306 OLED 显示 |
| OTA.cpp / OTA.h | 固件空中升级 |
| FactoryReset.h | 出厂重置逻辑 |

### 3.2 设备状态机

```
SETUP → IDLE ←→ LISTENING ←→ SPEAKING
                    ↓              ↓
              PROCESSING      PROCESSING

IDLE/PROCESSING → (按钮单击) → LISTENING
LISTENING       → (按钮单击) → IDLE
SPEAKING        → (按钮单击) → IDLE (打断回复)
任意状态        → (长按/双击) → SLEEP (深度睡眠)
```

### 3.3 FreeRTOS 任务分配

| 任务 | 核心 | 优先级 | 功能 |
|---|---|---|---|
| networkTask | Core 0 | MAX-1 | WebSocket.loop()，调度状态转换 |
| audioStreamTask | Core 1 | 3 | I2S 输出，Opus 解码，16→32 bit 转换 |
| micTask | Core 1 | 4 | I2S 输入，32→16 bit 转换，发送 PCM |
| ledTask | Core 1 | 5 | RGB LED 状态指示 |
| displayTask | Core 1 | 2 | SSD1306 OLED 滚动字幕 |
| volumeButtonTask | 任意 | 3 | GPIO 轮询音量按钮 (GPIO 39/40) |
| wifiTask | Core 0 | 1 | WiFi 健康检查，重连 |

### 3.4 音频管道

**输入（麦克风 → WebSocket）：**
```
I2S_PORT_IN (I2S_NUM_1) @16kHz mono 32-bit
  → 右移 12 bit → 截断为 int16_t
  → webSocket.sendBIN(pcm_16bit)
  → Deno 服务器收到原始 16-bit PCM @16kHz
```

**输出（WebSocket → 扬声器）：**
```
收到 Opus 二进制包
  → opusDecoder.write() → PCM → audioBuffer (BufferRTOS, 10KB)
  → audioStreamTask 消费:
    audioBuffer.readArray(480 bytes)
    → 应用音量 (quadratic: vol²)
    → 16-bit mono → 32-bit stereo (sample << 16, 复制 L+R)
    → i2s_write(I2S_PORT_OUT) @24kHz
```

**关键参数：**
- 麦克风采样率：16kHz, mono, 16-bit PCM
- 扬声器采样率：24kHz, stereo frame, 32-bit I2S TX
- Opus 缓冲区：10KB (AUDIO_BUFFER_SIZE)

### 3.5 GPIO 引脚分配

| GPIO | 用途 | 备注 |
|---|---|---|
| 0 | BOOT 按钮 (BUTTON_PIN) | 单击=toggleChat，长按/双击=睡眠 |
| 4 | I2S_WS (麦克风) | |
| 5 | I2S_SCK (麦克风) | bread-compact-wifi |
| 6 | I2S_SD (麦克风 DATA) | bread-compact-wifi |
| 7 | I2S_DATA_OUT (扬声器) | |
| 8 | GREEN_LED_PIN | |
| 9 | RED_LED_PIN | |
| 10 | I2S_SD_OUT (扬声器 Enable) | |
| 13 | BLUE_LED_PIN | |
| 15 | I2S_BCK_OUT (扬声器 BCLK) | bread-compact-wifi |
| 16 | I2S_WS_OUT (扬声器 LRCK) | bread-compact-wifi |
| 39 | VOLUME_DOWN_PIN | 按下接地，需上拉 |
| 40 | VOLUME_UP_PIN | 按下接地，需上拉 |
| 41 | DISPLAY_SDA (OLED I2C) | |
| 42 | DISPLAY_SCL (OLED I2C) | |
| 47 | 触摸传感器 (TOUCH_PAD_NUM2) | 仅 TOUCH_MODE |

### 3.6 WebSocket 消息协议

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

### 3.7 WiFi 管理

- NVS 存储最多 4 个 SSID/密码
- 无 WiFi 时启动 SoftAP 配置门户（SSID: "ELATO-DEVICE"）
- 内嵌 Web UI (`/wifi`) 供用户配置 WiFi
- RESTful API: `/api/wifi/add`, `/api/wifi/scan`, `/api/wifi/configlist`, `/api/wifi/status`
- WiFi 连接成功后触发 `connectCb()` → 获取 JWT → 建立 WebSocket

## 4. Deno 边缘服务器 (server-deno/)

### 4.1 核心文件

| 文件 | 职责 |
|---|---|
| main.ts | HTTP 服务器，WebSocket 升级，认证，AI 提供商路由 |
| supabase.ts | DB 操作，系统提示构建，对话历史存储 |
| utils.ts | JWT 验证，Opus 编码器工厂，音频工具函数 |
| types.d.ts | 全局 TypeScript 类型定义 |
| models/*.ts | 各 AI 提供商适配器 |

### 4.2 WebSocket 连接流程

```
ESP32 发起 WS upgrade 请求
  Headers: Authorization: Bearer <jwt>, X-Device-Mac: <mac>
  → jwtVerify(authToken, JWT_SECRET_KEY)
  → getUserByEmail(supabase, email)
  → 验证 MAC 地址 (非 DEV 模式)
  → 建立 WebSocket 连接

连接建立后：
  → 加载聊天历史 (最近20条)
  → 构建 systemPrompt (commonPrompt + userPrompt)
  → 发送 auth 消息 (volume, pitch_factor, is_ota, is_reset)
  → 按 personality.provider 路由到对应 AI 提供商
```

### 4.3 AI 提供商适配器

| 提供商 | 模型 | 输入 | 输出 | 特点 |
|---|---|---|---|---|
| OpenAI | gpt-realtime-1.5 | 16kHz PCM→base64 | PCM→Opus | Server VAD, tool calling |
| Gemini | gemini-2.5-flash-native-audio | 16kHz PCM→base64 | PCM→Opus | 自动 VAD |
| Grok/xAI | - | 16kHz PCM | 24kHz PCM→Opus | 类 OpenAI 协议 |
| ElevenLabs | ConvAI | PCM→重采样 | PCM→重采样→Opus | signed URL, SDK |
| Hume | EVI | 24kHz linear16 | WAV 48kHz→下采样→Opus | 情感分析 |
| Ultravox | fixie-ai/ultravox | 16kHz PCM 直传 | 24kHz PCM→Opus | 按需创建/销毁通话 |

### 4.4 Opus 编码（服务器端）

```
createOpusPacketizer(sendPacket)
  参数：24kHz, mono, voip, 24kbps, 20ms frame
  FRAME_SIZE = 960 bytes (24000 * 20ms / 1000 * 2)
  push(pcm) → 积累到 960 字节 → encode → sendPacket(opusPacket)
```

### 4.5 系统提示构建

```
createSystemPrompt(chatHistory, payload)
  → is_story=true → 交互式故事讲述模板
  → 否则 → commonPrompt + UserPromptTemplate
    包含: voice_prompt, character_prompt, 聊天历史, 当前时间, 语言
    UserPromptTemplate: supervisee_name/age/persona
```

## 5. Next.js 前端 (frontend-nextjs/)

### 5.1 API 路由

| 路由 | 方法 | 功能 |
|---|---|---|
| `/api/generate_auth_token` | GET | 根据 MAC 地址生成设备 JWT (有效期10年) |
| `/api/session` | GET | 获取 OpenAI Realtime ephemeral token (Web WebRTC) |
| `/api/ota_update_handler` | POST | 清除 OTA 标志 |
| `/api/factory_reset_handler` | POST | 清除 factory reset 标志 |
| `/api/checkout` | POST | Stripe 购买流程 |

### 5.2 核心依赖

- `@supabase/ssr` + `@supabase/supabase-js` — 认证与数据库
- `openai` — Web 端 WebRTC 直连
- `jose` + `jsonwebtoken` — JWT 签名/验证
- `stripe` — 支付集成
- Radix UI + shadcn — UI 组件库
- `framer-motion` — 动画

## 6. 数据库 Schema (Supabase)

### 6.1 表结构

#### languages
| 列 | 类型 | 说明 |
|---|---|---|
| language_id | UUID PK | |
| code | TEXT UNIQUE | "en-US", "de-DE" 等 |
| name | TEXT | |
| flag | TEXT | emoji 旗帜 |

#### personalities
| 列 | 类型 | 说明 |
|---|---|---|
| personality_id | UUID PK | |
| key | TEXT UNIQUE | "elato_default", "sherlock" 等 |
| provider | TEXT NOT NULL | "openai"/"gemini"/"grok"/"elevenlabs"/"hume"/"ultravox" |
| oai_voice | TEXT | 语音 ID/名称 |
| voice_prompt | TEXT | 语音风格描述 |
| character_prompt | TEXT | 角色系统提示词 |
| title / subtitle | TEXT | 显示名称 |
| short_description | TEXT | 简短描述 |
| is_doctor | BOOL | 医疗角色标志 |
| is_child_voice | BOOL | 儿童语音标志 |
| is_story | BOOL | 交互式故事模式 |
| pitch_factor | REAL | 音调调节因子 (默认 1.0) |
| first_message_prompt | TEXT | 首条消息提示 |
| creator_id | UUID FK→users | 自定义角色创建者 |

#### devices
| 列 | 类型 | 说明 |
|---|---|---|
| device_id | UUID PK | |
| mac_address | TEXT UNIQUE | ESP32 MAC 地址 |
| user_code | TEXT UNIQUE | 设备配对码 |
| user_id | UUID FK→users | |
| is_ota | BOOL | OTA 升级触发标志 |
| is_reset | BOOL | 出厂重置触发标志 |
| volume | SMALLINT | 音量 (默认 70) |

#### users
| 列 | 类型 | 说明 |
|---|---|---|
| user_id | UUID PK | |
| email | TEXT | |
| supervisor_name | TEXT | 家长/管理员名 |
| supervisee_name | TEXT | 使用者名 |
| supervisee_persona | TEXT | 使用者描述（兴趣爱好） |
| supervisee_age | SMALLINT | 使用者年龄 |
| personality_id | UUID FK→personalities | 绑定的角色 |
| language_code | TEXT FK→languages | |
| device_id | UUID FK→devices | |
| session_time | INTEGER | 累计对话秒数 |
| is_premium | BOOL | 付费用户标志 |
| user_info | JSONB | 用户类型和元数据 |

#### conversations
| 列 | 类型 | 说明 |
|---|---|---|
| conversation_id | UUID PK | |
| user_id | UUID FK→users | |
| role | TEXT | "user" / "assistant" |
| content | TEXT | 对话内容 |
| personality_key | TEXT FK→personalities(key) | |
| is_sensitive | BOOL | 敏感内容标志 |
| chat_group_id | UUID | 对话分组 |

#### api_keys
| 列 | 类型 | 说明 |
|---|---|---|
| api_key_id | UUID PK | |
| user_id | UUID FK→users | |
| encrypted_key | TEXT | AES-256-CBC 加密的 API Key |
| iv | TEXT | 加密向量 (base64) |

## 7. 完整数据流

### 7.1 启动流程

```
ESP32 上电
  → 读取 NVS (authToken, otaState, volume)
  → 创建 FreeRTOS 任务
  → 初始化 OLED 显示屏
  → 初始化音量按钮 GPIO (必须在 displayInit 之后)
  → 启动 WiFi 管理器 (SoftAP fallback)
  → WiFi 连接成功 → connectCb()
  → GET /api/generate_auth_token → 获取/缓存 JWT
  → websocketSetup() 建立 WS 连接
  → 收到 auth 消息 → deviceState = IDLE
```

### 7.2 对话流程（以 Ultravox 为例）

```
[设备 IDLE] → 用户按按钮
  → 发送 START_SESSION → transitionToListening()

[服务器] → 收到 START_SESSION
  → POST https://api.ultravox.ai/api/calls (创建通话)
  → WebSocket 连接 Ultravox joinUrl

[设备] → micTask 采集 PCM → sendBIN()
[服务器] → 转发 PCM → Ultravox

[Ultravox] → 生成语音回复 → 发送 PCM @24kHz
[服务器] → PCM → Opus 编码 → 发给设备
  → 首个包时发送 RESPONSE.CREATED

[设备] → transitionToSpeaking()
  → Opus 解码 → audioBuffer → I2S 输出 → 扬声器播放

[Ultravox] → agent_audio_done
[服务器] → 发送 RESPONSE.COMPLETE → 保存对话记录到 DB
[设备] → 1秒后 → transitionToListening() → 等待下一轮输入
```

### 7.3 打断流程

```
[设备 SPEAKING] → 用户按按钮
  → 发送 STOP_SESSION → 清空 audioBuffer → deviceState = IDLE
[服务器] → 关闭 Ultravox WS (ESP32 WS 保持连接)
```

## 8. 认证流程

### 8.1 设备认证

```
设备 MAC 地址 → GET /api/generate_auth_token?macAddress=XX:XX:XX:XX:XX:XX
  → 查 devices 表 → 关联 users
  → 签名 JWT: {sub: user_id, email, exp: 10年}
  → 设备存 NVS，WS 连接时携带 Authorization: Bearer <jwt>
  → 服务器验证 JWT → 解出 email → 获取用户信息
```

### 8.2 Web 用户认证

```
Next.js 前端 → Supabase Auth (OAuth / email)
Middleware 自动刷新 session
```

### 8.3 用户 API Key 加密

```
用户 API Key → AES-256-CBC 加密 (ENCRYPTION_KEY 主密钥)
  → 存 api_keys 表 (encrypted_key + iv)
  → 服务器按需解密
```

## 9. 部署结构

### 本地开发 (DEV_MODE)

| 服务 | 命令 | 地址 |
|---|---|---|
| Deno | `deno run -A --env-file=.env main.ts` | `ws://0.0.0.0:8000` |
| Next.js | `npm run dev` | `http://0.0.0.0:3000` |
| 固件 | `ws_server = "192.168.x.x"` | 无 SSL |

### 公网部署 (AWS Lightsail)

| 组件 | 配置 |
|---|---|
| 服务器 | Ubuntu 22, IP: 35.162.7.133 |
| nginx | 监听 80，`/ws` → Deno:8080，`/` → Next.js:3000 |
| Deno | DEV_MODE，端口 8080 |
| Next.js | standalone 模式，端口 3000 |
| 固件 | `ws_server="35.162.7.133"`, port=80, path="/ws" |

## 10. 开发指南

### 10.1 固件开发 (firmware-arduino/)

**环境要求：**
- PlatformIO CLI（macOS 路径: `~/.platformio/penv/bin/pio`）
- ESP32-S3 开发板，USB 连接

**编译与烧录：**
```bash
cd firmware-arduino
pio run -t upload          # 编译并烧录
pio device monitor -b 921600  # 串口监控
```

**模式切换（Config.h）：**
```cpp
#define DEV_MODE      // 开发模式：本地服务器地址，可硬编码 WiFi
// #define PROD_MODE  // 生产模式：公网地址，HTTPS/WSS
// #define ELATO_MODE // Elato 官方模式
```

**服务器地址配置（Config.cpp）：**
- DEV_MODE: `ws_server`, `ws_port`, `ws_path`, `backend_server`, `backend_port`
- 本地开发时指向局域网 IP，公网部署时改为服务器 IP

**关键编译标志（platformio.ini）：**
```ini
build_flags =
    -std=gnu++17
    -D CORE_DEBUG_LEVEL=5
    -D DISPLAY_ENABLED=1      # 启用 OLED 显示屏
    -D TOUCH_SENSOR_ENABLE=1   # 启用触摸传感器驱动
```

**依赖库：**
| 库 | 用途 |
|---|---|
| ArduinoJson | JSON 解析 |
| WebSockets (links2004) | WebSocket 客户端 |
| ESPAsyncWebServer | WiFi 配网 Web UI |
| ESP32_Button | 按钮事件检测 |
| arduino-audio-tools | I2S 音频框架 |
| arduino-libopus | Opus 解码 |
| U8g2 | SSD1306 OLED 驱动 |

**WiFi 配网：**
- 设备无已存 WiFi 时自动创建 `ELATO-DEVICE` 热点
- 手机连接后访问 `http://192.168.4.1/wifi` 配置 WiFi
- WiFi 信息存入 NVS，最多存储 4 组

### 10.2 Deno 服务器开发 (server-deno/)

**环境要求：**
- Deno 运行时

**启动命令：**
```bash
cd server-deno
cp .env.example .env  # 首次需要配置环境变量
deno run -A --env-file=.env main.ts
```

> **注意：** 必须带 `--env-file=.env`，否则 Supabase 连接会报错

**环境变量（.env）：**
```
# Supabase
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_KEY=<anon-key>
JWT_SECRET_KEY=<jwt-secret>

# AI 提供商 API Key（按需配置）
OPENAI_API_KEY=...
GEMINI_API_KEY=...
XAI_API_KEY=...
ELEVENLABS_API_KEY=...
HUME_API_KEY=...
ULTRAVOX_API_KEY=...

# 加密主密钥（用于解密用户存储的 API Key）
ENCRYPTION_KEY=...

# 开发模式
HOST=0.0.0.0
PORT=8000
DEV_MODE=True
```

**开发模式 vs 生产模式：**
- `DEV_MODE=True`: 端口 8000，跳过 MAC 地址验证
- 生产模式: 端口 8080，启用 MAC 地址校验

**代码格式化：**
```bash
deno fmt   # 格式化
deno lint  # 代码检查
```

### 10.3 Next.js 前端开发 (frontend-nextjs/)

**环境要求：**
- Node.js 18+（如使用 nvm: `nvm use v24.14.0`）

**开发模式：**
```bash
cd frontend-nextjs
cp .env.example .env.local  # 首次需要配置环境变量
npm install
npm run dev                  # 启动开发服务器 (http://0.0.0.0:3000)
```

**生产构建与启动：**
```bash
npm run build
HOSTNAME=0.0.0.0 PORT=3000 node .next/standalone/server.js
```

**环境变量（.env.local）：**
```
# 跳过设备注册（开发用）
NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION=True

# Supabase
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
JWT_SECRET_KEY=<jwt-secret>

# OpenAI（Web 端 WebRTC 直连用）
OPENAI_API_KEY=...

# API Key 加密
ENCRYPTION_KEY=...

# Stripe 支付（可选）
STRIPE_SECRET_KEY=...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=...

# Google OAuth（可选）
GOOGLE_OAUTH=True
```

**输出模式：**
- `next.config.js` 配置 `output: "standalone"`，生产部署使用 `.next/standalone/server.js`

### 10.4 Supabase 本地开发

**启动本地 Supabase：**
```bash
cd supabase
npx supabase start   # 启动本地 Supabase（Docker）
npx supabase stop    # 停止
```

**数据库迁移：**
```bash
npx supabase db reset   # 重置数据库并应用所有迁移 + seed.sql
```

**更新 TypeScript 类型：**
```bash
cd frontend-nextjs
npm run update-types    # 从 Supabase 生成 TypeScript 类型定义
```

## 11. 关键设计决策

1. **BOOT 按钮需手动设置上拉** — ESP32_Button 库 `pullup=false` 会设置下拉，需在构造后调用 `gpio_set_pull_mode(GPIO_PULLUP_ONLY)`
2. **音量按钮必须在 `displayInit()` 之后初始化** — U8G2 软件 I2C 会覆盖 GPIO 39/40 配置
2. **音量按钮使用 GPIO 轮询** — ESP32_Button 库构造函数的 pullup 与 active_level 绑定，无法单独设置
3. **Ultravox 按需通话模式** — WebSocket 持久连接，通话按 START/STOP_SESSION 创建/销毁
4. **音频 16→32bit 转换** — I2S TX 使用 32-bit 帧宽，数据在高 16 位
5. **wsMutex 互斥锁** — networkTask 和 micTask 之间共享 WebSocket，防止数据竞争
6. **无 PSRAM 要求** — audioBuffer 仅 10KB，运行在 ESP32-S3 内部 RAM
7. **Opus 编解码** — 设备端解码（24kHz），服务器端编码（24kHz, 20ms frame, 24kbps）
