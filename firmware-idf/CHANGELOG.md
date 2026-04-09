# Changelog

## [1.0.6] - 2026-04-09

### 新增功能

#### 口型控制 (MouthControl)
- 新增 `mouth_control.cc/h` 模块
- AI 说话时 GPIO 17 输出高电平，停止时输出低电平
- 用于外接玩具动嘴动画控制
- 通过设备状态机监听器自动触发

#### 代码文档
- 重写 `README.md`，完整的代码架构文档
- 包含目录结构、模块详解、GPIO 分配、状态机说明等

### 文件变更
- `main/mouth_control.cc` - 口型控制实现
- `main/mouth_control.h` - 口型控制头文件
- `main/boards/bread-compact-wifi/config.h` - 添加 `MOUTH_GPIO` 定义
- `main/boards/bread-compact-wifi/compact_wifi_board.cc` - 初始化 MouthControl
- `main/application.h` - 添加 `GetStateMachine()` 方法
- `main/CMakeLists.txt` - 添加 mouth_control.cc 源文件
- `README.md` - 完整代码架构文档

---

## [1.0.5] - 2026-04-03

### 公网域名配置

#### 固件端 (firmware-idf)
- 新增 Kconfig 配置项 `CONFIG_ELATO_BACKEND_URL` 和 `CONFIG_ELATO_WS_URL`
- 所有 URL 从 Kconfig 读取，代码中不再硬编码
- 默认值：`https://console.novarian.ai` 和 `wss://voice.novarian.ai`
- 支持通过 `idf.py menuconfig` 或直接修改 sdkconfig 切换环境

#### 前端 (frontend-nextjs)
- `api/ota/route.ts`: WebSocket URL 默认值改为 `wss://voice.novarian.ai`

#### 域名配置
- WebSocket (Deno): `wss://voice.novarian.ai`
- Next.js 前端: `https://console.novarian.ai`
- SSL 证书: Let's Encrypt (certbot)

---

## [1.0.1] - 2026-03-26

### 公网部署修复

#### 固件端 (firmware-idf)
- 后端 URL 默认配置改为公网地址 `http://35.162.7.133`
- WebSocket URL 默认配置改为 `ws://35.162.7.133/ws`
- WiFi 配网成功页面注册链接指向公网后端

#### 前端 (frontend-nextjs)
- 修复 MAC 地址大小写不一致导致设备绑定失败的问题
- `db/devices.ts`: 所有 MAC 地址操作统一转大写
- `api/generate_auth_token/route.ts`: 查询时 MAC 地址转大写
- `addUserToDeviceByMac()` 支持设备不存在时自动创建

### 已知问题
- 服务器 `DEV_MODE` 环境变量需要使用大写 `True`（非 `true`）

---

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
