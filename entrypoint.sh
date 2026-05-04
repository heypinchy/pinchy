#!/bin/sh
set -e

# Fix permissions on shared OpenClaw config volume.
# OpenClaw runs as root and owns these files; Pinchy needs write access
# to update openclaw.json when providers or agents change.
chown -R pinchy:pinchy /openclaw-config
# Belt-and-suspenders: ensure pinchy can stat AND write the directory itself.
# The Dockerfile mkdir -p creates /openclaw-config as root:0755; chown -R fixes
# ownership but the directory mode is not always 0755 in fresh CI volumes.
chmod 0755 /openclaw-config
echo "[entrypoint] /openclaw-config: $(stat -c '%U:%G %a' /openclaw-config)"

# Seed a minimal openclaw.json if the volume doesn't have one yet.
# On main, openclaw started first and Docker copied the seed from the image.
# Now that pinchy starts first (healthcheck dependency), pinchy mounts the
# volume before openclaw does — Docker won't copy the image files into an
# already-mounted volume, so openclaw.json would be missing and OpenClaw
# would say "Missing config" in a restart loop.
if [ ! -f /openclaw-config/openclaw.json ]; then
  printf '{"gateway":{"mode":"local","bind":"lan"}}\n' > /openclaw-config/openclaw.json
fi

# Give pinchy user ownership of the secrets tmpfs so it can read/write
# secrets.json. The tmpfs is initially owned by root (or uid=1000 per the
# volume driver opts); ensure the pinchy user is the directory owner so
# it can enter the directory and rename files atomically.
chown pinchy:pinchy /openclaw-secrets 2>/dev/null || true

# Refresh plugin directories on every startup. The named Docker volume
# (openclaw-extensions) is only initialised from the image on first creation;
# subsequent upgrades leave stale content from the previous image.
#
# Critically idempotent: we only re-copy a plugin if its directory is missing
# or differs from the image. Untouched files mean no spurious inotify events
# for OpenClaw's plugin watcher (which would otherwise cause it to re-init the
# plugin runtime on every container start, blocking the event loop for tens
# of seconds — see Telegram E2E investigation for the failure mode).
for plugin_src in /app/pinchy-plugins/*/; do
  plugin_name=$(basename "$plugin_src")
  plugin_dst="/openclaw-extensions/$plugin_name"
  if [ ! -d "$plugin_dst" ] || ! diff -rq "$plugin_src" "$plugin_dst" >/dev/null 2>&1; then
    rm -rf "$plugin_dst"
    cp -r "$plugin_src" "$plugin_dst"
    echo "[entrypoint] synced plugin: $plugin_name"
  fi
done

# Verify every Pinchy plugin shipped in the image landed in the shared
# extensions volume. If a Dockerfile.pinchy COPY line is missing, OpenClaw
# silently logs "plugin not found" and the agent's tools vanish at runtime —
# we fail loud here instead. List MUST stay in sync with KNOWN_PINCHY_PLUGINS
# in packages/web/src/lib/openclaw-config/plugin-manifest-loader.ts; drift is
# caught by entrypoint-runtime-check.test.ts.
EXPECTED_PLUGINS="pinchy-files pinchy-context pinchy-audit pinchy-docs pinchy-email pinchy-odoo pinchy-web"
MISSING=""
for plugin in $EXPECTED_PLUGINS; do
  if [ ! -d "/openclaw-extensions/$plugin" ]; then
    MISSING="$MISSING $plugin"
  fi
done
if [ -n "$MISSING" ]; then
  echo "[entrypoint] FATAL: missing plugin directories in /openclaw-extensions/:$MISSING"
  echo "[entrypoint] check Dockerfile.pinchy COPY lines and the shared volume mount"
  exit 1
fi
echo "[entrypoint] all Pinchy plugins present in /openclaw-extensions/"

echo '[pinchy] Running database migrations...'
su -s /bin/sh pinchy -c 'cd /app/packages/web && pnpm db:migrate'

echo '[pinchy] Starting server...'
exec su -s /bin/sh pinchy -c 'cd /app/packages/web && exec pnpm start'
