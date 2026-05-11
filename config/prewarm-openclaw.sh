#!/bin/bash
# Pre-warm the OpenClaw image — validates gateway startup and populates
# any internal caches created on first boot.
#
# OpenClaw 2026.4.x ran `npm install` of ~15 packages into
# /root/.openclaw/plugin-runtime-deps/<openclaw-version>-<hash>/ on the
# first gateway boot. On a 2-vCPU host this took ~48 s, blocking the
# gateway HTTP listener and stalling Pinchy's first sessions.list /
# chat.history calls. This prewarm pre-populated that cache at image
# build time so production containers started fast.
#
# OpenClaw 2026.5.x removed the plugin-runtime-deps directory entirely,
# adopting a symlink-backed approach during npm postinstall instead. The
# per-boot npm install is gone, so the startup cost is now negligible.
# The prewarm boot still serves two purposes in 5.x:
#   1. Validates that the gateway binary starts correctly inside our image.
#   2. Pre-generates /root/.openclaw state (identity, logs/, tasks/) that
#      the named volume can inherit so fresh installs skip first-boot setup.
#
# bash explicit because we use `/dev/tcp/...` to wait for the gateway
# port; on debian-slim `RUN` uses dash by default, which has no
# /dev/tcp emulation and would silently never see the port open.
set -euo pipefail

PREWARM_CONFIG="${1:?usage: $0 <prewarm-config-path>}"
GATEWAY_PORT=18789
READY_TIMEOUT_S=180

mkdir -p /root/.openclaw
cp "$PREWARM_CONFIG" /root/.openclaw/openclaw.json

openclaw gateway --port "$GATEWAY_PORT" >/tmp/prewarm.log 2>&1 &
gw_pid=$!

ready=0
for i in $(seq 1 "$READY_TIMEOUT_S"); do
  if (echo > "/dev/tcp/127.0.0.1/$GATEWAY_PORT") 2>/dev/null; then
    ready=1
    echo "[prewarm] gateway ready after ${i}s"
    break
  fi
  sleep 1
done

if [ "$ready" = "0" ]; then
  echo "[prewarm] gateway did not come up in ${READY_TIMEOUT_S}s; log tail:"
  tail -60 /tmp/prewarm.log
  kill "$gw_pid" 2>/dev/null || true
  exit 1
fi

# Give the gateway a brief moment to settle past the listening-but-not-
# quite-ready window before we tear down.
sleep 2

kill "$gw_pid" 2>/dev/null || true
wait "$gw_pid" 2>/dev/null || true
echo "[prewarm] gateway stopped"

# Strip all prewarm build-time artifacts. Pinchy regenerates openclaw.json
# on first boot via regenerateOpenClawConfig(); leaving the prewarm token,
# devices/, or agents/ state behind would either leak build-time secrets or
# confuse the cold-start cascade.
#
# OpenClaw 4.x: preserve plugin-runtime-deps/ (the prewarm populated it).
# OpenClaw 5.x: no plugin-runtime-deps/ exists — the symlink-based model
#   means nothing to preserve; clean up everything and move on.
if ls -d /root/.openclaw/plugin-runtime-deps/openclaw-* >/dev/null 2>&1; then
  echo "[prewarm] plugin-runtime-deps cache produced (OC 4.x path)"
  find /root/.openclaw -mindepth 1 -maxdepth 1 \
    ! -name plugin-runtime-deps -exec rm -rf {} +
  du -sh /root/.openclaw/plugin-runtime-deps/openclaw-*/
else
  echo "[prewarm] plugin-runtime-deps not present (expected for OC 5.x+ — symlink model)"
  rm -rf /root/.openclaw
fi

rm -f /tmp/prewarm.log
