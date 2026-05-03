#!/bin/bash
set -e

echo "OpenClaw Gateway starting..."

# Path to the secrets file Pinchy writes via writeSecretsFile().
# Lives on tmpfs (volume mode 0770, file mode 0600).
SECRETS_FILE="${OPENCLAW_SECRETS_PATH:-/openclaw-secrets/secrets.json}"

# Pinchy writes secrets.json as a non-root user (uid 999 in production where
# the pinchy container drops privileges, or the test runner's uid in CI
# integration tests). OpenClaw's secrets-file resolver checks that the file's
# owner equals the reading process's uid (root, here) and rejects any
# cross-uid arrangement.
#
# In OpenClaw 2026.4.12, the json-schema for file-source providers does NOT
# accept the `allowInsecurePath` flag (the flag exists in the resolver code
# and the exec-source schema, but file-source has additionalProperties: false
# and rejects it). The only way to make 2026.4.12 read a Pinchy-owned
# secrets.json is to chown the file before each gateway start/reload — which
# this script can do because it runs as root.
#
# The directory's mode (0770, owner 999) means Pinchy's atomic temp+rename
# in writeSecretsFile() still works after we chown the resulting file: rename
# is a directory-level operation. Pinchy replaces the file → file flips back
# to 999-owned → mtime watcher detects → this script chowns again before the
# next gateway boot.
ensure_secrets_root_owned() {
    if [ ! -f "$SECRETS_FILE" ]; then
        echo "[secrets-fix] $SECRETS_FILE does not exist, skipping"
        return 0
    fi
    local before
    before=$(stat -c "%U:%G %a" "$SECRETS_FILE" 2>/dev/null || echo "stat-failed")
    # Fix BOTH ownership and mode. Ownership: OpenClaw's resolver requires
    # file owner == process uid (root). Mode: OpenClaw's resolver also
    # rejects group/world readable as "permissions are too open" — even
    # mode 0644 (default rw-r--r-- on most umasks) trips this. Pinchy's
    # writeFileSync says { mode: 0o600 } but on bind-mounted volumes
    # in CI the resulting file ends up 0644 anyway (likely Node honoring
    # the host umask over the explicit mode option for non-newly-created
    # paths after rename). chmod 0600 here defensively.
    chown root:root "$SECRETS_FILE" 2>/dev/null || true
    chmod 0600 "$SECRETS_FILE" 2>/dev/null || true
    local after
    after=$(stat -c "%U:%G %a" "$SECRETS_FILE" 2>/dev/null || echo "stat-failed")
    echo "[secrets-fix] $SECRETS_FILE: $before -> $after"
}

# Install pinchy-files plugin dependencies from the container image.
# In dev mode, source files are volume-mounted from the host, but host
# node_modules contain macOS native bindings that won't work in Linux.
# This runs before every gateway start (including restarts after config changes).
install_plugin_deps() {
    if [ -d /opt/pinchy-files-deps/node_modules ] && [ -d /root/.openclaw/extensions/pinchy-files ]; then
        rm -rf /root/.openclaw/extensions/pinchy-files/node_modules
        cp -r /opt/pinchy-files-deps/node_modules /root/.openclaw/extensions/pinchy-files/node_modules
    fi
    if [ -d /opt/pinchy-odoo-deps/node_modules ] && [ -d /root/.openclaw/extensions/pinchy-odoo ]; then
        rm -rf /root/.openclaw/extensions/pinchy-odoo/node_modules
        cp -r /opt/pinchy-odoo-deps/node_modules /root/.openclaw/extensions/pinchy-odoo/node_modules
    fi
    if [ -d /opt/pinchy-web-deps/node_modules ] && [ -d /root/.openclaw/extensions/pinchy-web ]; then
        rm -rf /root/.openclaw/extensions/pinchy-web/node_modules
        cp -r /opt/pinchy-web-deps/node_modules /root/.openclaw/extensions/pinchy-web/node_modules
    fi
    if [ -d /opt/pinchy-email-deps/node_modules ] && [ -d /root/.openclaw/extensions/pinchy-email ]; then
        rm -rf /root/.openclaw/extensions/pinchy-email/node_modules
        cp -r /opt/pinchy-email-deps/node_modules /root/.openclaw/extensions/pinchy-email/node_modules
    fi
}

# Fix plugin ownership — bind-mounted plugin files from the host may have
# a different UID than root, causing OpenClaw to block them as "suspicious".
if [ -d /root/.openclaw/extensions ]; then
    chown -R root:root /root/.openclaw/extensions 2>/dev/null || true
fi


# Make OpenClaw config writable by Pinchy (non-root).
# OpenClaw creates openclaw.json with 600 (root-only). Pinchy needs write access
# to update provider keys and agent configuration via regenerateOpenClawConfig().
#
# Also fix the telegram-pairing.json file: OpenClaw 2026.4.12 writes it as
# root:0600, but Pinchy (uid 999) needs to read it to look up Telegram user
# IDs from pairing codes. Without this chmod, every linkTelegram POST returns
# "Invalid or expired pairing code" because readFileSync throws EACCES inside
# resolvePairingCode and the bare catch returns { found: false } silently.
fix_config_permissions() {
    chmod 666 /root/.openclaw/openclaw.json 2>/dev/null || true
    # Use a glob so we also catch any sibling credential files OpenClaw
    # writes alongside the pairing file (allowFrom stores etc.) — they too
    # are written by root and consumed by Pinchy.
    # a+rX: r for all files, x only for directories (capital X) so uid 999
    # can both enter the credentials/ dir (exec bit) and read files inside it.
    chmod -R a+rX /root/.openclaw/credentials 2>/dev/null || true
    # Re-take ownership of secrets.json. Pinchy writes it as uid 999 (the
    # pinchy user inside its container); OpenClaw's secret-resolver requires
    # owner == process uid (root) and refuses to reload otherwise. The 30 s
    # mtime watch loop further down chowns it after a write, but the [reload]
    # pipeline triggered by inotify on openclaw.json fires within ~100 ms of
    # Pinchy's regenerateOpenClawConfig() — long before that loop wakes up.
    # Without this fast tick, a freshly created agent surfaces as
    # `unknown agent id` because the reload fails on secrets and the new
    # agents.list never enters runtime. See issue #200.
    if [ -f "$SECRETS_FILE" ]; then
        chown root:root "$SECRETS_FILE" 2>/dev/null || true
        chmod 0600 "$SECRETS_FILE" 2>/dev/null || true
    fi
    # Per-agent auth-profiles.json files written by Pinchy (uid 999).
    # OpenClaw (root) can read uid-999-owned files directly — no chown needed.
    # The agents/ directory must stay writable by Pinchy (uid 999) so new
    # agent subdirectories can be created. Only secure the files themselves.
    chown 999:999 /root/.openclaw/agents 2>/dev/null || true
    find /root/.openclaw/agents -name "auth-profiles.json" -type f -exec chmod 0600 {} \; 2>/dev/null || true
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
        # Re-read the token on every iteration: the gateway generates its own
        # token at first startup when the config has no token (e.g. our minimal
        # seed config), so the token doesn't exist yet when this function starts.
        # Reading once at the top missed this write and left `token` empty for
        # the entire loop, causing every `openclaw devices approve` call to fail.
        local token
        token=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('/root/.openclaw/openclaw.json','utf8')).gateway.auth.token)}catch{}")
        if [ -z "$token" ]; then
            elapsed=$((elapsed + 5))
            sleep 5
            continue
        fi
        # `openclaw devices approve --latest` is preview-only since 2026.4.10.
        # It prints the requestId but exits with code 1 without approving.
        # We parse the requestId from the output and approve explicitly.
        local approve_output request_id
        approve_output=$(openclaw devices approve --latest \
            --url ws://127.0.0.1:18789 \
            --token "$token" 2>&1 || true)
        request_id=$(echo "$approve_output" | grep -oE 'openclaw devices approve [a-zA-Z0-9_=-]+' | awk '{print $NF}' || true)
        if [ -n "$request_id" ]; then
            openclaw devices approve "$request_id" \
                --url ws://127.0.0.1:18789 \
                --token "$token" >/dev/null 2>&1 || true
        fi
        elapsed=$((elapsed + 5))
        sleep 5
    done
    echo "auto_approve_devices: safety timeout (5min), stopping"
}

install_plugin_deps
scan_data_directories

# OpenClaw rewrites openclaw.json with root-only permissions on every startup
# and internal restart. Run a tight background loop that fixes permissions
# faster than Pinchy can hit the EACCES window. 0.2s tick keeps the worst
# case under 250ms — comfortably inside Pinchy's readExistingConfig retry
# budget (5 × 100ms). Was 3s previously, which let Pinchy give up before
# the chmod caught up and silently wrote a stripped config (see
# fix(openclaw-config): guard targeted writes against EACCES read).
(while true; do sleep 0.2; fix_config_permissions; done) &

# Defense in depth for the secrets owner race (#200): the 0.2 s tick above
# averages ~100 ms behind a Pinchy write, but OpenClaw's inotify-driven
# reload pipeline also fires within ~50–100 ms — leaving a small window
# where the reload sees uid 999 and bails with SECRETS_RELOADER_DEGRADED.
# inotifywait reacts within a handful of milliseconds to Pinchy's atomic
# rename, closing the window before any reload can pick up the bad owner.
# Watches the directory (not the file) because Pinchy's writeSecretsFile
# uses tmp+rename, which replaces the inode each time.
#
# Wrapped in a respawn loop: inotifywait can die if the kernel watch limit
# (fs.inotify.max_user_watches) is exhausted or the binary OOMs. Without
# this loop the secrets file would be defended only by the 0.2 s chmod
# tick — still safer than nothing, but the tighter inotify response is the
# primary guarantee. The 1 s sleep prevents a tight crash loop from
# burning CPU if inotifywait fails to start at all.
(while true; do
    inotifywait -m -q -e close_write,moved_to "$(dirname "$SECRETS_FILE")" 2>/dev/null | \
        while read -r _dir _events filename; do
            # Only react to the secrets file itself, ignoring sibling .tmp writes
            # and any other unrelated activity in the directory.
            if [ "$filename" = "$(basename "$SECRETS_FILE")" ]; then
                chown root:root "$SECRETS_FILE" 2>/dev/null || true
                chmod 0600 "$SECRETS_FILE" 2>/dev/null || true
            fi
        done
    echo "[secrets-watcher] inotifywait exited; respawning in 1s"
    sleep 1
done) &

# Start auto-approver in background — stops when Pinchy signals connection
# (writes pinchy-device-approved). Safety timeout: 5 minutes.
auto_approve_devices &

# Start gateway in the background so the health-check loop below can run.
# OpenClaw 2026.4.26 keeps `openclaw gateway` in the foreground (it does NOT
# daemonize), so without `&` the script would block here and the loop below
# would never run — a crashed gateway would never get restarted.
ensure_secrets_root_owned
echo "Starting OpenClaw Gateway..."
openclaw gateway --port 18789 &

# Keep the container alive. Health-check restarts gateway if it crashes.
# Provider API keys are resolved live from secrets.json via SecretRef —
# no env-export or gateway restart needed on key rotation.
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
            ensure_secrets_root_owned
            openclaw gateway --port 18789 &
        fi
    fi
done
