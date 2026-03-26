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
# where connections come from container IPs, not localhost).
# Stops as soon as Pinchy signals successful connection (writes signal file).
# Running this loop continuously kills Telegram polling because each CLI
# invocation loads the full plugin system.
auto_approve_devices() {
    local token
    token=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('/root/.openclaw/openclaw.json','utf8')).gateway.auth.token)}catch{}")
    # Remove stale signal file from previous run
    rm -f /root/.openclaw/pinchy-device-approved
    sleep 5
    local elapsed=0
    while [ $elapsed -lt 300 ]; do
        # Stop once Pinchy signals successful connection
        if [ -f /root/.openclaw/pinchy-device-approved ]; then
            echo "auto_approve_devices: Pinchy connected, stopping"
            return 0
        fi
        openclaw devices approve --latest \
            --url ws://127.0.0.1:18789 \
            --token "$token" >/dev/null 2>&1 || true
        elapsed=$((elapsed + 5))
        sleep 5
    done
    echo "auto_approve_devices: safety timeout (5min), stopping"
}

install_plugin_deps
scan_data_directories

# OpenClaw rewrites openclaw.json with root-only permissions on every startup
# and internal restart. Run a background loop that keeps fixing permissions.
(while true; do sleep 3; fix_config_permissions; done) &

# Start auto-approver in background — stops when Pinchy signals connection
# (writes pinchy-device-approved). Safety timeout: 5 minutes.
auto_approve_devices &

# Start gateway. The `openclaw gateway` command daemonizes — it spawns the
# actual gateway process and exits immediately. In a container there's no
# systemd, so we supervise via a health-check loop instead of `wait`.
echo "Starting OpenClaw Gateway..."
openclaw gateway --port 18789 || true

# Keep the container alive. Health-check restarts gateway if it crashes.
# Double-check with a delay to avoid interfering with OpenClaw's internal
# SIGUSR1 restarts (port is briefly unavailable during restart).
while true; do
    sleep 30
    if ! (echo > /dev/tcp/127.0.0.1/18789) 2>/dev/null; then
        # Port is down — wait 10s and check again (internal restart takes ~5s)
        sleep 10
        if ! (echo > /dev/tcp/127.0.0.1/18789) 2>/dev/null; then
            echo "OpenClaw Gateway stopped (port 18789 not responding after 10s), restarting..."
            fix_config_permissions
            install_plugin_deps
            scan_data_directories
            openclaw gateway --port 18789 || true
        fi
    fi
done
