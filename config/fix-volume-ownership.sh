#!/bin/sh
# Ownership repair for the shared `openclaw-config` volume, run by the pinchy
# container's entrypoint before it drops privileges. Extracted from entrypoint.sh
# (same pattern as config/sync-plugins.sh) so the one path it must NOT repair is
# unit-testable — see packages/web/src/__tests__/lib/fix-volume-ownership.test.ts.
#
# OpenClaw runs as root and creates most of this volume; Pinchy runs as uid 999
# and needs write access to openclaw.json, agents/, credentials/ and the rest. So
# the entrypoint takes ownership of the volume, because only root can chown and
# this is the last moment in the boot where the pinchy container still is root.
#
# EXCEPT npm/, and that exception is the whole reason this file exists (#1196).
# That directory is OpenClaw's plugin store — it holds the bundled llama.cpp
# embedding provider — and OpenClaw's loader refuses a candidate whose files are
# not root-owned:
#
#   plugins.allow: plugin llama-cpp: blocked plugin candidate: suspicious
#   ownership (/root/.openclaw/npm/projects/openclaw-llama-cpp-provider-…,
#   uid=999, expected uid=0 or root)
#
# The blanket `chown -R pinchy:pinchy /openclaw-config` this replaces swept npm/
# up with everything else — /openclaw-config and openclaw's /root/.openclaw are
# the same volume, and npm/ has no sub-mount of its own — so on production the
# provider sat permanently blocked and every memory_search answered "Unknown
# memory embedding provider: local."
#
# Repairing it on the OpenClaw side alone is not enough, which is why the prune
# is here rather than only in config/stage-llama-cpp-provider.sh: that repair
# runs at OpenClaw CONTAINER boot, and docker-compose.yml declares
# `openclaw: depends_on: pinchy: service_healthy`. A pinchy-only restart — an OOM
# under `mem_limit: 1g`, a redeploy, `restart: unless-stopped` after a crash —
# would otherwise re-break the tree while OpenClaw keeps running, with nothing
# left to repair it until the openclaw container itself restarts. Pinchy never
# reads or writes anything under npm/, so pruning it costs nothing.
#
# `! -uid` gates the chown so an already-correct tree is left alone. Same
# reasoning as config/fix-config-permissions.sh: this volume carries
# agents/<id>/sessions and workspaces/ with unbounded file counts, and chown
# rewrites ctime — which OpenClaw's session-takeover detector reads as external
# modification. The gate is on the uid only, so a file that is already
# pinchy-owned keeps whatever group it has; ownership is what grants the write,
# and root ignores group bits anyway.
#
# Paths and the target uid are env-overridable so the unit test can drive the
# real script against temp dirs; production uses the defaults.
set -e

# Trailing slash stripped so the -path prune below matches what find prints.
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-/openclaw-config}"
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR%/}"
# The pinchy user inside the Pinchy container (Dockerfile.pinchy: useradd -u 999).
PINCHY_UID="${PINCHY_UID:-999}"
PINCHY_GID="${PINCHY_GID:-999}"

find "$OPENCLAW_CONFIG_DIR" -path "$OPENCLAW_CONFIG_DIR/npm" -prune -o \
    ! -uid "$PINCHY_UID" -exec chown "$PINCHY_UID:$PINCHY_GID" {} + 2>/dev/null || true

# Belt-and-suspenders: ensure pinchy can stat AND write the directory itself.
# The Dockerfile mkdir -p creates /openclaw-config as root:0755; the chown above
# fixes ownership but the directory mode is not always 0755 in fresh CI volumes.
chmod 0755 "$OPENCLAW_CONFIG_DIR"
echo "[entrypoint] $OPENCLAW_CONFIG_DIR: $(stat -c '%U:%G %a' "$OPENCLAW_CONFIG_DIR" 2>/dev/null || echo 'stat-failed')"
