#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NEXT_DIR="$SCRIPT_DIR/frontend-nextjs"
PID_FILE="$NEXT_DIR/next.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "Next.js server is not running (no PID file found)"
    exit 1
fi

PID=$(cat "$PID_FILE")

if ps -p "$PID" > /dev/null 2>&1; then
    echo "Stopping Next.js server (PID: $PID)..."
    kill "$PID"
    sleep 1

    # Force kill if still running
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Force killing..."
        kill -9 "$PID"
    fi

    # Also kill any child processes (node)
    pkill -P "$PID" 2>/dev/null

    rm -f "$PID_FILE"
    echo "Next.js server stopped"
else
    echo "Next.js server is not running (stale PID file)"
    rm -f "$PID_FILE"
fi
