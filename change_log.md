# Change Log

## 2026-03-20

### firmware-arduino
**注意：小智面包版的显示屏与扬声器麦克风是分开供电的，仅插入下方数据线ESP32板和显示器可以工作，扬声器和麦克风是不工作的，这俩需要接上电池或者插入上方电源线**

#### 恢复 audioStreamTask 正常音频播放
- 移除 440Hz 测试音无限循环和 I2S 寄存器/GPIO 调试输出
- 恢复从 `audioBuffer` 读取 Opus 解码后的 16-bit PCM 数据
- 实现 16-bit mono → 32-bit stereo 转换，匹配 xiaozhi bread-compact-wifi 硬件要求
- 应用二次方音量曲线（quadratic scaling），`currentVolume` 0-100 映射到感知音量
- 修复 `spkBuf32` 数组大小：从 240 改为 480（stereo 需要 2 倍空间）

#### 切换到 ESP-IDF legacy I2S 驱动
- 使用 `i2s_driver_install` / `i2s_set_pin` / `i2s_write` 替代 AudioTools I2SStream
- 配置：32-bit, 24kHz, stereo frame, DMA buf_count=6, buf_len=240（匹配 xiaozhi）
- I2S 端口分配：扬声器 I2S_NUM_0，麦克风 I2S_NUM_1

#### 移除调试代码
- 删除麦克风 10 秒延迟（之前为隔离测试扬声器加入）
- 删除 `digitalRead` 引脚采样诊断（I2S 外设控制的引脚无法通过 GPIO 输入寄存器读取）
- 删除 I2S 寄存器 dump 和 GPIO matrix 输出

#### 串口波特率调整
- `Serial.begin` 从 115200 改为 921600
- `platformio.ini` 的 `monitor_speed` 同步更新为 921600

### server-deno

#### 默认音量修改
- `main.ts` 中 auth 消息的 `volume_control` fallback 值从 50 改为 100

#### Echo 模式改为真实回放
- `models/echo.ts` 由播放 440Hz 测试音改为回放麦克风录音
- 流程：录音 3 秒 → 16kHz→24kHz 线性插值上采样 → Opus 编码回传 → 循环

### 验证结果

#### 全双工音频链路验证通过
- **扬声器问题根因**：功放芯片需要独立供电，外接电源后正常出声
- **麦克风验证**：Echo 回放测试确认麦克风正常工作，非零字节率稳定 88-93%
- **完整链路**：MIC → I2S(32bit) → 16bit 转换 → WebSocket → Deno Server → 上采样 → Opus 编码 → WebSocket → ESP32 Opus 解码 → 16bit→32bit + 音量 → I2S → SPK

#### 恢复 Ultravox 连接
- `main.ts` 中 ultravox 路由从临时 echo 测试恢复为 `connectToUltravox`
- Ultravox 语音对话全链路验证通过：语音识别、AI 回复、音频播放均正常

### 诊断结论

- `digitalRead()` 无法读取 I2S 外设控制的 GPIO 引脚状态，之前观察到的全零读数不代表引脚无信号
- 所有核心音频引脚（BCK=15, WS=16, DATA=7）与 xiaozhi bread-compact-wifi 完全一致
- devices 表为空，volume 值走 fallback 路径

---

## 2026-03-19

### 1. Init VoiceAi（f75d179）15:46

项目初始化提交，包含完整的三端代码：

**firmware-arduino**
- ESP32-S3 固件：I2S 音频输入/输出、WebSocket 通信、Opus 编解码
- WiFi 管理（SoftAP 配网 + 自动连接）、OTA 升级、工厂重置
- LED 状态指示、触摸/按键唤醒与休眠、音频变调（PitchShift）
- 测试用例：麦克风、扬声器、触摸、OTA、WiFi 等

**server-deno**
- Deno WebSocket 音频中继服务器
- 支持多 AI 提供商：OpenAI Realtime、Gemini Live、Grok、ElevenLabs ConvAI、Hume EVI
- Supabase 用户认证、聊天历史管理、系统提示词生成
- Opus 编解码工具函数

**frontend-nextjs**
- Next.js 15 Web 应用：登录/注册、角色管理、语音游乐场
- Supabase 数据库操作（用户、设备、角色、对话）
- WebRTC 实时语音、音频可视化、Stripe 支付集成
- 响应式 UI（Tailwind + shadcn/ui）

**supabase**
- 数据库 schema：users、devices、personalities、conversations、messages、languages 6 张表
- RLS 策略、种子数据（角色预设）

### 2. 本地链接 Ultravox 调整（07806f0）19:46

- 新增 Ultravox AI 提供商集成（`server-deno/models/ultravox.ts`，269 行）
- Ultravox 采用 WebSocket 中继模式：ESP32 ↔ Deno Server ↔ Ultravox API
- 更新 `server-deno/main.ts` 路由、`types.d.ts` 类型定义
- 更新 `Config.cpp` DEV_MODE 下的服务器 IP 地址
- 清理 `frontend-nextjs/package-lock.json` 冗余依赖

### 3. 添加显示屏相关支持（53144d9）21:42

**firmware-arduino**
- 新增 `DisplayHandler.cpp/h`：SSD1306 OLED 显示驱动（U8g2 软件 I2C）
- 支持显示状态图标（WiFi、聊天模式）和聊天消息（自动换行 + 滚动）
- 新增显示屏引脚定义：`DISPLAY_SDA=41`、`DISPLAY_SCL=42`
- `main.cpp` 添加 Display Task（Core 1, 优先级 2）
- `platformio.ini` 添加 U8g2 库依赖和 `DISPLAY_ENABLED` 编译标志

**server-deno**
- 所有 AI 提供商（OpenAI、Gemini、Grok、ElevenLabs、Hume、Ultravox）新增 `TRANSCRIPT.USER` 和 `TRANSCRIPT.ASSISTANT` 消息推送，用于在设备显示屏上显示对话文本

### 4. 添加音量控制（82b0404）23:52

**firmware-arduino**
- 新增音量按钮 GPIO 定义：`VOLUME_UP_PIN=40`、`VOLUME_DOWN_PIN=39`
- 实现 `volumeButtonTask`：GPIO 轮询（非中断），支持短按 ±10 和长按直达 0/100
- 音量持久化存储：NVS 读写（`audio/volume`）
- 服务端 auth 消息中的 `volume_control` 会覆盖本地音量
- `Audio.cpp` 新增 WebSocket `RESPONSE.COMPLETE` 消息中的动态音量更新
- 显示屏（若启用）实时显示当前音量百分比
