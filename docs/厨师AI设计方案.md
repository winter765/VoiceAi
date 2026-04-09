# Chef AI 厨师助手 - 技术设计方案

> 基于 ElatoAI 架构的厨房语音 AI 产品
>
> 版本：v1.0
> 日期：2026-04-08

---

## 一、产品概述

### 1.1 产品定位

| 项目 | 内容 |
|------|------|
| 产品名称 | Chef（AI 全能小厨） |
| 唤醒词 | "Hey, Chef" |
| 目标市场 | 美国家庭厨房 |
| 产品形态 | 13寸厨师造型摆件 |
| 核心价值 | 专业厨房助手，解放双手烹饪 |

### 1.2 核心功能

| 功能 | 描述 | 示例 |
|------|------|------|
| 交互式食谱导航 | 单步讲解，用户控制节奏 | "下一步" / "重复" |
| 烹饪百事通 | 即时烹饪指导 | "五成油温怎么判断？" |
| 多重计时器 | 同时管理多个计时 | "炖肉1小时，蒸蛋8分钟" |
| 食材替代建议 | 缺料时的替代方案 | "没有蚝油用什么代替？" |

### 1.3 人设定义

```
身份：美国 AI 全能小厨
专长：美式风味优先，兼顾全球美食
性格：专业、热情、有厨师特色的幽默感
限制：只聊烹饪，拒绝非厨房话题

预设拒绝回复示例：
- "这个问题超出了我的菜谱库范围，不如聊聊今天做什么好吃的？"
- "我的程序设定是'厨房模式'，关于其他问题我帮不上忙哦。"
```

---

## 二、硬件设计

### 2.1 硬件规格

| 组件 | 规格 | 备注 |
|------|------|------|
| 主控 | ESP32-S3 (8MB PSRAM) | 复用 ElatoAI |
| 屏幕 | GC9A01 240x240 圆形 LCD | 5-7cm，替换原 OLED |
| 麦克风 | INMP441 I2S 数字麦克风 | 前置 |
| 扬声器 | 3W 扬声器 | 后置 |
| 电池 | 3.7V 2000mAh 锂电池 | 支持 4-6 小时使用 |
| 充电 | TP4056 充电管理 | Type-C 充电口 |
| 外壳 | 树脂/搪胶 | 非易碎，厨房友好 |

### 2.2 GPIO 分配

| GPIO | 功能 | 备注 |
|------|------|------|
| 0 | BOOT 按钮 | 备用交互 |
| 4 | I2S_WS (麦克风) | |
| 5 | I2S_SCK (麦克风) | |
| 6 | I2S_SD (麦克风 DATA) | |
| 7 | I2S_DATA_OUT (扬声器) | |
| 10 | I2S_SD_OUT (扬声器 Enable) | |
| 15 | I2S_BCK_OUT (扬声器 BCLK) | |
| 16 | I2S_WS_OUT (扬声器 LRCK) | |
| 18 | LCD_SCK | GC9A01 SPI |
| 19 | LCD_MOSI | GC9A01 SPI |
| 20 | LCD_DC | GC9A01 控制 |
| 21 | LCD_CS | GC9A01 片选 |
| 22 | LCD_RST | GC9A01 复位 |
| 35 | BAT_ADC | 电池电量检测 |

### 2.3 屏幕显示设计

```
┌─────────────────────────────────────────────────────────────────┐
│                        屏幕状态切换                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [待机状态]              [对话状态]              [计时状态]      │
│  ┌──────────┐           ┌──────────┐           ┌──────────┐    │
│  │          │           │          │           │  ┌────┐  │    │
│  │   12:30  │           │ "红烧肉  │           │  │8:00│  │    │
│  │    PM    │           │  第2步"  │           │  └────┘  │    │
│  │          │           │          │           │   蒸蛋   │    │
│  └──────────┘           └──────────┘           └──────────┘    │
│   模拟/数字时钟            对话文字              倒计时+名称      │
│                                                                 │
│  [对话+计时混合]                                                 │
│  ┌──────────────────┐                                          │
│  │ "加入料酒..."    │  文字主体                                 │
│  │            ┌───┐ │                                          │
│  │            │5:0│ │  右下角小计时器                           │
│  │            └───┘ │                                          │
│  └──────────────────┘                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、系统架构

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Chef AI 系统架构                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐                      ┌─────────────────────────┐  │
│  │   ESP32-S3      │      WebSocket       │      Deno Server        │  │
│  │   (Chef 设备)   │◄────────────────────►│      (音频中继)          │  │
│  │                 │      Opus Audio      │                         │  │
│  │  ┌───────────┐  │                      │  ┌───────────────────┐  │  │
│  │  │ 唤醒词检测 │  │                      │  │ 会话管理          │  │  │
│  │  │ (ESP-SR)  │  │                      │  │ - 对话历史        │  │  │
│  │  └───────────┘  │                      │  │ - 食谱会话状态     │  │  │
│  │  ┌───────────┐  │                      │  │ - 计时器同步      │  │  │
│  │  │ 本地计时器 │  │                      │  └───────────────────┘  │  │
│  │  │ (离线运行) │  │                      │            │            │  │
│  │  └───────────┘  │                      │            ▼            │  │
│  │  ┌───────────┐  │                      │  ┌───────────────────┐  │  │
│  │  │ 圆屏 UI   │  │                      │  │    Ultravox AI    │  │  │
│  │  │ (LVGL)    │  │                      │  │  (语音对话引擎)    │  │  │
│  │  └───────────┘  │                      │  └───────────────────┘  │  │
│  │  ┌───────────┐  │                      │            │            │  │
│  │  │ 音频缓存  │  │                      │            ▼            │  │
│  │  │ (提醒语音) │  │                      │  ┌───────────────────┐  │  │
│  │  └───────────┘  │                      │  │   ElevenLabs TTS  │  │  │
│  └─────────────────┘                      │  │  (提醒音频生成)    │  │  │
│                                           │  └───────────────────┘  │  │
│                                           └─────────────────────────┘  │
│                                                       │                │
│                                                       ▼                │
│                                           ┌─────────────────────────┐  │
│                                           │       Supabase          │  │
│                                           │  - conversations        │  │
│                                           │  - recipe_sessions      │  │
│                                           │  - devices              │  │
│                                           └─────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 复用 ElatoAI 组件

| 组件 | 复用情况 | 改动 |
|------|---------|------|
| 音频编解码 (Opus) | 完全复用 | 无 |
| WebSocket 通信 | 完全复用 | 无 |
| Deno 服务器框架 | 复用 | 增加厨师业务逻辑 |
| Ultravox 集成 | 复用 | 修改 system prompt |
| 设备认证 | 复用 | 无 |
| Next.js 后台 | 复用 | 增加厨师配置页面 |

### 3.3 新增组件

| 组件 | 说明 |
|------|------|
| ESP-SR 唤醒词 | 自定义 "Hey Chef" 唤醒词 |
| GC9A01 圆屏驱动 | LVGL 图形界面 |
| 本地计时器系统 | 多计时器管理 |
| 食谱会话管理 | 上下文保持 |
| 提醒音频缓存 | 离线播放 |

---

## 四、费用优化策略

### 4.1 问题分析

做饭时长 30 分钟到 2 小时，全程语音 AI 连接成本过高：

| AI Provider | 费率 | 30分钟 | 2小时 |
|-------------|------|--------|-------|
| Ultravox | ~$0.05/min | $1.5 | $6 |
| OpenAI Realtime | ~$0.10/min | $3 | $12 |

**目标：单次做饭成本控制在 $0.05-0.10**

### 4.2 核心策略：按需连接

```
┌─────────────────────────────────────────────────────────────────┐
│                    按需连接架构                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐                  ┌─────────────────────┐  │
│  │   本地常驻       │   唤醒词触发     │   云端按需连接       │  │
│  │   (免费)        │ ───────────────► │   (按秒计费)        │  │
│  ├─────────────────┤                  ├─────────────────────┤  │
│  │ • 唤醒词检测     │                  │ • 语音对话 (5-30秒) │  │
│  │ • 多重计时器     │ ◄─────────────── │ • 食谱问答         │  │
│  │ • 时钟显示      │   回复完毕断开    │ • 烹饪指导         │  │
│  │ • 提醒音频播放   │                  │                    │  │
│  └─────────────────┘                  └─────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 功能成本分解

| 功能 | 处理位置 | 调用 AI | 单次成本 |
|------|---------|--------|---------|
| 唤醒词 "Hey Chef" | ESP32 本地 | 否 | $0 |
| 问食谱 | 云端 | 是 | ~$0.02 |
| "下一步" 导航 | 本地/云端 | 可选 | $0-0.01 |
| 插入提问 | 云端 | 是 | ~$0.01 |
| 设置计时器 | 云端 | 是 | ~$0.01 |
| 计时器运行 | ESP32 本地 | 否 | $0 |
| 计时器提醒 | ESP32 本地 | 否 | $0 |
| 查询剩余时间 | ESP32 本地 | 否 | $0 |

**单次做饭预估成本：$0.05-0.10**

---

## 五、食谱导航系统

### 5.1 上下文保持机制

支持断开重连后继续之前的食谱进度。

#### 数据模型

```sql
-- 食谱会话表
CREATE TABLE recipe_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  total_steps INTEGER NOT NULL,
  current_step INTEGER DEFAULT 1,
  steps JSONB NOT NULL,  -- ["步骤1", "步骤2", ...]
  status TEXT DEFAULT 'active',  -- active, paused, completed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '2 hours'
);

-- 索引
CREATE INDEX idx_recipe_sessions_device ON recipe_sessions(device_id);
CREATE INDEX idx_recipe_sessions_expires ON recipe_sessions(expires_at);
```

#### 意图分类

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户输入                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
    ┌──────────┐        ┌──────────┐        ┌──────────┐
    │ 导航指令  │        │ 插入提问  │        │ 新食谱   │
    │          │        │          │        │          │
    │ "下一步"  │        │ "X怎么做" │        │ "换个菜" │
    │ "重复"   │        │ "什么意思" │        │ "做Y"   │
    │ "第3步"  │        │ "为什么"  │        │          │
    └──────────┘        └──────────┘        └──────────┘
          │                   │                   │
          ▼                   ▼                   ▼
    current_step         保持 step 不变       重置 session
    +1 / 不变 / 跳转      回答后等待导航       开始新食谱
```

#### 实现逻辑

```typescript
// 意图分类（本地处理，不调 AI）
function classifyIntent(text: string): 'NEXT' | 'REPEAT' | 'PREV' | 'JUMP' | 'QUESTION' | 'NEW_RECIPE' {
  const normalized = text.toLowerCase().trim();

  if (/^(下一步|next|继续|然后呢|go on)$/i.test(normalized))
    return 'NEXT';
  if (/^(重复|再说|重来|pardon|repeat|again)$/i.test(normalized))
    return 'REPEAT';
  if (/^(上一步|back|返回|previous)$/i.test(normalized))
    return 'PREV';
  if (/^(第\d+步|step \d+)$/i.test(normalized))
    return 'JUMP';
  if (/(怎么做|做法|食谱|recipe|how to make)/.test(normalized) && normalized.length > 10)
    return 'NEW_RECIPE';

  return 'QUESTION';  // 默认当作插入提问
}

// 处理用户输入
async function handleUserInput(deviceId: string, text: string) {
  const session = await getActiveRecipeSession(deviceId);
  const intent = classifyIntent(text);

  switch (intent) {
    case 'NEXT':
      if (session && session.current_step < session.total_steps) {
        session.current_step++;
        await updateRecipeSession(session);
        return {
          response: session.steps[session.current_step - 1],
          callAI: false  // 不调 AI，零成本
        };
      }
      break;

    case 'REPEAT':
      if (session) {
        return {
          response: session.steps[session.current_step - 1],
          callAI: false
        };
      }
      break;

    case 'QUESTION':
      // 调用 AI 回答，但保持 session 不变
      return {
        context: buildContext(session),
        callAI: true,
        keepSession: true
      };

    case 'NEW_RECIPE':
      await clearRecipeSession(deviceId);
      return { callAI: true };
  }
}
```

### 5.2 对话示例

```
用户: "Hey Chef"
      → 连接 AI

用户: "红烧肉怎么做"
AI:   "好的！红烧肉分6步，我一步步教你。
       第一步：五花肉切2厘米方块，冷水下锅焯水去血沫，捞出沥干。
       准备好了说'下一步'。"
      → 存储 session: {recipe: "红烧肉", step: 1, steps: [...]}
      → 断开

用户: "Hey Chef"
      → 连接，加载 session

用户: "下一步"
      → 本地识别为 NEXT，step 1→2，不调 AI
响应: "第二步：锅中少油，放冰糖小火炒出糖色，油温约五成热时下肉块煸炒上色。"
      → 断开

用户: "Hey Chef"
用户: "五成油温怎么判断"
      → 识别为 QUESTION，调 AI，保持 step = 2
AI:   "五成油温大约150度。判断方法：筷子插入油中，周围冒密集小气泡。
       或者撒几滴水，滋滋响但不爆溅。
       好的，继续下一步吗？"
      → 断开

用户: "Hey Chef"
用户: "下一步"
      → 本地处理，step 2→3
响应: "第三步：加料酒、生抽、老抽翻炒均匀，加开水没过肉..."
      → step = 3 ✓ 正确继续
```

---

## 六、计时器系统

### 6.1 设计原则

- **设置/取消**：需要 AI 理解自然语言，调用云端
- **运行/提醒**：纯本地处理，离线可用

### 6.2 数据结构

```cpp
// ESP32 端计时器结构
struct Timer {
    char name[32];           // 计时器名称，如 "蒸蛋"
    uint32_t duration_sec;   // 总时长（秒）
    uint32_t start_time;     // 开始时间戳
    bool active;             // 是否激活
    uint8_t* reminder_audio; // 缓存的提醒音频
    size_t audio_size;       // 音频大小
};

#define MAX_TIMERS 5
Timer timers[MAX_TIMERS];
```

### 6.3 Tool Calling 定义

```typescript
// Ultravox Tool 定义
const timerTools = [
  {
    name: "set_timer",
    description: "设置厨房计时器。设置后必须用语音确认。",
    parameters: {
      type: "object",
      properties: {
        timer_name: {
          type: "string",
          description: "计时器名称，如'蒸蛋'、'炖肉'"
        },
        duration_seconds: {
          type: "number",
          description: "时长（秒）"
        },
        reminder_phrase: {
          type: "string",
          description: "到期时的提醒语，如'蒸蛋好啦，快去看看！'"
        }
      },
      required: ["timer_name", "duration_seconds", "reminder_phrase"]
    }
  },
  {
    name: "cancel_timer",
    description: "取消指定的计时器",
    parameters: {
      type: "object",
      properties: {
        timer_name: { type: "string" }
      },
      required: ["timer_name"]
    }
  },
  {
    name: "list_timers",
    description: "列出当前所有计时器状态",
    parameters: { type: "object", properties: {} }
  }
];
```

### 6.4 完整流程

```
┌─────────────────────────────────────────────────────────────────┐
│                      计时器完整流程                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [设置阶段] - 需要 AI                                            │
│  用户: "Hey Chef，炖肉定1小时，蒸蛋定8分钟"                        │
│        ↓ 连接 AI                                                │
│  AI:   "好的，炖肉1小时、蒸蛋8分钟，计时开始！"                    │
│        ↓ Tool Calling: set_timer x2                            │
│        ↓ 服务端生成提醒音频                                      │
│        ↓ 发送计时器数据 + 音频到 ESP32                           │
│        ↓ 断开连接                                               │
│                                                                 │
│  [运行阶段] - 纯本地                                             │
│  ESP32 本地维护计时器队列                                         │
│  屏幕显示倒计时                                                  │
│                                                                 │
│  [提醒阶段] - 纯本地                                             │
│  8分钟后，蒸蛋计时器到期                                          │
│        ↓                                                        │
│  播放缓存的提醒音频："蒸蛋好啦，快去看看！"                         │
│  屏幕闪烁提示                                                    │
│        ↓                                                        │
│  用户按按钮 → 关闭提醒                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 七、提醒音频方案

### 7.1 问题

AI 对话使用 Ultravox（ElevenLabs 音色），计时器提醒需要保持**同一个声音**。

### 7.2 三种方案

#### 方案 A：设置时让 AI 顺便说（推荐）

```
用户: "蒸蛋定8分钟"
        ↓
AI: "好的，8分钟后我会提醒你：蒸蛋好啦，快去看看！"
                               ↑
                  这句话同时被录下来缓存
        ↓
8分钟后，播放缓存的这句话（同一个声音）
```

**优点**：音色完全一致、零额外成本
**缺点**：需要从音频流中截取提醒语部分

#### 方案 B：ElevenLabs TTS 单独生成

```typescript
const VOICE_ID = "your-chef-voice-id";

async function generateReminder(text: string): Promise<Buffer> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
      }),
    }
  );
  return Buffer.from(await response.arrayBuffer());
}
```

**成本**：~$0.003/次
**优点**：实现简单、音色一致
**缺点**：有小额成本

#### 方案 C：预录音库 + 兜底 TTS

```
/audio/reminders/
├── generic/
│   ├── time_up.mp3           # "时间到啦！"
│   └── check_it.mp3          # "快去看看！"
├── cooking/
│   ├── egg_done.mp3          # "蛋好啦！"
│   ├── rice_done.mp3         # "饭好啦！"
│   ├── meat_done.mp3         # "肉炖好啦！"
│   └── ...
```

```typescript
async function getTimerReminder(timerName: string): Promise<Buffer> {
  // 1. 尝试匹配预录音
  const prerecorded = matchPrerecordedAudio(timerName);
  if (prerecorded) {
    return await loadAudioFile(prerecorded);
  }

  // 2. 无匹配则用 ElevenLabs 生成
  const text = `${timerName}好啦，快去看看！`;
  return await generateElevenLabsTTS(text, VOICE_ID);
}
```

**优点**：常用提醒零成本
**缺点**：需要提前录制

### 7.3 推荐策略

```
优先级：
1. 预录音库匹配 → 成本 $0
2. ElevenLabs TTS 生成 → 成本 ~$0.003
```

---

## 八、Ultravox 配置

### 8.1 System Prompt

```markdown
# 角色设定

你是 Chef，一个专业的厨房 AI 助手。你的核心程序深度植根于美国广阔多元的烹饪文化。

## 专长
- 主打美式风味：南方炸鸡、感恩节火鸡、家庭烘焙（苹果派、布朗尼）
- 兼顾全球美食：意大利面、亚洲炒菜、墨西哥卷饼、法国甜点

## 限制
你的世界里只有锅碗瓢盆、食材和烹饪的艺术。对于菜谱之外的任何话题（天气、新闻、历史等），礼貌拒绝并引导回烹饪话题。

## 食谱导航规则

当用户请求食谱时：
1. 将步骤拆分讲解，每次只说一步
2. 每步结束后提示用户说"下一步"继续
3. 区分三类用户输入：
   - **导航指令**（下一步/重复/上一步）→ 移动步骤
   - **插入提问**（什么是X/怎么判断）→ 回答后保持当前步骤，说"好的，继续下一步吗？"
   - **新食谱请求** → 重新开始

## 计时器规则

设置计时器时：
1. 调用 set_timer 工具
2. 用语音确认："好的，X分钟后我会提醒你：[提醒语]"
3. 提醒语要有厨师特色，如"蛋要老了，快关火！"

## 当前状态
{{#if active_recipe}}
正在制作：{{recipe_name}}，第 {{current_step}}/{{total_steps}} 步
{{/if}}
{{#if active_timers}}
进行中的计时器：{{timers_summary}}
{{/if}}
```

### 8.2 Tool 定义

```typescript
const chefTools = [
  // 计时器工具
  {
    name: "set_timer",
    description: "设置厨房计时器",
    parameters: {
      timer_name: { type: "string" },
      duration_seconds: { type: "number" },
      reminder_phrase: { type: "string" }
    }
  },
  {
    name: "cancel_timer",
    description: "取消计时器",
    parameters: { timer_name: { type: "string" } }
  },

  // 食谱工具
  {
    name: "save_recipe_steps",
    description: "保存食谱步骤供后续导航",
    parameters: {
      recipe_name: { type: "string" },
      steps: { type: "array", items: { type: "string" } }
    }
  },

  // 会话控制
  {
    name: "end_conversation",
    description: "用户明确表示结束时调用",
    parameters: {}
  }
];
```

---

## 九、开发计划

### 9.1 阶段划分

```
Phase 1: MVP (3周)
├── Week 1: 硬件适配
│   ├── GC9A01 圆屏驱动 + LVGL UI
│   ├── 电池管理电路
│   └── 基础显示（时钟、对话文字）
│
├── Week 2: 核心功能
│   ├── 唤醒词 "Hey Chef" 训练
│   ├── Ultravox 厨师人设配置
│   ├── 计时器 Tool Calling
│   └── 本地计时器运行
│
└── Week 3: 体验优化
    ├── 提醒音频方案实现
    ├── 食谱导航上下文保持
    └── 意图分类优化

Phase 2: 优化 (2周)
├── 预录音库建设
├── "下一步" 本地处理（零成本）
├── 离线功能增强
└── 电量管理优化

Phase 3: 量产准备 (2周)
├── 固件 OTA 更新
├── 设备配网流程
├── 生产测试工具
└── 文档完善
```

### 9.2 里程碑

| 里程碑 | 目标 | 日期 |
|--------|------|------|
| M1 | 圆屏显示 + 基础对话 | Week 1 |
| M2 | 唤醒词 + 计时器工作 | Week 2 |
| M3 | MVP 功能完整 | Week 3 |
| M4 | 费用优化完成 | Week 5 |
| M5 | 量产就绪 | Week 7 |

---

## 十、成本预算

### 10.1 硬件 BOM（预估）

| 组件 | 单价 (USD) |
|------|-----------|
| ESP32-S3-WROOM-1 (8MB) | $3.5 |
| GC9A01 圆形 LCD | $4.0 |
| INMP441 麦克风 | $1.5 |
| MAX98357 功放 + 扬声器 | $2.0 |
| TP4056 + 锂电池 | $3.0 |
| PCB + 其他 | $2.0 |
| **合计** | **~$16** |

### 10.2 运营成本（预估）

| 项目 | 单次做饭 | 月均（30次） |
|------|---------|-------------|
| Ultravox 对话 | $0.03-0.05 | $0.9-1.5 |
| ElevenLabs TTS | $0.01-0.02 | $0.3-0.6 |
| **合计** | **$0.04-0.07** | **$1.2-2.1** |

---

## 十一、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 唤醒词误触发 | 用户体验差 | 调整检测阈值，增加确认机制 |
| 网络不稳定 | 对话中断 | 本地缓存、断线重连、离线基础功能 |
| AI 理解错误 | 设置错误计时器 | 语音确认，用户可取消 |
| 费用超预期 | 运营压力 | 监控用量，动态调整策略 |
| 音频延迟 | 体验卡顿 | Opus 编码优化，预缓冲 |

---

## 十二、附录

### A. 预设拒绝回复

```
1. 经典委婉型
"唔… 这个问题似乎超出了我的菜谱库范围呢。我最擅长的是美式烹饪和全球美食的制作，不如我们聊聊下一顿做什么好吃的，比如来个地道的BBQ？"

2. 俏皮比喻型
"哎呀，你问的这个问题，就像让一位制作完美纽约芝士蛋糕的厨师去修理火箭，我实在是不擅长呀！不过，如果你想知道怎么做一份美式烤肋排，我可是专家哦！"

3. 专注人设型
"抱歉，我的程序设定是'厨房模式'，尤其专注于美式和全球菜谱信息。关于其他领域的问题，我可能无法给出准确的答案。我们还是把焦点放回美味的食物上吧？"

4. 简洁礼貌型
"对不起，我是一个专注于美式及全球菜谱的AI助手，无法回答与烹饪无关的问题。感谢您的理解。"
```

### B. 常用计时器预录音清单

```
通用：
- time_up.mp3 - "时间到啦！"
- check_it.mp3 - "快去看看！"
- turn_off.mp3 - "别忘了关火！"

肉类：
- meat_done.mp3 - "肉炖好啦，可以出锅咯！"
- steak_done.mp3 - "牛排好了，趁热吃！"

蛋类：
- egg_done.mp3 - "蛋好啦，别老了！"
- boiled_egg.mp3 - "鸡蛋煮好了！"

主食：
- rice_done.mp3 - "饭好啦！"
- noodles_done.mp3 - "面好了，快捞出来！"
- pasta_done.mp3 - "意面煮好了！"

烘焙：
- cake_done.mp3 - "蛋糕烤好啦！"
- bread_done.mp3 - "面包出炉咯！"
- cookies_done.mp3 - "饼干好了，小心烫！"

其他：
- water_boiling.mp3 - "水开啦！"
- soup_done.mp3 - "汤好了！"
- sauce_done.mp3 - "酱料熬好了！"
```

---

> 文档版本：v1.0
>
> 最后更新：2026-04-08
