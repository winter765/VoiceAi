#!/bin/bash
# ElatoAI Firmware Build Script
# Prerequisites: ESP-IDF 5.5.2+ installed and sourced

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== ElatoAI Firmware Build Script ===${NC}"

# Check if ESP-IDF is installed
if [ -z "$IDF_PATH" ]; then
    echo -e "${YELLOW}ESP-IDF not sourced. Trying to source from ~/esp/esp-idf...${NC}"
    if [ -f ~/esp/esp-idf/export.sh ]; then
        source ~/esp/esp-idf/export.sh
    else
        echo -e "${RED}Error: ESP-IDF not found. Please install ESP-IDF first.${NC}"
        echo "Installation: mkdir -p ~/esp && cd ~/esp && git clone -b v5.5.2 --depth 1 --recursive https://github.com/espressif/esp-idf.git && cd esp-idf && ./install.sh esp32s3 && source export.sh"
        exit 1
    fi
fi

# Navigate to firmware directory
cd "$(dirname "$0")"

echo -e "${GREEN}Step 1: Set target to ESP32-S3${NC}"
idf.py set-target esp32s3

echo -e "${GREEN}Step 2: Configure menuconfig (select bread-compact-wifi board)${NC}"
echo "Please select:"
echo "  Xiaozhi Assistant -> Board Type -> 'Bread Compact WiFi'"
echo "  Xiaozhi Assistant -> OLED Type -> 'SSD1306 128*32'"
echo ""
echo -e "${YELLOW}Press any key to open menuconfig, or Ctrl+C to skip...${NC}"
read -n 1 -s
idf.py menuconfig

echo -e "${GREEN}Step 3: Build firmware${NC}"
idf.py build

echo -e "${GREEN}Build complete!${NC}"
echo ""
echo "To flash and monitor:"
echo "  idf.py flash monitor"
echo ""
echo "Or flash only:"
echo "  idf.py flash"
