# Chef AI 部署指南

为公司 B 部署独立的 Chef AI 服务。

## 架构概览

```
Lightsail (35.162.7.133)
├── nginx 443
│   ├── voice.novarian.ai    → 8080 (公司A Deno)
│   ├── console.novarian.ai  → 3000 (公司A Next.js)
│   ├── chef.novarian.ai     → 8081 (公司B Deno)    ← 新增
│   └── chef-app.novarian.ai → 3001 (公司B Next.js) ← 新增
│
├── /opt/voice_ai/   (公司A)
└── /opt/chef_ai/    (公司B) ← 新增
```

## 前置条件

1. **公司 B 创建独立 Supabase 项目**
2. **服务器建议配置**: 2GB+ 内存

---

## 第一步：创建 Supabase 项目

1. 登录 [supabase.com](https://supabase.com)（使用公司 B 账号）
2. 创建新项目，如 `chef-ai`
3. 进入 **SQL Editor**，运行 `supabase_schema.sql` 中的全部内容
4. 记录以下信息：
   - `SUPABASE_URL`: Project Settings → API → Project URL
   - `SUPABASE_KEY`: Project Settings → API → anon public key
   - `SUPABASE_SERVICE_ROLE_KEY`: Project Settings → API → service_role key
   - `JWT_SECRET_KEY`: Project Settings → API → JWT Secret

---

## 第二步：配置 DNS

在域名管理处添加 A 记录：

| 主机名 | 类型 | 值 |
|--------|------|-----|
| chef | A | 35.162.7.133 |
| chef-app | A | 35.162.7.133 |

---

## 第三步：服务器部署

### 3.1 SSH 登录服务器

```bash
ssh ubuntu@35.162.7.133
```

### 3.2 安装 SSL 证书

```bash
sudo certbot --nginx -d chef.novarian.ai -d chef-app.novarian.ai
```

### 3.3 配置 nginx

```bash
# 复制配置文件
sudo cp nginx_chef.conf /etc/nginx/sites-available/chef
sudo ln -sf /etc/nginx/sites-available/chef /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载
sudo systemctl reload nginx
```

### 3.4 创建目录结构

```bash
sudo mkdir -p /opt/chef_ai/{server-deno,frontend-nextjs,logs}
```

### 3.5 部署 server-deno

```bash
# 复制代码
sudo cp -r server-deno/* /opt/chef_ai/server-deno/

# 配置环境变量
sudo nano /opt/chef_ai/server-deno/.env
```

**.env 内容**（使用公司 B 的 Supabase 凭证）:

```env
# Supabase (公司 B 项目)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
JWT_SECRET_KEY=your-jwt-secret

# Encryption Key
ENCRYPTION_KEY=your-32-char-encryption-key

# AI Provider
ULTRAVOX_API_KEY=your-ultravox-api-key

# Server
HOST=127.0.0.1
PORT=8081
DEV_MODE=False
```

### 3.6 部署 frontend-nextjs

```bash
# 在本地构建
cd frontend-nextjs
npm ci
npm run build

# 上传到服务器
rsync -avz .next/standalone/ ubuntu@35.162.7.133:/opt/chef_ai/frontend-nextjs/
rsync -avz .next/static ubuntu@35.162.7.133:/opt/chef_ai/frontend-nextjs/.next/
rsync -avz public ubuntu@35.162.7.133:/opt/chef_ai/frontend-nextjs/
```

配置 Next.js 环境变量：

```bash
sudo nano /opt/chef_ai/frontend-nextjs/.env
```

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### 3.7 安装 systemd 服务

```bash
# 复制服务文件
sudo cp chef-deno.service /etc/systemd/system/
sudo cp chef-nextjs.service /etc/systemd/system/

# 重载 systemd
sudo systemctl daemon-reload

# 启用并启动服务
sudo systemctl enable chef-deno chef-nextjs
sudo systemctl start chef-deno
sudo systemctl start chef-nextjs
```

---

## 第四步：验证部署

### 检查服务状态

```bash
sudo systemctl status chef-deno
sudo systemctl status chef-nextjs
```

### 检查端口

```bash
ss -tlnp | grep -E '8081|3001'
```

### 测试连接

```bash
# WebSocket
wscat -c wss://chef.novarian.ai

# Web App
curl -I https://chef-app.novarian.ai
```

---

## 运维命令

```bash
# 查看日志
tail -f /opt/chef_ai/logs/deno.log
tail -f /opt/chef_ai/logs/nextjs.log

# 重启服务
sudo systemctl restart chef-deno
sudo systemctl restart chef-nextjs

# 停止服务
sudo systemctl stop chef-deno chef-nextjs
```

---

## 资源监控

```bash
# 内存使用
free -h

# 进程资源
htop

# 磁盘空间
df -h
```

---

## 固件配置

ESP32 设备需要修改 WebSocket 地址：

```cpp
// firmware-idf/main/protocols/elato_protocol.cc
#define WEBSOCKET_URL "wss://chef.novarian.ai"
```

---

## 故障排查

### 服务启动失败

```bash
# 查看详细日志
journalctl -u chef-deno -n 50 --no-pager
journalctl -u chef-nextjs -n 50 --no-pager
```

### WebSocket 连接失败

1. 检查 nginx 配置：`sudo nginx -t`
2. 检查 SSL 证书：`sudo certbot certificates`
3. 检查端口监听：`ss -tlnp | grep 8081`

### 数据库连接失败

1. 验证 `.env` 中的 Supabase URL 和 Key
2. 测试连接：
   ```bash
   curl "https://xxxxx.supabase.co/rest/v1/users?select=*" \
     -H "apikey: your-anon-key"
   ```
