#!/bin/bash
# ============================================================
# Chef AI - Deployment Script
# Run on Lightsail server: bash deploy.sh
# ============================================================

set -e

echo "=========================================="
echo "Chef AI Deployment Script"
echo "=========================================="

# Configuration
CHEF_DIR="/opt/chef_ai"
REPO_URL="git@github.com:YOUR_ORG/ElatoAI.git"  # TODO: Update this
BRANCH="chef"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Step 1: Create directory structure
echo -e "${GREEN}[1/7] Creating directory structure...${NC}"
mkdir -p $CHEF_DIR/logs
mkdir -p $CHEF_DIR/server-deno
mkdir -p $CHEF_DIR/frontend-nextjs

# Step 2: Clone/Update repository
echo -e "${GREEN}[2/7] Fetching code...${NC}"
if [ -d "$CHEF_DIR/repo" ]; then
    cd $CHEF_DIR/repo
    git fetch origin
    git checkout $BRANCH
    git pull origin $BRANCH
else
    git clone -b $BRANCH $REPO_URL $CHEF_DIR/repo
fi

# Step 3: Copy server-deno
echo -e "${GREEN}[3/7] Deploying Deno server...${NC}"
rsync -av --delete $CHEF_DIR/repo/server-deno/ $CHEF_DIR/server-deno/ \
    --exclude='.env' \
    --exclude='logs.log' \
    --exclude='debug_audio_*'

# Check .env exists
if [ ! -f "$CHEF_DIR/server-deno/.env" ]; then
    echo -e "${YELLOW}WARNING: .env not found! Copy .env.example and configure:${NC}"
    echo "  cp $CHEF_DIR/server-deno/.env.example $CHEF_DIR/server-deno/.env"
    echo "  nano $CHEF_DIR/server-deno/.env"
fi

# Step 4: Build Next.js
echo -e "${GREEN}[4/7] Building Next.js...${NC}"
cd $CHEF_DIR/repo/frontend-nextjs

# Check .env.local exists
if [ ! -f ".env.local" ]; then
    echo -e "${YELLOW}WARNING: .env.local not found! Copy and configure:${NC}"
    echo "  cp .env.example .env.local"
    echo "  nano .env.local"
fi

npm ci
npm run build

# Copy standalone build
rsync -av --delete .next/standalone/ $CHEF_DIR/frontend-nextjs/
cp -r .next/static $CHEF_DIR/frontend-nextjs/.next/
cp -r public $CHEF_DIR/frontend-nextjs/ 2>/dev/null || true

# Step 5: Install systemd services
echo -e "${GREEN}[5/7] Installing systemd services...${NC}"
cp $CHEF_DIR/repo/deploy/chef/chef-deno.service /etc/systemd/system/
cp $CHEF_DIR/repo/deploy/chef/chef-nextjs.service /etc/systemd/system/
systemctl daemon-reload

# Step 6: Start/Restart services
echo -e "${GREEN}[6/7] Starting services...${NC}"
systemctl enable chef-deno chef-nextjs
systemctl restart chef-deno
systemctl restart chef-nextjs

# Step 7: Verify
echo -e "${GREEN}[7/7] Verifying deployment...${NC}"
sleep 2

echo ""
echo "Service Status:"
echo "---------------"
systemctl status chef-deno --no-pager -l | head -10
echo ""
systemctl status chef-nextjs --no-pager -l | head -10

echo ""
echo -e "${GREEN}=========================================="
echo "Deployment Complete!"
echo "==========================================${NC}"
echo ""
echo "Endpoints:"
echo "  - WebSocket: wss://chef.novarian.ai"
echo "  - Web App:   https://chef-app.novarian.ai"
echo ""
echo "Logs:"
echo "  - Deno:    tail -f $CHEF_DIR/logs/deno.log"
echo "  - Next.js: tail -f $CHEF_DIR/logs/nextjs.log"
echo ""
echo "Commands:"
echo "  - Restart Deno:    systemctl restart chef-deno"
echo "  - Restart Next.js: systemctl restart chef-nextjs"
