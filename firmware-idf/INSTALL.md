# ElatoAI ESP-IDF 固件安装指南

## 前提条件

- macOS / Linux / Windows
- Python 3.8+
- Git
- 稳定的网络连接

## 步骤 1: 安装 ESP-IDF 5.5.2

```bash
# 创建目录
mkdir -p ~/esp && cd ~/esp

# 克隆 ESP-IDF (如果网络不稳定，可尝试使用代理或镜像)
git clone -b v5.5.2 --depth 1 --recursive https://github.com/espressif/esp-idf.git

# 或者分步克隆（网络不稳定时推荐）
git clone -b v5.5.2 --depth 1 https://github.com/espressif/esp-idf.git
cd esp-idf
git submodule update --init --recursive --depth 1

# 安装工具链（仅需 ESP32-S3）
./install.sh esp32s3

# 设置环境变量（每次打开新终端需要执行）
source export.sh
```

### 国内镜像加速（可选）

如果在中国大陆，可使用乐鑫镜像：
```bash
export IDF_GITHUB_ASSETS="dl.espressif.cn/github_assets"
export PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
```

## 步骤 2: 配置项目

```bash
cd /Users/hb/workspace/ElatoAI/firmware-idf

# 设置目标芯片
idf.py set-target esp32s3

# 打开配置菜单
idf.py menuconfig
```

在 menuconfig 中设置：
1. `Xiaozhi Assistant` → `Board Type` → **Bread Compact WiFi**
2. `Xiaozhi Assistant` → `OLED Type` → **SSD1306 128*32**

## 步骤 3: 编译

```bash
idf.py build
```

编译成功后会在 `build/` 目录生成固件文件。

## 步骤 4: 烧录

```bash
# 烧录并监控串口输出
idf.py flash monitor

# 仅烧录
idf.py flash

# 仅监控
idf.py monitor
```

按 `Ctrl+]` 退出串口监控。

## 步骤 5: 配网

1. 设备启动后会创建热点 **ELATO-DEVICE-XXXX**
2. 手机连接该热点
3. 打开浏览器访问 http://192.168.4.1
4. 输入 WiFi 名称和密码
5. 设备重启后自动连接 WiFi 并获取 ElatoAI token

## 测试唤醒词

配网成功后，说 **"你好小智"** 即可触发对话。

## LED 状态指示

| 状态 | 颜色 |
|------|------|
| 空闲 | 绿色常亮（暗） |
| 监听中 | 黄色常亮 |
| 说话中 | 蓝色常亮 |
| 连接中 | 蓝色闪烁 |
| WiFi 配网 | 洋红脉冲 |

## 故障排除

### 编译错误
```bash
# 清理并重新编译
idf.py fullclean
idf.py build
```

### 烧录失败
- 确保串口设备路径正确（通常是 /dev/cu.usbserial-* 或 /dev/ttyUSB0）
- 按住 BOOT 键再按 RESET 键进入下载模式

### 唤醒词不响应
- 确保 PSRAM 已启用（sdkconfig 中 CONFIG_SPIRAM=y）
- 检查麦克风 I2S 接线是否正确

## 文件结构

```
firmware-idf/
├── main/
│   ├── protocols/
│   │   ├── elato_protocol.h/cc   # ElatoAI 协议实现
│   │   └── ...
│   ├── led/
│   │   ├── elato_rgb_led.h/cc    # RGB LED 驱动
│   │   └── ...
│   ├── boards/
│   │   ├── bread-compact-wifi/   # 板卡配置
│   │   └── common/               # 公共代码
│   └── audio/
│       └── audio_service.h       # 音频配置 (20ms Opus帧)
├── sdkconfig.defaults.esp32s3    # ESP32-S3 默认配置
└── build_elato.sh                # 编译辅助脚本
```
