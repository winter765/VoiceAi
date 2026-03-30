OTA 使用流程

一、发布新版本

1. 修改版本号
# firmware-idf/CMakeLists.txt
set(PROJECT_VER "1.0.2")  # 改为新版本号

2. 编译固件
cd firmware-idf && source ~/esp/esp-idf/export.sh && idf.py build

3. 复制固件到下载目录
cp build/elato.bin ../frontend-nextjs/firmware/elato_1.0.2.bin

4. 更新数据库
UPDATE firmware_versions
SET version = '1.0.2', file_url = 'elato_1.0.2.bin', is_active = true
WHERE board_type = 'bread-compact-wifi';

---
二、设备升级流程（自动）

设备启动
↓
连接 WiFi
↓
请求 /api/ota 检查版本
↓
比较版本号（当前 < 服务器）
↓
下载 /api/ota/download/elato_x.x.x.bin
↓
写入 OTA 分区
↓
重启，运行新版本

---
三、配置说明

┌────────────────┬────────────────────────────┬──────────────────────────┐
│     配置项     │            位置            │           说明           │
├────────────────┼────────────────────────────┼──────────────────────────┤
│ OTA 服务器 URL │ sdkconfig → CONFIG_OTA_URL │ 版本检查接口地址         │
├────────────────┼────────────────────────────┼──────────────────────────┤
│ 固件存放目录   │ 环境变量 FIRMWARE_DIR      │ 默认 ./firmware          │
├────────────────┼────────────────────────────┼──────────────────────────┤
│ 数据库表       │ firmware_versions          │ 版本号、文件名、是否激活 │
└────────────────┴────────────────────────────┴──────────────────────────┘

---
四、强制升级/降级

-- 强制推送（忽略版本比较）
UPDATE firmware_versions SET force_update = true WHERE board_type = 'bread-compact-wifi';

-- 关闭强制
UPDATE firmware_versions SET force_update = false WHERE board_type = 'bread-compact-wifi';

---
五、测试命令

# 检查版本接口
curl http://localhost:3000/api/ota

# 测试下载
curl -O http://localhost:3000/api/ota/download/elato_1.0.2.bin

# 查看文件大小
ls -la frontend-nextjs/firmware/

---
六、常见问题

┌─────────────────────────┬──────────────────────┬────────────────────────────────────────────────┐
│          问题           │         原因         │                      解决                      │
├─────────────────────────┼──────────────────────┼────────────────────────────────────────────────┤
│ 循环升级                │ 固件内部版本号未更新 │ 修改 CMakeLists.txt 后重新编译                 │
├─────────────────────────┼──────────────────────┼────────────────────────────────────────────────┤
│ OTA 失败 PENDING_VERIFY │ 当前固件未确认有效   │ 代码已修复，自动调用 MarkCurrentVersionValid() │
├─────────────────────────┼──────────────────────┼────────────────────────────────────────────────┤
│ 下载 404                │ 文件名不匹配         │ 检查 file_url 与实际文件名一致                 │
└─────────────────────────┴──────────────────────┴────────────────────────────────────────────────┘
