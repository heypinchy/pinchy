#!/bin/bash
set -e

echo "OpenClaw Gateway starting..."

# Ensure gateway auth token exists before starting (prevents crash loop
# when no token is configured yet, e.g. on first startup before setup wizard)
node /ensure-gateway-token.js

# Write gateway token to a separate world-readable file for Pinchy (non-root).
# The main openclaw.json may have restrictive permissions managed by OpenClaw.
node -e "
  const fs = require('fs');
  try {
    const config = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
    const token = config.gateway.auth.token;
    fs.writeFileSync('/root/.openclaw/gateway-token', token, { mode: 0o644 });
  } catch {}
"

# Scan /data/ for available directories and write to shared config
# so Pinchy can read them without needing a /data mount
scan_data_directories() {
  if [ -d /data ]; then
    ls -d /data/*/ 2>/dev/null | sed 's|/$||' | \
      node -e "const lines=require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n').filter(Boolean); \
      const dirs=lines.map(p=>({path:p,name:require('path').basename(p)})); \
      console.log(JSON.stringify({directories:dirs}))" \
      > /root/.openclaw/data-directories.json
  else
    echo '{"directories":[]}' > /root/.openclaw/data-directories.json
  fi
}

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
    scan_data_directories
    openclaw gateway --port 18789 &
    PID=$!
    echo "OpenClaw Gateway running (pid: $PID)"

    # Start auto-approver in the background
    auto_approve_devices &
    APPROVE_PID=$!

    # Wait for config change or process exit.
    # Grace period: OpenClaw rewrites openclaw.json on startup ("Config overwrite"),
    # which would immediately trigger inotifywait and cause a needless restart.
    (sleep 10 && inotifywait -q -e modify /root/.openclaw/openclaw.json) &
    WATCH_PID=$!

    # Wait for either to finish
    wait -n "$PID" "$WATCH_PID" 2>/dev/null || true

    echo "Restarting OpenClaw Gateway..."
    kill "$PID" "$WATCH_PID" "$APPROVE_PID" 2>/dev/null || true
    wait "$PID" "$WATCH_PID" "$APPROVE_PID" 2>/dev/null || true

    sleep 1
done
