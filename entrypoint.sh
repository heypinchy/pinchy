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

echo '[pinchy] Running database migrations...'
su -s /bin/sh pinchy -c 'cd /app/packages/web && pnpm db:migrate'

echo '[pinchy] Starting server...'
exec su -s /bin/sh pinchy -c 'cd /app/packages/web && exec pnpm start'
