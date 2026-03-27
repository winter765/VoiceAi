# ElatoAI 语音唤醒功能实现计划

## 目标
为 ElatoAI 实现本地语音唤醒功能，使用 ESP-SR WakeNet9（与小智项目一致）。

## 背景

### 当前状态
- ElatoAI 使用 PlatformIO + Arduino 框架
- ESP-SR 是 ESP-IDF 组件，与 Arduino 不兼容
- 需要将固件迁移到 ESP-IDF 框架

### 硬件信息
- ESP32-S3，16MB Flash，8MB PSRAM（已启用）
- GPIO 配置与小智 `bread-compact-wifi` 板卡完全匹配

---

## 迁移策略：基于小智框架嫁接（推荐）

以小智 `bread-compact-wifi` 板卡代码为框架，替换协议层对接 ElatoAI 后端。

**预计工作量：1-2 周**

---

## 实施阶段

### Phase 1：环境搭建（0.5 天）

| 任务 | 说明 |
|------|------|
| 1.1 | 复制小智项目作为基础框架 |
| 1.2 | 配置 `bread-compact-wifi` 板卡（GPIO 匹配 ElatoAI 硬件） |
| 1.3 | 验证编译、烧录、唤醒词功能正常 |

### Phase 2：协议层替换（2-3 天）

ElatoAI 与小智的后端协议不同，需要替换：

| 小智组件 | 替换为 ElatoAI 逻辑 |
|----------|---------------------|
| `mqtt_protocol.cc` | 新建 `elato_websocket_protocol.cc` |
| 消息格式（小智 JSON） | ElatoAI WebSocket 消息格式 |
| 音频编码参数 | 16kHz/16kbps/DTX（与当前 ElatoAI 一致） |

**关键文件创建：**
```
main/protocols/elato_websocket_protocol.h
main/protocols/elato_websocket_protocol.cc
```

### Phase 3：后端对接（1-2 天）

| 任务 | 说明 |
|------|------|
| 3.1 | 实现 ElatoAI 认证流程（MAC + Token） |
| 3.2 | 对接 Deno WebSocket 服务器 |
| 3.3 | 对接 Next.js 后端（注册、OTA） |

### Phase 4：唤醒词集成（1 天）

小智已有完整实现，只需配置：

| 配置项 | 值 |
|--------|-----|
| `CONFIG_USE_AFE_WAKE_WORD` | y（启用 WakeNet9） |
| 唤醒词 | 使用默认或自定义 |
| `CONFIG_SEND_WAKE_WORD_DATA` | y（发送唤醒前 2 秒音频） |

### Phase 5：UI 适配（0.5 天）

| 任务 | 说明 |
|------|------|
| 5.1 | 调整 OLED 显示内容（状态文字） |
| 5.2 | LED 颜色映射（小智→ElatoAI 状态） |

---

## 依赖库映射表

| ElatoAI (Arduino) | 小智 (ESP-IDF) | 迁移难度 |
|-------------------|----------------|----------|
| ArduinoJson | cJSON（内置） | 低 |
| WebSockets | 自研 WebsocketProtocol | 中（需重写） |
| ESPAsyncWebServer | esp-wifi-connect | 低（直接复用） |
| ESP32_Button | espressif/button | 低 |
| arduino-audio-tools | esp_codec_dev + i2s_std | 低 |
| arduino-libopus | esp_audio_codec | 极低 |
| U8g2 | esp_lcd + LVGL | 中 |
| Preferences | nvs_flash + Settings | 低 |

---

## GPIO 映射

| 功能 | ElatoAI GPIO | 小智 bread-compact-wifi | 状态 |
|------|--------------|-------------------------|------|
| I2S_MIC_SCK | 5 | 5 | ✅ 匹配 |
| I2S_MIC_WS | 4 | 4 | ✅ 匹配 |
| I2S_MIC_SD | 6 | 6 | ✅ 匹配 |
| I2S_SPK_BCK | 15 | 15 | ✅ 匹配 |
| I2S_SPK_WS | 16 | 16 | ✅ 匹配 |
| I2S_SPK_DATA | 7 | 7 | ✅ 匹配 |
| BOOT 按钮 | 0 | 0 | ✅ 匹配 |
| 音量+ | 40 | 40 | ✅ 匹配 |
| 音量- | 39 | 39 | ✅ 匹配 |
| OLED SDA | 41 | 41 | ✅ 匹配 |
| OLED SCL | 42 | 42 | ✅ 匹配 |
| LED (RGB) | 8/9/13 | 需配置 | ⚠️ 待调整 |

---

## 分区表

```csv
# Name,   Type, SubType, Offset,   Size
nvs,      data, nvs,     0x9000,   0x6000
otadata,  data, ota,     0xf000,   0x2000
app0,     app,  ota_0,   0x10000,  0x200000   # 2MB
app1,     app,  ota_1,   0x210000, 0x200000   # 2MB
model,    data, spiffs,  0x410000, 0x3F0000   # 4MB（唤醒词模型）
spiffs,   data, spiffs,  0x800000, 0x100000   # 1MB
```

---

## ElatoAI WebSocket 消息格式参考

### 客户端 → 服务器

```json
// 开始会话
{"type": "START_SESSION"}

// 停止会话
{"type": "STOP_SESSION"}
```

### 服务器 → 客户端

```json
// 音频已提交
{"type": "AUDIO.COMMITTED"}

// 响应开始
{"type": "RESPONSE.CREATED"}

// 响应完成
{"type": "RESPONSE.COMPLETE"}

// 会话结束
{"type": "SESSION.END"}
```

### 二进制帧
- 客户端发送：Opus 编码音频（16kHz, 16kbps, 20ms 帧）
- 服务器发送：Opus 编码音频（24kHz）

---

## 风险与注意事项

1. **协议差异**：ElatoAI 直连 Ultravox/Hume 等 AI 服务，小智走自有后端，需重写协议层
2. **音频参数**：确保 Opus 编码参数与 Deno 服务端一致
3. **认证流程**：ElatoAI 用 JWT + MAC，小智用设备绑定，需适配
4. **唤醒词模型**：需要 4MB Flash 空间存储 WakeNet9 模型

---

## 参考资源

- 小智项目：`/Users/hb/workspace/xiaozhi-esp32`
- 小智板卡配置：`bread-compact-wifi`
- ESP-SR 文档：https://github.com/espressif/esp-sr
- ElatoAI 当前固件：`/Users/hb/workspace/ElatoAI/firmware-arduino`

---

## 附录：Arduino → ESP-IDF API 映射

| Arduino API | ESP-IDF 替代 |
|-------------|--------------|
| `Serial.println()` | `ESP_LOGI(TAG, ...)` |
| `delay(ms)` | `vTaskDelay(pdMS_TO_TICKS(ms))` |
| `millis()` | `esp_timer_get_time() / 1000` |
| `digitalWrite()` | `gpio_set_level()` |
| `analogWrite()` | `ledc_set_duty()` |
| `WiFi.begin()` | `esp_wifi_connect()` |
| `Preferences` | `nvs_open/nvs_set_str/nvs_get_i32` |
| `HTTPClient` | `esp_http_client` |
| `ArduinoJson` | `cJSON` |

---

## 对话打断方案

### 方案对比

| 方案 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| **唤醒词打断** | 说话时保持唤醒词检测 | 已有实现，改动小 | 需要说唤醒词 |
| **VAD 打断** | 检测到人声就打断 | 自然，无需特定词 | 误触发高，环境噪音敏感 |
| **按钮打断** | 按键触发打断 | 精确，无误触发 | 需要物理操作 |
| **服务端 VAD** | 服务端检测用户说话并通知打断 | 利用服务端算力 | 依赖网络延迟 |
| **本地 AEC + VAD** | 用 AEC 消除回声后做 VAD | 准确度高 | 计算量大，需要 AFE |

### 本地 AEC + VAD 打断方案（详细）

#### 原理

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   麦克风    │────▶│     AEC     │────▶│     VAD     │
│  (含回声)   │     │  (消除回声)  │     │ (检测人声)  │
└─────────────┘     └─────────────┘     └─────────────┘
                           ▲
                           │ 参考信号
                    ┌──────┴──────┐
                    │   扬声器    │
                    │  (AI语音)   │
                    └─────────────┘
```

#### ESP-SR AFE 现有能力

| 组件 | 功能 | 现有代码位置 |
|------|------|-------------|
| AEC | 回声消除 | `afe_audio_processor.cc` |
| BSS | 盲源分离（降噪） | AFE 内置 |
| NS | 噪声抑制 | AFE 内置 |
| VAD | 语音活动检测 | `audio_service.cc` 已有回调 |
| WakeNet | 唤醒词检测 | `afe_wake_word.cc` |

#### 实现方式

**方式 A：复用现有 AFE VAD**
1. 在 `kDeviceStateSpeaking` 时启用 AFE
2. 监听 AFE 的 VAD 事件
3. VAD 检测到人声时触发打断

**方式 B：独立 VAD 检测**
1. 在播放时同时运行 AFE 处理
2. 不依赖唤醒词，只看 VAD 输出
3. 设置能量/时长阈值避免误触发

#### 优缺点

**优点：**
- 自然交互，用户随时说话就能打断
- ESP-SR 已有 AEC/VAD 实现
- 本地处理，无网络延迟（<100ms）

**缺点：**
- 内存占用高（AFE 需要约 20-30KB 额外 RAM）
- AEC 需要参考信号，当前架构可能需要改造
- 误触发风险（环境噪音）
- CPU 占用较高

#### 技术难点

1. **参考信号同步**：AEC 需要扬声器播放的原始 PCM 作为参考
2. **延迟对齐**：麦克风信号和参考信号需要时间对齐
3. **阈值调优**：VAD 灵敏度需要平衡误触发和漏检

---

## 特定词语结束对话方案

### 方案对比

| 方案 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| **本地命令词** | 用 MultiNet 识别"再见"等 | 本地处理，快速 | 占用内存大 |
| **服务端识别** | 服务端 STT 识别结束词 | 准确率高，灵活 | 依赖网络 |
| **唤醒词复用** | 用唤醒词作为结束信号 | 零成本 | 不够自然 |
| **静音超时** | 停止说话 N 秒后结束 | 简单，已有 | 被动 |

### 服务端识别方案（推荐）

#### 工作流程

```
用户说"再见" → 设备发送音频 → 服务端/AI 识别 → AI 说告别语
→ 服务端发送 SESSION.END → 设备切换到 idle
```

#### 实现层次

**1. AI System Prompt 配置**
```
会话控制规则：
- 当用户表达结束意图时（如"再见"、"拜拜"、"不聊了"等），
  先礼貌告别，然后在回复末尾添加 [END_SESSION] 标记
```

**2. 服务端处理（Deno）**
- 检测 AI 回复中的 `[END_SESSION]` 标记
- 等 AI 说完告别语后发送 `SESSION.END` 给设备

**3. 设备端处理**
- 已有实现：`elato_protocol.cc` 第 288-294 行处理 `SESSION.END`
- 收到后停止 TTS，切换到 idle 状态

#### 优缺点

| 优点 | 缺点 |
|------|------|
| 自然语言理解，支持各种变体 | 网络延迟 1-3 秒 |
| 上下文感知，避免误判 | 依赖 AI 服务 |
| 零设备资源占用 | 无法离线使用 |
| 可通过 prompt 灵活配置 | |

---

## 自定义唤醒词训练方案

### 方案对比

| 方案 | 数据需求 | 费用 | 周期 | 识别率 | 适用场景 |
|------|----------|------|------|--------|----------|
| **Espressif 官方定制** | 无需自行采集 | 数千美元起 | 2-4 周 | >95% | 商业产品 |
| **Edge Impulse** | 100-500 正样本 | 免费 | 1-2 周 | 85-90% | 原型验证 |
| **Picovoice Porcupine** | 无需采集 | $6/设备/年 | 几分钟 | 90%+ | 快速测试 |
| **OpenWakeWord** | 需要大量数据 | 免费 | 2-4 周 | 80-90% | 技术研究 |

### 方案一：Espressif 官方定制服务（推荐）

**流程：**
1. 联系乐鑫官方商务（sales@espressif.com）
2. 提供唤醒词文本（中文/英文）
3. 乐鑫使用内部数据和模型训练
4. 交付 WakeNet 模型文件（.bin）

**唤醒词要求：**
- 长度：3-5 个音节最佳
- 避免常见词汇（容易误触发）
- 发音清晰、易于区分

**优点：**
- 高识别率（>95%）
- 低误触发率
- 官方技术支持
- 无需自行采集数据

**缺点：**
- 费用较高（通常数千美元起）
- 周期 2-4 周
- 每个唤醒词单独收费

### 方案二：Edge Impulse 平台（开源替代）

**流程：**
1. 在 Edge Impulse 网站创建项目
2. 采集音频样本（正样本 + 负样本）
3. 使用 MFCC 特征提取
4. 训练神经网络（MobileNet/自定义 CNN）
5. 导出 TFLite 模型
6. 集成到 ESP32（需自行编写推理代码）

**数据要求：**

| 类型 | 数量 | 说明 |
|------|------|------|
| 正样本（唤醒词） | 100-500 条 | 多人、多口音、不同距离 |
| 负样本（非唤醒词） | 500-1000 条 | 日常对话、背景噪音 |
| 音频格式 | 16kHz, 16-bit, 单声道 | |

**优点：**
- 免费（个人/教育用途）
- 可视化训练流程
- 支持数据增强

**缺点：**
- 需要大量数据采集
- 识别率不如官方（85-90%）
- 需要自行集成推理代码

### 方案三：Picovoice Porcupine

**流程：**
1. 在 Picovoice Console 输入唤醒词
2. 平台自动生成模型
3. 下载 .ppn 模型文件
4. 使用 Porcupine SDK 集成

**优点：**
- 无需采集数据（平台合成）
- 模型生成快（几分钟）
- 有 ESP32 SDK

**缺点：**
- 需要商业授权（$6/设备/年）
- 开源版限制严格
- 与 ESP-SR 框架不兼容

### 方案四：OpenWakeWord（完全开源）

**流程：**
1. 准备训练数据（正/负样本）
2. 使用 OpenWakeWord 训练脚本
3. 导出 ONNX 模型
4. 转换为 TFLite
5. 自行在 ESP32 上部署

**优点：**
- 完全免费开源
- 社区支持
- 可使用合成音频增强数据

**缺点：**
- 学习曲线陡峭
- 模型优化需要经验
- ESP32 部署需要额外工作

### 推荐选择

| 场景 | 推荐方案 |
|------|----------|
| 商业产品、预算充足 | Espressif 官方定制 |
| 原型验证、学习研究 | Edge Impulse |
| 快速测试、少量设备 | Picovoice |
| 技术研究、完全自主 | OpenWakeWord |

**当前项目建议：**
- 短期：使用现有 WakeNet9 预训练唤醒词（如 "Alexa"）
- 中期：如需自定义，联系乐鑫官方获取报价
- 长期：如果量产，官方定制是最稳妥的选择

---

*创建日期：2026-03-26*
*更新日期：2026-03-27*
