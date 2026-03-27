# 用户注册设计方案

## Context

当前 ElatoAI 的注册流程存在以下问题：
1. **设备必须由管理员预录入** — `devices` 表中的 MAC 地址和 user_code 需提前手动插入，用户无法自助完成设备注册
2. **登录注册合一页面** — 注册体验不够清晰，用户可能不知道输错密码会自动注册
3. **设备端无引导** — 用户拿到预装设备后，没有从设备端发起注册的路径
4. **设备绑定依赖 user_code** — 需要用户手动输入一个短码，但这个码需要预先存在于数据库中

**目标：** 设计一套完整的用户注册流程，支持两种入口（Web 先注册再绑设备、设备引导注册），设备可自助注册无需管理员预录入。

---

## 方案设计

### 一、整体流程总览

```
入口A: Web 先注册
  用户访问 /register → 注册账号 → /onboard 填写信息 → /home
  → Settings 页面 → 输入设备 MAC 或扫码绑定

入口B: 设备引导注册
  用户开机 → WiFi 配网(热点) → 设备联网
  → 设备发现未注册 → OLED 显示注册 URL/短码
  → 用户手机访问 URL → /register?mac=XX:XX:XX:XX:XX:XX
  → 注册账号 → 自动绑定设备 → 设备收到 token → 开始使用
```

### 二、数据库变更

#### 2.1 devices 表 — 支持设备自注册

**新增字段：**
```sql
ALTER TABLE devices ADD COLUMN created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE devices ADD COLUMN device_name TEXT DEFAULT '';        -- 用户自定义设备名
ALTER TABLE devices ADD COLUMN firmware_version TEXT DEFAULT '';   -- 固件版本号
```

**关键改动：**
去掉 `user_code` 的唯一约束依赖。设备自注册时由后端自动生成 `user_code`，或改为以 MAC 地址作为设备唯一标识（MAC 已有 UNIQUE 约束）。

#### 2.2 RLS 策略调整

允许匿名用户（ESP32 设备端）INSERT `devices` 表（当前只允许 SELECT 和 UPDATE）：
```sql
CREATE POLICY "devices_self_register" ON devices
  FOR INSERT WITH CHECK (true);
```

### 三、设备自注册流程（核心改动）

#### 3.1 设备端 (firmware-arduino)

**修改文件：** `WifiManager.cpp` 中的 `isDeviceRegistered()` / `connectCb()`

当前流程：
```
WiFi 连接 → GET /api/generate_auth_token?macAddress=XX → 获取 JWT → 连 WS
```

**新流程：**
```
WiFi 连接 → GET /api/generate_auth_token?macAddress=XX
  → 成功 (设备已绑定用户) → 获取 JWT → 连 WS → 正常使用
  → 失败 404 (设备未注册/未绑定) → 进入「等待注册」模式
    → OLED 显示: "扫码注册" + 注册 URL
    → 每 10 秒轮询 GET /api/generate_auth_token?macAddress=XX
    → 成功后 → 获取 JWT → 连 WS → 正常使用
```

**修改文件：** `DisplayHandler.cpp`
- 新增 `displaySetRegistrationInfo(url)` 函数，显示注册 URL 或短码

**修改文件：** `Config.h`
- 新增 `WAITING_FOR_REGISTRATION` 状态到 `DeviceState` 枚举

#### 3.2 后端 API (frontend-nextjs)

**修改文件：** `app/api/generate_auth_token/route.ts`

当前：查 devices 表找 MAC，找不到就 400 错误。

**新逻辑：**
```
GET /api/generate_auth_token?macAddress=XX
  → 查 devices 表 mac_address = XX
    → 不存在 → 自动 INSERT devices (mac_address=XX, user_code=自动生成)
                → 返回 { status: "pending", user_code: "XXXX", register_url: "..." }
    → 存在但 user_id 为空 → 返回 { status: "pending", user_code: "XXXX", register_url: "..." }
    → 存在且 user_id 不为空 → 生成 JWT → 返回 { status: "ok", token: "..." }
```

`user_code` 自动生成规则：6 位大写字母+数字，例如 `A3B7K9`。

`register_url` 格式：`https://域名/register?mac=XX:XX:XX:XX:XX:XX`

### 四、Web 注册流程改进

#### 4.1 独立注册页面

**新增文件：** `app/(auth-pages)/register/page.tsx`

将注册从登录页分离，提供清晰的注册体验：

```
/register 页面
  ├── Email + Password 注册表单
  ├── Google OAuth 按钮 (可选)
  ├── URL 参数: ?mac=XX (来自设备引导时自动带入)
  └── 已有账号？→ 链接到 /login
```

注册成功后：
- 如果 URL 带 `mac` 参数 → 自动绑定设备 → `/onboard`
- 如果无 `mac` 参数 → `/onboard`

#### 4.2 登录页面调整

**修改文件：** `app/(auth-pages)/login/page.tsx`

- 移除「登录失败自动注册」逻辑
- 仅保留登录功能
- 添加「没有账号？注册」链接到 `/register`

#### 4.3 Onboarding 改进

**修改文件：** `app/components/Onboarding/Steps.tsx`

增加步骤：

```
Step 1: 基本信息 (当前已有)
  → supervisee_name, supervisee_age, supervisee_persona

Step 2: 设备绑定 (新增，可跳过)
  → 如果已通过 URL mac 参数绑定 → 显示「设备已绑定」→ 跳过
  → 如果未绑定 → 输入 MAC 地址 / user_code / 扫描二维码
  → 「稍后绑定」跳过按钮

Step 3: 选择角色 (新增，可跳过)
  → 展示默认角色列表 → 选择一个
  → 或跳过使用默认角色
```

#### 4.4 Settings 设备绑定改进

**修改文件：** `app/components/Settings/AppSettings.tsx`

当前：输入 user_code 绑定。

**改进：**
- 支持输入 MAC 地址直接绑定（除了 user_code）
- 支持解绑设备（将 devices.user_id 和 users.device_id 清空）
- 显示设备信息（MAC 地址、固件版本）

### 五、设备引导注册流程（入口B）

完整时序：

```
1. 用户开机设备
2. OLED 显示 "WiFi Setup" → 手机连 ELATO-DEVICE 热点
3. 手机访问 192.168.4.1/wifi → 配置 WiFi
4. 设备联网 → 调用 /api/generate_auth_token?macAddress=XX
5. 后端自动创建 devices 记录 → 返回 { status: "pending", register_url }
6. 设备 OLED 显示:
   第一行: "Register at:"
   第二行: 滚动显示 register_url (或显示短域名)
   (或: 显示 user_code "Code: A3B7K9")
7. 用户手机访问 register_url → /register?mac=XX:XX:XX:XX:XX:XX
8. 用户注册/登录 → 自动绑定设备
9. 设备轮询检测到绑定成功 → 获取 JWT → 连接 WS → Ready
10. OLED 显示 "Ready" → 用户按按钮开始对话
```

### 六、涉及文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| **frontend-nextjs** | | |
| `app/(auth-pages)/register/page.tsx` | 新增 | 独立注册页面 |
| `app/(auth-pages)/login/page.tsx` | 修改 | 移除自动注册，添加注册链接 |
| `app/api/generate_auth_token/route.ts` | 修改 | 支持设备自注册，返回 pending 状态 |
| `app/actions.ts` | 修改 | 新增 signUpAction (独立), 注册时自动绑定设备 |
| `app/auth/callback/route.ts` | 修改 | OAuth 注册时处理 mac 参数自动绑定 |
| `app/components/Onboarding/Steps.tsx` | 修改 | 增加设备绑定和角色选择步骤 |
| `app/components/Settings/AppSettings.tsx` | 修改 | 支持 MAC 绑定、解绑 |
| `db/devices.ts` | 修改 | 新增 createDevice, getDeviceByMac, unbindDevice |
| **firmware-arduino** | | |
| `src/WifiManager.cpp` | 修改 | 轮询等待注册，解析新 API 响应 |
| `src/DisplayHandler.cpp` | 修改 | 新增注册引导显示 |
| `src/Config.h` | 修改 | 新增 WAITING_FOR_REGISTRATION 状态 |
| `src/LEDHandler.cpp` | 修改 | 新增等待注册状态 LED 颜色 |
| **supabase** | | |
| 新增迁移文件 | 新增 | devices 表新增字段 + RLS 策略 |

### 七、验证方案

1. **Web 注册流程 (入口A):**
   - 访问 /register → 邮箱注册 → 验证邮件 → 回调 → onboard → home
   - 在 Settings 中输入设备 MAC 地址绑定 → 设备自动获取 token

2. **设备引导注册 (入口B):**
   - 设备开机 → WiFi 配网 → OLED 显示注册 URL
   - 手机访问 URL → 注册 → 设备自动获取 token → Ready

3. **设备自注册:**
   - 新设备首次调用 API → devices 表自动插入记录
   - 绑定用户后再次调用 → 正常返回 JWT

4. **向后兼容:**
   - 已有 devices 记录的老设备不受影响
   - 已有 user_code 绑定方式继续可用
