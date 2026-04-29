#!/bin/sh
set -e

# Fix permissions on shared OpenClaw config volume.
# OpenClaw runs as root and owns these files; Pinchy needs write access
# to update openclaw.json when providers or agents change.
chown -R pinchy:pinchy /openclaw-config

# Give pinchy user ownership of the secrets tmpfs so it can read/write
# secrets.json. The tmpfs is initially owned by root (or uid=1000 per the
# volume driver opts); ensure the pinchy user is the directory owner so
# it can enter the directory and rename files atomically.
chown pinchy:pinchy /openclaw-secrets 2>/dev/null || true

echo '[pinchy] Running database migrations...'
su -s /bin/sh pinchy -c 'cd /app/packages/web && pnpm db:migrate'

echo '[pinchy] Starting server...'
exec su -s /bin/sh pinchy -c 'cd /app/packages/web && exec pnpm start'
