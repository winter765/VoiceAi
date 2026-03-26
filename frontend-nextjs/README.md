# frontend-nextjs 代码架构文档

## 技术栈

| 技术 | 用途 |
|---|---|
| Next.js 15 | App Router, standalone 输出模式 |
| Tailwind CSS + Radix UI (shadcn/ui) | UI 组件库 |
| Supabase (SSR) | 认证 + PostgreSQL 数据库 |
| OpenAI Realtime API | Web 端 WebRTC 直连语音 |
| Stripe | 支付集成 |
| Framer Motion | 动画 |
| React Hook Form + Zod | 表单验证 |

## 目录结构

```
frontend-nextjs/
├── app/
│   ├── layout.tsx                # 根布局：加载用户、Navbar、Footer、GA
│   ├── page.tsx                  # 落地页（Landing Page）
│   ├── actions.ts                # Server Actions（登录/注册/登出/设备绑定/GitHub Stars）
│   ├── sitemap.ts                # 站点地图
│   ├── (auth-pages)/             # 认证页组
│   │   ├── sign-in/page.tsx      # 登录页
│   │   └── forgot-password/page.tsx  # 忘记密码
│   ├── auth/callback/route.ts    # OAuth 回调处理
│   ├── home/                     # 已登录主界面
│   │   ├── page.tsx              # Playground 页（角色选择 + 实时对话）
│   │   ├── settings/page.tsx     # 设置页
│   │   ├── create/page.tsx       # 创建自定义角色
│   │   └── layout.tsx            # 主界面布局
│   ├── onboard/page.tsx          # 新用户引导流程
│   ├── protected/                # 修改密码
│   ├── animation/                # 动画演示页
│   ├── logo/                     # Logo 展示页
│   ├── api/                      # API Routes
│   └── components/               # 页面级组件
├── components/ui/                # shadcn/ui 基础组件库（30+ 组件）
├── db/                           # Supabase 数据库访问层
├── lib/                          # 常量、工具函数
├── utils/                        # Supabase 客户端、i18n、工具
├── middleware.ts                  # 全局中间件（Session 刷新）
├── next.config.js                # Next.js 配置（standalone 输出）
└── package.json
```

## API Routes

| 路由 | 方法 | 功能 |
|---|---|---|
| `/api/session` | GET | 生成 OpenAI Realtime 临时 Key，构建系统提示词（含聊天历史、角色信息），用于 WebRTC 连接 |
| `/api/generate_auth_token` | GET | ESP32 设备通过 MAC 地址获取 JWT Token（有效期 10 年）；DEV 模式支持 `SKIP_DEVICE_REGISTRATION` |
| `/api/ota_update_handler` | POST | 设备 OTA 升级完成后清除 `devices.is_ota` 标志 |
| `/api/factory_reset_handler` | POST | 设备出厂重置后清除 `devices.is_reset` 标志 |
| `/api/checkout` | POST | 创建 Stripe Checkout Session（全球配送） |
| `/auth/callback` | GET | Supabase OAuth 回调：code 换 session，首次登录自动建用户并跳转 `/onboard` |

## 核心页面

### 落地页 (`app/page.tsx`)
- 产品介绍、角色展示轮播、YouTube Demo、GitHub Stars 计数
- 定价信息、产品特性说明

### Playground (`app/home/page.tsx`)
- 认证检查 → 加载用户角色列表
- `PlaygroundComponent`: 角色选择卡片 + 切换 personality → 更新 Supabase
- `Realtime/App.tsx`: WebRTC 实时语音对话

### 设置页 (`app/home/settings/page.tsx`)
- 个人信息编辑（姓名、年龄、兴趣）
- 设备绑定（用户码输入）
- 音量远程控制
- 语言切换
- 登出

### 创建角色 (`app/home/create/page.tsx`)
- `BuildDashboard`: 自定义 AI 角色创建面板
- 配置 provider、voice、character_prompt、voice_prompt

### 新用户引导 (`app/onboard/page.tsx`)
- 首次登录引导流程
- 收集用户基本信息

## 核心组件

### Realtime 语音 (`app/components/Realtime/`)

**`App.tsx` — WebRTC 连接管理：**
```
获取临时 key (GET /api/session)
  → createRealtimeConnection()
  → 建立 RTCPeerConnection
  → DataChannel 收发 OpenAI 实时事件
  → 音频可视化
```

**`lib/realtimeConnection.ts` — WebRTC SDP 协商：**
- 直连 `https://api.openai.com/v1/realtime`
- 创建 offer → 服务端 answer → 建立连接

### Playground (`app/components/Playground/`)
- `PlaygroundComponent.tsx` — 角色选择 + 实时对话组合
- 角色卡片网格展示，点击切换 personality

### 设置 (`app/components/Settings/`)
- `AppSettings.tsx` — 设备注册、音量调节、登出

### 落地页 (`app/components/LandingPage/`)
- 约 15 个子组件：轮播、定价、产品展示等

### 导航 (`app/components/Nav/`)
- Navbar、移动端菜单、侧边栏

## 数据库访问层 (`db/`)

| 文件 | 对应表 | 主要操作 |
|---|---|---|
| `db/users.ts` | `users` | createUser, getUserById（含 personality + device join）, updateUser, doesUserExist |
| `db/devices.ts` | `devices` | 检查用户码、绑定设备、更新设备、音量控制 |
| `db/personalities.ts` | `personalities` | 获取全部公共角色、获取我的角色、按 ID 查询、创建角色 |
| `db/conversations.ts` | `conversations` | 对话历史查询 |
| `db/languages.ts` | `languages` | 语言列表 |
| `db/supabase.ts` | — | 自动生成的 TypeScript 类型定义（DB Schema） |

## 认证流程

### Web 用户认证
```
用户访问任意页面
  → middleware.ts 调用 updateSession() 刷新 Supabase Session（Cookie）
  → 登录方式：邮箱/密码 (signInAction) 或 Google OAuth
  → OAuth 回调 /auth/callback:
    exchangeCodeForSession → 首次用户自动建记录 → /onboard
  → 后续访问 /home: 服务端检查用户, 不存在则创建
```

### 设备认证
```
ESP32 MAC 地址
  → GET /api/generate_auth_token?macAddress=XX:XX:XX:XX:XX:XX
  → 查 devices 表 → 关联 users
  → 签名 JWT: {sub: user_id, email, exp: 10年}
  → DEV: SKIP_DEVICE_REGISTRATION=True 时返回 admin 用户 token
```

## Supabase 客户端

| 使用场景 | 文件 | 方式 |
|---|---|---|
| Server Components / API Routes | `utils/supabase/server.ts` | `createServerClient`（基于 Cookie） |
| Client Components | `utils/supabase/client.ts` | `createBrowserClient` |
| Middleware | `utils/supabase/middleware.ts` | `updateSession`（刷新 Token） |

## Server Actions (`app/actions.ts`)

| Action | 功能 |
|---|---|
| `signUpAction` | 邮箱注册 |
| `signInAction` | 邮箱登录 |
| `signOutAction` | 登出 |
| `forgotPasswordAction` | 忘记密码 |
| `resetPasswordAction` | 重置密码 |
| `dbCheckUserCode` | 检查设备用户码 |
| `dbAddUserToDevice` | 绑定设备 |
| `fetchGitHubStars` | 获取 GitHub Stars 数 |

## 关键常量 (`lib/data.ts`)

| 常量 | 值 | 说明 |
|---|---|---|
| 默认 personality ID | `a1c073e6-653d-40cf-acc1-891331689409` | 默认角色 |
| 初始积分 | 50 | 每积分 = 36 秒 |
| 设备售价 | $55 | Stripe 结账 |
| 订阅价格 | $10/月 | 付费会员 |
| 语音列表 | OpenAI (8), Grok (5), Gemini (30) | 各 provider 可选语音 |

## 环境变量 (.env.local)

| 变量 | 必须 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 是 | Supabase 项目 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 是 | Supabase anon key |
| `JWT_SECRET_KEY` | 是 | JWT 签名密钥 |
| `OPENAI_API_KEY` | 否 | Web 端 WebRTC 直连用 |
| `ENCRYPTION_KEY` | 否 | AES-256-CBC 主密钥 |
| `STRIPE_SECRET_KEY` | 否 | Stripe 支付密钥 |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | 否 | Stripe 公开密钥 |
| `GOOGLE_OAUTH` | 否 | 启用 Google OAuth |
| `NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION` | 否 | 跳过设备注册（开发用） |

## 开发指南

**环境要求：**
- Node.js 18+

**开发模式：**
```bash
cd frontend-nextjs
cp .env.example .env.local  # 首次配置环境变量
npm install
npm run dev                  # http://0.0.0.0:3000
```

**生产构建与启动：**
```bash
npm run build
HOSTNAME=0.0.0.0 PORT=3000 node .next/standalone/server.js
```

**输出模式：**
- `next.config.js` 配置 `output: "standalone"`
- 生产部署使用 `.next/standalone/server.js`

## UI 组件库

基于 shadcn/ui，包含 30+ 基础组件：

`accordion`, `alert-dialog`, `avatar`, `badge`, `button`, `card`, `carousel`, `checkbox`, `collapsible`, `dialog`, `drawer`, `dropdown-menu`, `form`, `input`, `label`, `navigation-menu`, `popover`, `progress`, `radio-group`, `scroll-area`, `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `slider`, `switch`, `tabs`, `textarea`, `tooltip`
