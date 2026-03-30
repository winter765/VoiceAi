# 编译
idf.py build

# 烧录
idf.py flash

# 监控串口
idf.py monitor

# 编译+烧录+监控（常用）
idf.py flash monitor

# 清理编译
idf.py fullclean

# 配置菜单
idf.py menuconfig

# 擦除 NVS（清除 WiFi 配置等）
idf.py erase-otadata

# 完全擦除 flash
idf.py erase-flash

# 查看分区表
idf.py partition-table

# 设置目标芯片
idf.py set-target esp32s3

完整命令（含环境初始化）：
cd firmware-idf && source ~/esp/esp-idf/export.sh && idf.py flash monitor

退出 monitor：Ctrl + ]
