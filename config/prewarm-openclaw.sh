#!/bin/bash
# Pre-warm the bundled-plugin runtime-deps cache for the OpenClaw image.
#
# OpenClaw 2026.4.x runs `npm install` of ~15 packages into
# /root/.openclaw/plugin-runtime-deps/<openclaw-version>-<hash>/ on the
# first gateway boot. On a 2-vCPU host this took ~48 s, blocking the
# gateway HTTP listener and stalling Pinchy's first sessions.list /
# chat.history calls.
#
# We do that install at image build time by booting the gateway once
# with a minimal allow-listed config (browser/memory-core/talk-voice
# only — see ../packages/web/src/lib/openclaw-config/build.ts for why
# we disable acpx/bonjour/device-pair/phone-control) so OpenClaw
# materializes only the deps Pinchy actually needs. After the cache is
# built we kill the gateway and strip every other build-artefact under
# /root/.openclaw — only plugin-runtime-deps/ survives into the image.
#
# On first user start, Docker populates the openclaw-config named
# volume from this image (volumes inherit image contents only when
# empty), giving the warm cache to fresh installs without leaking the
# prewarm gateway-token, devices/, or agents/ state.
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

# Give plugin loading a beat to settle past the listening-but-not-quite-
# ready window before we tear down. Two seconds is plenty in practice
# (CI prewarm typically completes in 5-15 s total).
sleep 2

kill "$gw_pid" 2>/dev/null || true
wait "$gw_pid" 2>/dev/null || true
echo "[prewarm] gateway stopped"

# Strip everything except the runtime-deps cache. Pinchy regenerates
# openclaw.json on first boot via regenerateOpenClawConfig(); leaving
# the prewarm token / devices / agents state behind would either leak
# build-time secrets into runtime or confuse the cold-start cascade.
find /root/.openclaw -mindepth 1 -maxdepth 1 \
  ! -name plugin-runtime-deps -exec rm -rf {} +
rm -f /tmp/prewarm.log

if ! ls -d /root/.openclaw/plugin-runtime-deps/openclaw-* >/dev/null 2>&1; then
  echo "[prewarm] FATAL: plugin-runtime-deps cache was not produced"
  exit 1
fi

du -sh /root/.openclaw/plugin-runtime-deps/openclaw-*/
