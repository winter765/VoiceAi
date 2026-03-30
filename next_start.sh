#!/bin/bash

# Load nvm environment and use Node 24
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 24 > /dev/null 2>&1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NEXT_DIR="$SCRIPT_DIR/frontend-nextjs"
PID_FILE="$NEXT_DIR/next.pid"
LOG_FILE="$NEXT_DIR/next.log"

# Check if already running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Next.js server is already running (PID: $PID)"
        exit 1
    else
        rm -f "$PID_FILE"
    fi
fi

cd "$NEXT_DIR"

# Start Next.js server in background
echo "Starting Next.js server..."
nohup npm run dev > "$LOG_FILE" 2>&1 &
PID=$!

# Save PID
echo $PID > "$PID_FILE"
echo "Next.js server started (PID: $PID)"
echo "Log file: $LOG_FILE"
