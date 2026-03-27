# ElatoAI 部署方案：单台 VPS + Nginx + Let's Encrypt

## 架构总览

```
ESP32 ──wss://api.elato.example.com──→┐
                                       │
Browser ──https://elato.example.com──→ Nginx (443, SSL终止)
                                       ├──→ 127.0.0.1:8080 (Deno Server)
                                       └──→ 127.0.0.1:3000 (Next.js)

                                       ↕
                                  Supabase Cloud (DB + Auth)
                                       ↕
                                  Ultravox API (语音AI)
```

## 需要准备的资源

| 资源 | 推荐 | 费用 |
|------|------|------|
| VPS | DigitalOcean / Vultr / Lightsail，2核2GB，美西机房 | ~$10/月 |
| 域名 | 任意注册商，两条 A 记录指向 VPS IP | ~$10/年 |
| Supabase | supabase.com 免费套餐 | 免费 |
| SSL 证书 | Let's Encrypt 自动申请 | 免费 |

---

## 第一步：Supabase Cloud

1. 去 https://supabase.com 创建项目（选美西区域）
2. 记录以下值：
   - `SUPABASE_URL` (https://xxx.supabase.co)
   - `SUPABASE_ANON_KEY`
   - `JWT_SECRET` (Settings → API → JWT Secret)
3. 推送本地数据库 schema：
   ```bash
   npx supabase link --project-ref <project-id>
   npx supabase db push
   ```
4. 导入种子数据：在 Supabase Dashboard SQL Editor 中执行 `seed.sql`

---

## 第二步：VPS 初始化

```bash
# 以 Ubuntu 22.04 为例
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx certbot python3-certbot-nginx git
sudo apt install -y unzip 

# 安装 Deno
curl -fsSL https://deno.land/install.sh | sh
echo 'export DENO_INSTALL="$HOME/.deno"' >> ~/.bashrc
echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# 安装 Node.js 20（给 Next.js 用）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 创建部署目录
sudo mkdir -p /opt/elato && sudo chown $USER /opt/elato
```

---

## 第三步：部署代码

```bash
cd /opt/elato
git clone <your-repo-url> .

# --- Deno Server ---
cd /opt/elato/server-deno
cp .env.example .env   # 或直接创建
# 编辑 .env，填入以下内容：
# SUPABASE_URL=https://xxx.supabase.co
# SUPABASE_KEY=<anon_key>
# JWT_SECRET_KEY=<和 Supabase 一致>
# ULTRAVOX_API_KEY=<你的key>
# DEV_MODE=              ← 留空或不写，确保生产模式

# --- Next.js ---
cd /opt/elato/frontend-nextjs
cp .env.example .env.local
# 编辑 .env.local：
# NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
# NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon_key>
# JWT_SECRET_KEY=<同上>
# GOOGLE_OAUTH=False
# NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION=False

npm install
npm run build
```

---

## 第四步：systemd 服务

### Deno Server — `/etc/systemd/system/elato-deno.service`

```ini
[Unit]
Description=ElatoAI Deno WebSocket Server
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/elato/server-deno
EnvironmentFile=/opt/elato/server-deno/.env
ExecStart=/home/deploy/.deno/bin/deno run -A main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Next.js — `/etc/systemd/system/elato-web.service`

```ini
[Unit]
Description=ElatoAI Next.js Web App
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/elato/frontend-nextjs
EnvironmentFile=/opt/elato/frontend-nextjs/.env.local
ExecStart=/usr/bin/node .next/standalone/server.js
Environment=PORT=3000
Environment=HOSTNAME=0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 启动服务

```bash
sudo systemctl daemon-reload
sudo systemctl enable elato-deno elato-web
sudo systemctl start elato-deno elato-web
```

---

## 第五步：Nginx + SSL

### DNS 配置

两条 A 记录指向 VPS IP：
- `api.elato.example.com → VPS_IP`
- `elato.example.com → VPS_IP`

### Nginx 配置 — `/etc/nginx/sites-available/elato`

```nginx
# Deno WebSocket Server
server {
    listen 80;
    server_name api.elato.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

# Next.js Web App
server {
    listen 80;
    server_name elato.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 启用 Nginx 并申请 SSL

```bash
sudo ln -s /etc/nginx/sites-available/elato /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 一键申请 SSL + 自动改写 Nginx 配置为 HTTPS
sudo certbot --nginx -d api.elato.example.com -d elato.example.com
```

Certbot 会自动把 HTTP 配置升级为 HTTPS，并添加 301 重定向。

---

## 第六步：固件改动

### Config.h — 切换为 PROD_MODE

```cpp
// #define DEV_MODE
#define PROD_MODE
```

### Config.cpp — PROD_MODE 段填入实际值

```cpp
#ifdef PROD_MODE
const char *ws_server = "api.elato.example.com";
const int ws_port = 443;
const char *backend_server = "elato.example.com";
const int backend_port = 443;

// Let's Encrypt 根证书 ISRG Root X1
// 可以直接复制 ELATO_MODE 段中已有的证书
const char *CA_cert = R"(-----BEGIN CERTIFICATE-----
MIIFazCCA1Og...  ← 复制 ELATO_MODE 段的 ISRG Root X1
-----END CERTIFICATE-----)";

const char *Vercel_CA_cert = CA_cert;  // 同一个根证书
#endif
```

编译烧录到 ESP32。

---

## 第七步：验证清单

```bash
# 1. 服务是否运行
sudo systemctl status elato-deno    # Active: active (running)
sudo systemctl status elato-web     # Active: active (running)

# 2. Nginx 是否正常
curl -I https://elato.example.com           # 200 OK
curl -I https://api.elato.example.com       # 应返回 426 (需要 WebSocket 升级)

# 3. WebSocket 连接测试
# 安装 wscat: npm install -g wscat
wscat -c wss://api.elato.example.com        # 应连接成功（会被 401 断开，说明通了）

# 4. SSL 证书检查
echo | openssl s_client -connect api.elato.example.com:443 2>/dev/null | head -5

# 5. ESP32 上电测试
# 串口日志应显示：[WSc] Connected to url: /
# 按按钮后：[CHAT] Sending START_SESSION to server
```

---

## 后续维护

```bash
# 查看日志
journalctl -u elato-deno -f     # Deno 实时日志
journalctl -u elato-web -f      # Next.js 实时日志

# 更新代码
cd /opt/elato && git pull
sudo systemctl restart elato-deno
cd frontend-nextjs && npm run build && sudo systemctl restart elato-web

# SSL 证书自动续期（certbot 已配置 timer，无需手动）
sudo certbot renew --dry-run     # 测试续期是否正常
```

---

## 关键注意事项

1. **JWT_SECRET_KEY 必须三端一致**：Supabase Cloud、Deno Server .env、Next.js .env.local 使用同一个值
2. **Nginx WebSocket 超时**：`proxy_read_timeout 86400s` 必须设大，否则空闲 60s 会被断开
3. **Deno Server 生产端口 8080**：`main.ts` 非 DEV_MODE 时写死 `server.listen(8080)`，与 Nginx 配置对应
4. **Let's Encrypt 根证书**：ISRG Root X1，ESP32 固件中 ELATO_MODE 段已有完整证书可复制到 PROD_MODE
5. **devices 表需预注册**：部署后需在 Supabase Dashboard 手动插入设备记录（mac_address + user_code）
6. **VPS 机房选美西**：Ultravox API 在美国，减少音频中继延迟
