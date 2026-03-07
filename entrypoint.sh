#!/bin/sh
set -e

# Fix permissions on shared OpenClaw config volume.
# OpenClaw runs as root and owns these files; Pinchy needs write access
# to update openclaw.json when providers or agents change.
chown -R pinchy:pinchy /openclaw-config

echo '[pinchy] Running database migrations...'
su -s /bin/sh pinchy -c 'cd /app/packages/web && pnpm db:migrate'

echo '[pinchy] Starting server...'
exec su -s /bin/sh pinchy -c 'cd /app/packages/web && exec pnpm start'
