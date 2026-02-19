#!/bin/bash
set -e

echo "OpenClaw Gateway starting..."

while true; do
    openclaw gateway --port 18789 &
    PID=$!
    echo "OpenClaw Gateway running (pid: $PID)"

    # Wait for config change or process exit
    inotifywait -q -e modify /root/.openclaw/openclaw.json &
    WATCH_PID=$!

    # Wait for either to finish
    wait -n "$PID" "$WATCH_PID" 2>/dev/null || true

    echo "Restarting OpenClaw Gateway..."
    kill "$PID" "$WATCH_PID" 2>/dev/null || true
    wait "$PID" "$WATCH_PID" 2>/dev/null || true

    sleep 1
done
