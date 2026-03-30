#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO_DIR="$SCRIPT_DIR/server-deno"
PID_FILE="$DENO_DIR/deno.pid"
LOG_FILE="$DENO_DIR/deno.log"

# Check if already running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Deno server is already running (PID: $PID)"
        exit 1
    else
        rm -f "$PID_FILE"
    fi
fi

cd "$DENO_DIR"

# Start Deno server in background
echo "Starting Deno server..."
nohup deno run -A --env-file=.env main.ts > "$LOG_FILE" 2>&1 &
PID=$!

# Save PID
echo $PID > "$PID_FILE"
echo "Deno server started (PID: $PID)"
echo "Log file: $LOG_FILE"
