#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO_DIR="$SCRIPT_DIR/server-deno"
PID_FILE="$DENO_DIR/deno.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "Deno server is not running (no PID file found)"
    exit 1
fi

PID=$(cat "$PID_FILE")

if ps -p "$PID" > /dev/null 2>&1; then
    echo "Stopping Deno server (PID: $PID)..."
    kill "$PID"
    sleep 1

    # Force kill if still running
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Force killing..."
        kill -9 "$PID"
    fi

    rm -f "$PID_FILE"
    echo "Deno server stopped"
else
    echo "Deno server is not running (stale PID file)"
    rm -f "$PID_FILE"
fi
