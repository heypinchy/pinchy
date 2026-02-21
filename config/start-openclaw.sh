#!/bin/bash
set -e

echo "OpenClaw Gateway starting..."

# Ensure gateway auth token exists before starting (prevents crash loop
# when no token is configured yet, e.g. on first startup before setup wizard)
node /ensure-gateway-token.js

# Auto-approve pending device pairing requests (needed for Docker networking
# where connections come from container IPs, not localhost)
auto_approve_devices() {
    local token
    token=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('/root/.openclaw/openclaw.json','utf8')).gateway.auth.token)}catch{}")
    sleep 5
    while true; do
        openclaw devices approve --latest \
            --url ws://127.0.0.1:18789 \
            --token "$token" 2>/dev/null || true
        sleep 3
    done
}

while true; do
    openclaw gateway --port 18789 &
    PID=$!
    echo "OpenClaw Gateway running (pid: $PID)"

    # Start auto-approver in the background
    auto_approve_devices &
    APPROVE_PID=$!

    # Wait for config change or process exit
    inotifywait -q -e modify /root/.openclaw/openclaw.json &
    WATCH_PID=$!

    # Wait for either to finish
    wait -n "$PID" "$WATCH_PID" 2>/dev/null || true

    echo "Restarting OpenClaw Gateway..."
    kill "$PID" "$WATCH_PID" "$APPROVE_PID" 2>/dev/null || true
    wait "$PID" "$WATCH_PID" "$APPROVE_PID" 2>/dev/null || true

    sleep 1
done
