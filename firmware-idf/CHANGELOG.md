# Changelog

## [1.0.0] - 2026-03-26

### 新增功能

#### ESP-IDF 固件迁移
- 从 PlatformIO/Arduino 迁移到 ESP-IDF 5.5.2 框架
- 基于小智项目 `bread-compact-wifi` 板卡配置（GPIO 完全兼容）

#### 语音唤醒
- 集成 ESP-SR WakeNet9 唤醒词引擎
- 默认唤醒词："你好小智"
- 支持在 AI 说话时用唤醒词打断

#### ElatoProtocol 协议层
- 实现与 ElatoAI Deno 服务器的 WebSocket 通信
- 消息格式转换（server → Application 期望的 tts/stt 格式）
- 支持 START_SESSION / STOP_SESSION 指令
- Opus 音频编解码（16kHz 输入 / 24kHz 输出，20ms 帧）

#### RGB LED 状态显示
- GPIO 8 (绿) / GPIO 9 (红) / GPIO 13 (蓝)
- IDLE: 绿色常亮
- LISTENING: 黄色常亮（绿+红）
- SPEAKING: 蓝色常亮
- CONNECTING: 蓝色闪烁
- WIFI_CONFIG: 洋红脉冲

#### 自动超时
- LISTENING 状态 10 秒无语音自动回到 IDLE
- 收到用户语音（stt）时重置定时器
- 显示"等待响应超时"提示

#### 深度睡眠
- 长按 BOOT 按钮（2秒）进入深度睡眠
- 双击 BOOT 按钮进入深度睡眠
- 按下 BOOT 按钮唤醒

### 服务器端变更 (server-deno)

#### ultravox.ts
- 添加 `waitingForNewTurn` 标志，防止 AI 说完后立即发送 RESPONSE.CREATED
- STOP_SESSION 处理后发送 RESPONSE.COMPLETE 通知设备状态同步

### 按钮交互

| 操作 | 启动中 | 正常运行 |
|------|--------|----------|
| 单击 BOOT | 进入 WiFi 配置 | 切换对话状态 |
| 长按 BOOT | 深度睡眠 | 深度睡眠（需空闲） |
| 双击 BOOT | 深度睡眠 | 深度睡眠（需空闲） |
| 音量+ | - | 音量 +10 |
| 长按音量+ | - | 音量 100 |
| 音量- | - | 音量 -10 |
| 长按音量- | - | 静音 |

### 配置要求

- ESP-IDF 5.5.2+
- 板卡：`bread-compact-wifi`
- OLED：SSD1306 128x32
- 唤醒词：WakeNet9 你好小智

### 已知限制

- 唤醒词不可自定义，需从 ESP-SR 官方列表选择
- WiFi 配置仅在启动时单击 BOOT 触发
