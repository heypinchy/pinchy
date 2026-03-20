#!/bin/bash
set -e

echo "OpenClaw Gateway starting..."

# Install pinchy-files plugin dependencies from the container image.
# In dev mode, source files are volume-mounted from the host, but host
# node_modules contain macOS native bindings that won't work in Linux.
# This runs before every gateway start (including restarts after config changes).
install_plugin_deps() {
    if [ -d /opt/pinchy-files-deps/node_modules ] && [ -d /root/.openclaw/extensions/pinchy-files ]; then
        rm -rf /root/.openclaw/extensions/pinchy-files/node_modules
        cp -r /opt/pinchy-files-deps/node_modules /root/.openclaw/extensions/pinchy-files/node_modules
    fi
}

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

# Make OpenClaw config writable by Pinchy (non-root).
# OpenClaw creates openclaw.json with 600 (root-only). Pinchy needs write access
# to update provider keys and agent configuration via regenerateOpenClawConfig().
fix_config_permissions() {
    chmod 666 /root/.openclaw/openclaw.json 2>/dev/null || true
}
fix_config_permissions

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
    install_plugin_deps
    scan_data_directories
    openclaw gateway --port 18789 &
    PID=$!
    echo "OpenClaw Gateway running (pid: $PID)"

    # OpenClaw rewrites openclaw.json on startup with root-only permissions.
    # Wait briefly, then fix permissions so Pinchy can write to it.
    (sleep 3 && fix_config_permissions) &

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
