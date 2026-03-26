# server-deno 代码架构文档

## 目录结构

```
server-deno/
├── main.ts              # 入口：HTTP 服务器、WebSocket 升级、认证、AI 提供商路由
├── supabase.ts          # 数据库操作、系统提示词构建、对话历史管理
├── utils.ts             # JWT 验证、Opus 编码器、音频处理工具函数
├── types.d.ts           # 全局 TypeScript 类型定义
├── deno.json            # Deno 配置（依赖、格式化、lint 规则）
├── .env.example         # 环境变量模板
├── Dockerfile           # 生产部署 Docker 镜像
├── models/              # AI 提供商适配器
│   ├── openai.ts        # OpenAI Realtime API
│   ├── gemini.ts        # Google Gemini Live
│   ├── grok.ts          # xAI Grok Realtime
│   ├── elevenlabs.ts    # ElevenLabs Conversational AI
│   ├── hume.ts          # Hume EVI (情感语音)
│   ├── ultravox.ts      # Ultravox (按需通话模式)
│   └── echo.ts          # Echo 测试 (回放麦克风录音)
└── realtime/            # OpenAI Realtime 客户端库 (JS)
    ├── api.js
    ├── client.js
    ├── conversation.js
    ├── event_handler.js
    └── utils.js
```

## 核心模块

### main.ts — 入口与路由

**职责：** HTTP 服务器、WebSocket 握手、认证、AI 提供商分发

**流程：**
```
HTTP upgrade 请求
  → 提取 Authorization header (Bearer JWT)
  → authenticateUser() 验证 JWT，获取用户信息
  → 校验设备 MAC 地址 (非 DEV 模式)
  → handleUpgrade() → 触发 "connection" 事件

connection 事件：
  → getChatHistory() 加载最近 20 条对话
  → createFirstMessage() 构建首条消息提示
  → createSystemPrompt() 构建系统提示词
  → ws.send(auth 消息) → 发送 volume/ota/reset/pitch 配置
  → switch(provider) → 路由到对应 AI 适配器
```

**关键对象：**
- `server` — Node.js HTTP 服务器
- `wss` — WebSocketServer (noServer 模式，关闭 perMessageDeflate)
- `ProviderArgs` — 传递给各适配器的标准参数包

### supabase.ts — 数据库与提示词

**职责：** Supabase 客户端管理、用户/对话查询、系统提示词模板

**导出函数：**

| 函数 | 说明 |
|---|---|
| `getSupabaseClient(jwt)` | 创建带用户 JWT 的 Supabase 客户端 |
| `getUserByEmail(supabase, email)` | 查询用户（关联 personality、device、language） |
| `getChatHistory(supabase, userId, key, isDoctor)` | 获取对话历史（最近 20 条，医生模式限 2 小时内） |
| `createSystemPrompt(chatHistory, payload)` | 构建系统提示词（普通模式 / 故事模式） |
| `createFirstMessage(payload)` | 构建首条消息（personality.first_message_prompt 或默认 "Say hello"） |
| `addConversation(supabase, role, content, user)` | 保存对话记录到 conversations 表 |
| `getOpenAiApiKey(supabase, userId)` | 解密获取用户存储的 OpenAI API Key |

**提示词模板：**
- `getCommonPromptTemplate` — 通用模板：voice_prompt + character_prompt + 语言 + 时间 + 聊天历史
- `UserPromptTemplate` — 用户模式：supervisee 信息 + 物理玩具交互说明
- `getStoryPromptTemplate` — 故事模式：交互式故事讲述，包含选择点和分支

### utils.ts — 工具函数

**职责：** JWT 认证、Opus 编码、音频处理

**导出：**

| 导出 | 说明 |
|---|---|
| `authenticateUser(supabase, token)` | jose 库验证 JWT → 解出 email → 查询用户 |
| `createOpusEncoder()` | 创建 Opus 编码器 (24kHz, mono, voip, 24kbps, 20ms) |
| `createOpusPacketizer(sendPacket)` | 流式 Opus 编码器：push(pcm) → 积累 960 字节 → encode → sendPacket |
| `encoder` / `FRAME_SIZE` | 全局编码器实例和帧大小常量 (960 bytes) |
| `decryptSecret(encrypted, iv, masterKey)` | AES-256-CBC 解密用户 API Key |
| `boostLimitPCM16LEInPlace(pcm, gainDb, ceiling)` | PCM 音频增益 + 软限幅（Hume 用） |
| `downsamplePcm(buffer, fromRate, toRate)` | PCM 下采样（如 48kHz → 24kHz） |
| `extractPcmFromWav(wavBuffer)` | 从 WAV 文件提取 PCM 数据（Hume 用） |
| `isDev` | 开发模式标志 (DEV_MODE=True) |
| API Key 变量 | `openaiApiKey`, `geminiApiKey`, `elevenLabsApiKey`, `humeApiKey`, `xaiApiKey`, `ultravoxApiKey` |

### types.d.ts — 类型定义

**全局类型：**

| 类型 | 说明 |
|---|---|
| `IUser` | 用户（含 personality、device、language 关联） |
| `IPersonality` | 角色配置（provider、voice、prompt 等） |
| `IDevice` | 设备信息（volume、ota、reset、mac） |
| `IConversation` | 对话记录 |
| `IPayload` | WebSocket 连接载荷（user + supabase + timestamp） |
| `ProviderArgs` | AI 适配器标准参数（ws、payload、firstMessage、systemPrompt 等） |
| `ModelProvider` | AI 提供商枚举 |
| `OaiVoice` / `GeminiVoice` / `GrokVoice` | 各提供商语音类型 |
| `Hume*` 系列 | Hume EVI WebSocket 消息类型 |

## AI 提供商适配器 (models/)

所有适配器实现相同接口：`(args: ProviderArgs) => Promise<void>`

### 通用音频流程

```
ESP32 发送二进制 PCM (16kHz, 16-bit, mono)
  → 适配器转发给 AI 提供商 (格式因提供商而异)
  → AI 回复音频
  → 转换为 PCM 24kHz
  → createOpusPacketizer → Opus 编码
  → ws.send(opusPacket) 二进制发给 ESP32
```

### 通用消息协议

适配器通过 `ws.send(JSON.stringify({...}))` 发送控制消息：

| 消息 | 触发时机 |
|---|---|
| `{type:"server", msg:"RESPONSE.CREATED", volume_control:N}` | AI 开始生成音频回复 |
| `{type:"server", msg:"RESPONSE.COMPLETE"}` | AI 音频回复结束 |
| `{type:"server", msg:"RESPONSE.ERROR"}` | AI 回复出错 |
| `{type:"server", msg:"AUDIO.COMMITTED"}` | 用户语音被 AI 接收/处理 |
| `{type:"server", msg:"TRANSCRIPT.USER", text:"..."}` | 用户语音转文本（最终结果） |
| `{type:"server", msg:"TRANSCRIPT.ASSISTANT", text:"..."}` | AI 回复文本（最终结果） |

### openai.ts — OpenAI Realtime

- **连接方式：** OpenAI Realtime Client (本地 `realtime/client.js`)
- **模型：** `gpt-realtime-1.5`
- **输入：** ESP32 PCM → base64 → `input_audio_buffer.append`
- **输出：** PCM delta → Opus 编码
- **特点：** Server VAD (threshold=0.4, silence=1000ms)、tool calling (`end_session`)
- **语音转文本：** Whisper-1

### gemini.ts — Google Gemini Live

- **连接方式：** `@google/genai` SDK → `live.connect()`
- **模型：** `gemini-2.5-flash-native-audio-preview-09-2025`
- **输入：** ESP32 PCM → base64 → `sendRealtimeInput({audio})`
- **输出：** base64 PCM → Opus 编码
- **特点：** 自动 VAD (END_SENSITIVITY_LOW)、ResponseModalities: AUDIO

### grok.ts — xAI Grok Realtime

- **连接方式：** 原生 WebSocket → `wss://api.x.ai/v1/realtime`
- **输入：** ESP32 PCM → base64 → `input_audio_buffer.append`
- **输出：** PCM → Opus 编码
- **特点：** 协议与 OpenAI Realtime 类似、Server VAD

### elevenlabs.ts — ElevenLabs ConvAI

- **连接方式：** 先获取 signed URL，再用 `@elevenlabs/client` SDK
- **输入：** ESP32 PCM → 重采样匹配服务器配置 → SDK
- **输出：** PCM → 重采样到 24kHz → Opus 编码
- **特点：** 自动适配输入/输出采样率（线性插值重采样）

### hume.ts — Hume EVI

- **连接方式：** 原生 WebSocket → `wss://api.hume.ai/v0/evi/chat`
- **输入：** ESP32 PCM (通过 session_settings 配置 24kHz linear16)
- **输出：** WAV (48kHz) → 提取 PCM → 下采样 24kHz → 6dB 增益/限幅 → Opus
- **特点：** 情感分析 (prosody scores)

### ultravox.ts — Ultravox

- **连接方式：** REST 创建通话 → WebSocket 连接 joinUrl
- **输入：** ESP32 PCM → 直接转发 (16kHz)
- **输出：** PCM (24kHz) → Opus 编码
- **特点：** **按需通话模式** — ESP32 WS 持久连接，Ultravox 通话按 START_SESSION/STOP_SESSION 创建/销毁
- **语音配置：** 从 `personality.oai_voice` 读取，默认 "Mark"

### echo.ts — Echo 测试

- **用途：** 开发调试，录制 3 秒麦克风音频后回放
- **流程：** 录音 → 16kHz→24kHz 上采样 → Opus 编码 → 回传 → 循环

## 数据流图

### ESP32 → AI 提供商（上行）

```
ESP32 mic (I2S 16kHz 32-bit)
  → 转 16-bit PCM
  → WebSocket binary 发送
  → main.ts wss connection
  → 转发给当前 AI 适配器
  → 适配器转换格式 (base64/raw) 发给 AI API
```

### AI 提供商 → ESP32（下行）

```
AI API 返回音频
  → 适配器接收 (base64 PCM / raw PCM / WAV)
  → 转换为 24kHz 16-bit PCM
  → createOpusPacketizer.push(pcm)
  → 积累 960 字节 → Opus encode
  → ws.send(opusPacket) binary
  → ESP32 Opus decode → I2S 播放
```

## 环境变量

| 变量 | 必须 | 说明 |
|---|---|---|
| `SUPABASE_URL` | 是 | Supabase 项目 URL |
| `SUPABASE_KEY` | 是 | Supabase anon key |
| `JWT_SECRET_KEY` | 是 | JWT 签名密钥 |
| `ENCRYPTION_KEY` | 否 | AES-256-CBC 主密钥 (用于用户 API Key 解密) |
| `OPENAI_API_KEY` | 否 | OpenAI API Key |
| `GEMINI_API_KEY` | 否 | Google Gemini API Key |
| `XAI_API_KEY` | 否 | xAI Grok API Key |
| `ELEVENLABS_API_KEY` | 否 | ElevenLabs API Key |
| `HUME_API_KEY` | 否 | Hume AI API Key |
| `ULTRAVOX_API_KEY` | 否 | Ultravox API Key |
| `HOST` | 否 | 监听地址 (默认 0.0.0.0) |
| `PORT` | 否 | 监听端口 (DEV: 8000, PROD: 8080) |
| `DEV_MODE` | 否 | 开发模式 ("True" 启用) |

## 启动命令

```bash
# 开发模式（必须带 --env-file）
deno run -A --env-file=.env main.ts

# 代码格式化
deno fmt

# 代码检查
deno lint
```
