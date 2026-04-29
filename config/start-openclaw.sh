#!/bin/bash
set -e

echo "OpenClaw Gateway starting..."

# Path to the secrets file Pinchy writes via writeSecretsFile().
# Lives on tmpfs (volume mode 0770, file mode 0600).
SECRETS_FILE="${OPENCLAW_SECRETS_PATH:-/openclaw-secrets/secrets.json}"

# Load provider API keys from secrets.json into our process env so OpenClaw
# can resolve ${VAR} templates in cfg.env.* and so its built-in providers
# (anthropic, openai, gemini) find their auth via process.env.
#
# Why this exists: OpenClaw's config validator rejects SecretRef objects in
# env.* (only strings allowed), and `${VAR}` templates resolve against the
# OpenClaw process's env — not against any secrets provider. So Pinchy stores
# the real values in secrets.env.<envVar>, this script exports them at start,
# and the config writes ${envVar} placeholders that OpenClaw resolves at use.
load_provider_env_vars() {
    if [ ! -f "$SECRETS_FILE" ]; then
        return 0
    fi
    # Generate `export VAR='value'` lines via node — safer than jq+eval because
    # node handles JSON parsing and we control the shell-escaping ourselves.
    local exports
    exports=$(SECRETS_FILE="$SECRETS_FILE" node -e "
        try {
            const s = JSON.parse(require('fs').readFileSync(process.env.SECRETS_FILE, 'utf8'));
            const env = s.env || {};
            for (const [k, v] of Object.entries(env)) {
                // Strict env-var name allowlist — defense against secrets.json tampering.
                if (typeof v !== 'string' || !/^[A-Z][A-Z0-9_]*\$/.test(k)) continue;
                const escaped = v.replace(/'/g, \"'\\\\''\");
                process.stdout.write(\`export \${k}='\${escaped}'\n\`);
            }
        } catch {}
    " 2>/dev/null || true)
    if [ -n "$exports" ]; then
        eval "$exports"
    fi
}

get_secrets_mtime() {
    [ -f "$SECRETS_FILE" ] && stat -c %Y "$SECRETS_FILE" 2>/dev/null || echo 0
}

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

# Returns 0 (truthy) if every key in secrets.json's env block already matches
# the current process environment, 1 if any value differs. Lets the watch loop
# skip an expensive gateway restart when Pinchy rewrites secrets.json without
# actually changing any provider key (e.g. a Pinchy restart that regenerates
# the same bundle, or any unrelated field flipping the file's mtime).
provider_env_matches_current() {
    [ ! -f "$SECRETS_FILE" ] && return 0
    SECRETS_FILE="$SECRETS_FILE" node -e "
        try {
            const s = JSON.parse(require('fs').readFileSync(process.env.SECRETS_FILE, 'utf8'));
            const env = s.env || {};
            for (const [k, v] of Object.entries(env)) {
                if (typeof v !== 'string' || !/^[A-Z][A-Z0-9_]*\$/.test(k)) continue;
                if (process.env[k] !== v) process.exit(1);
            }
            process.exit(0);
        } catch { process.exit(0); }
    " 2>/dev/null
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

# Ensure gateway auth token exists before starting (prevents crash loop
# when no token is configured yet, e.g. on first startup before setup wizard)
node /ensure-gateway-token.js

# Write gateway token to a separate world-readable file for Pinchy (non-root).
# Pinchy reads this as a fallback when openclaw.json is briefly unavailable.
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
load_provider_env_vars
SECRETS_MTIME=$(get_secrets_mtime)

# OpenClaw rewrites openclaw.json with root-only permissions on every startup
# and internal restart. Run a background loop that keeps fixing permissions.
(while true; do sleep 3; fix_config_permissions; done) &

# Start auto-approver in background — stops when Pinchy signals connection
# (writes pinchy-device-approved). Safety timeout: 5 minutes.
auto_approve_devices &

# Start gateway in the background so the watch loop below can run.
# OpenClaw 2026.4.26 keeps `openclaw gateway` in the foreground (it does NOT
# daemonize), so without `&` the script would block here and the secrets-mtime
# watch loop would never run — provider-key updates wouldn't propagate.
ensure_secrets_root_owned
echo "Starting OpenClaw Gateway..."
openclaw gateway --port 18789 &

# Keep the container alive. Health-check restarts gateway if it crashes.
# Also watches secrets.json mtime: when Pinchy rewrites it (provider key change),
# we kill the gateway so the loop reloads provider env vars and re-execs it.
# Without this, env updates would not propagate without a container restart.
while true; do
    sleep 30

    # Reload env + restart gateway when secrets.json env values actually change.
    # Two cases that matter:
    #   1) Cold start: secrets.json didn't exist when we launched OpenClaw,
    #      then Pinchy wrote it. We need to load env vars AND restart the
    #      running gateway (which has none) so it inherits them.
    #   2) Provider key rotation: a value in secrets.env.* differs from what
    #      our shell already exported.
    # Mtime alone is not enough — Pinchy rewrites secrets.json on every
    # startup and on settings saves that don't touch provider keys, and
    # cascading gateway restarts kill Telegram polling (openclaw#47458).
    # So gate the restart on actual provider-env divergence.
    current_mtime=$(get_secrets_mtime)
    if [ "$current_mtime" != "$SECRETS_MTIME" ] && [ "$current_mtime" != "0" ]; then
        SECRETS_MTIME=$current_mtime
        if provider_env_matches_current; then
            echo "secrets.json mtime changed but provider env unchanged; skipping gateway restart"
        else
            if [ "$SECRETS_MTIME" = "0" ]; then
                echo "secrets.json appeared (cold start), loading provider env vars and restarting gateway"
            else
                echo "secrets.json provider env changed, reloading and restarting gateway"
            fi
            load_provider_env_vars
            ensure_secrets_root_owned
            # Kill the gateway by process name (not saved PID). OpenClaw self-
            # respawns on plugin/config changes (SIGUSR1 full process restart,
            # see "[gateway] restart mode: full process restart"), which makes
            # any saved PID stale. The kernel truncates /proc/<pid>/comm to 15
            # chars, so "openclaw-gatewa" exactly matches the renamed worker.
            pkill -TERM -x openclaw-gatewa 2>/dev/null || true
            sleep 2
        fi
    fi

    if ! (echo > /dev/tcp/127.0.0.1/18789) 2>/dev/null; then
        # Port is down — wait 10s and check again (internal restart takes ~5s)
        sleep 10
        if ! (echo > /dev/tcp/127.0.0.1/18789) 2>/dev/null; then
            echo "OpenClaw Gateway stopped (port 18789 not responding after 10s), restarting..."
            fix_config_permissions
            install_plugin_deps
            scan_data_directories
            load_provider_env_vars
            ensure_secrets_root_owned
            openclaw gateway --port 18789 &
        fi
    fi
done
