# 针脚配置对比：小智 (xiaozhi) vs ElatoAI

板卡：bread-compact-wifi (ESP32-S3)

## 核心音频针脚

| 功能 | GPIO | 小智 | ElatoAI | 一致 |
|------|------|------|---------|------|
| 麦克风 WS | 4 | `AUDIO_I2S_MIC_GPIO_WS` | `I2S_WS` | ✅ |
| 麦克风 SCK | 5 | `AUDIO_I2S_MIC_GPIO_SCK` | `I2S_SCK` | ✅ |
| 麦克风 DIN | 6 | `AUDIO_I2S_MIC_GPIO_DIN` | `I2S_SD` | ✅ |
| 扬声器 DOUT | 7 | `AUDIO_I2S_SPK_GPIO_DOUT` | `I2S_DATA_OUT` | ✅ |
| 扬声器 BCLK | 15 | `AUDIO_I2S_SPK_GPIO_BCLK` | `I2S_BCK_OUT` | ✅ |
| 扬声器 LRCK | 16 | `AUDIO_I2S_SPK_GPIO_LRCK` | `I2S_WS_OUT` | ✅ |

## I2S 端口 & 采样率

| 参数 | 小智 | ElatoAI | 一致 |
|------|------|---------|------|
| 扬声器 I2S 端口 | I2S_NUM_0 | I2S_NUM_0 | ✅ |
| 麦克风 I2S 端口 | I2S_NUM_1 | I2S_NUM_1 | ✅ |
| 输入采样率 | 16000 Hz | 16000 Hz | ✅ |
| 输出采样率 | 24000 Hz | 24000 Hz | ✅ |
| I2S 模式 | Simplex | Simplex | ✅ |

## 外设针脚

| 功能 | GPIO | 小智 | ElatoAI | 一致 |
|------|------|------|---------|------|
| 音量+ 按钮 | 40 | `VOLUME_UP_BUTTON_GPIO` | `VOLUME_UP_PIN` | ✅ |
| 音量- 按钮 | 39 | `VOLUME_DOWN_BUTTON_GPIO` | `VOLUME_DOWN_PIN` | ✅ |
| 显示屏 SDA | 41 | `DISPLAY_SDA_PIN` | `DISPLAY_SDA` | ✅ |
| 显示屏 SCL | 42 | `DISPLAY_SCL_PIN` | `DISPLAY_SCL` | ✅ |
| 触摸按钮 | 47 | `TOUCH_BUTTON_GPIO` | `TOUCH_PAD_NUM2` | ✅ |

## 差异项

| 功能 | GPIO | 小智 | ElatoAI | 说明 |
|------|------|------|---------|------|
| BOOT 按钮 | 0 | `BOOT_BUTTON_GPIO` | 未定义 | 小智用于切换对话，ElatoAI 未使用 |
| 睡眠按钮 | 2 | 未定义 | `BUTTON_PIN` | ElatoAI 独有，RTC IO 用于深度睡眠唤醒 |
| 蓝色 LED | 13 | 无 | `BLUE_LED_PIN` | ElatoAI 外接 RGB LED |
| 红色 LED | 9 | 无 | `RED_LED_PIN` | ElatoAI 外接 RGB LED |
| 绿色 LED | 8 | 无 | `GREEN_LED_PIN` | ElatoAI 外接 RGB LED |
| 内置 LED | 48 | `BUILTIN_LED_GPIO` | 未使用 | 板载 LED，小智定义但未重度使用 |
| 扬声器 SD/EN | 10 | 未定义 | `I2S_SD_OUT`（已注释） | 板卡无 PA 使能引脚，GPIO 10 实际空闲 |
| MCP 灯 | 18 | `LAMP_GPIO` | 无 | 小智 MCP 测试用途 |

## 结论

所有核心音频（麦克风 3pin + 扬声器 3pin）、音量按钮、显示屏 I2C、触摸、I2S 端口分配和采样率 **完全一致**。差异仅在 LED、按钮等非核心外设上。
