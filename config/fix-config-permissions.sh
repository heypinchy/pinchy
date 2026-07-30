#!/bin/bash
# Cross-uid permission repair for the shared `openclaw-config` volume, extracted
# from start-openclaw.sh (same pattern as install-plugin-deps.sh and
# stage-llama-cpp-provider.sh) so its invariants are unit-testable — see
# packages/web/src/__tests__/lib/fix-config-permissions.test.ts.
#
# Two containers share this volume: OpenClaw mounts it at /root/.openclaw and
# runs as root, Pinchy mounts it at /openclaw-config and runs as uid 999. Only
# root can chown, so this script — running in the OpenClaw container — is the
# only place in the stack that can repair cross-uid state. start-openclaw.sh
# calls it on every gateway start AND on a 50 ms background tick, because
# OpenClaw rewrites these paths on every internal reload.
#
# Paths and the target uid are env-overridable so the unit test can drive the
# real function against temp dirs; production uses the defaults.

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/root/.openclaw}"
SECRETS_FILE="${SECRETS_FILE:-${OPENCLAW_SECRETS_PATH:-/openclaw-secrets/secrets.json}}"
# The pinchy user inside the Pinchy container (Dockerfile.pinchy: useradd -u 999).
PINCHY_UID="${PINCHY_UID:-999}"
PINCHY_GID="${PINCHY_GID:-999}"

fix_config_permissions() {
    chmod 666 "$OPENCLAW_STATE_DIR/openclaw.json" 2>/dev/null || true
    # Use a glob so we also catch any sibling credential files OpenClaw
    # writes alongside the pairing file (allowFrom stores etc.) — they too
    # are written by root and consumed by Pinchy.
    # a+rX: r for all files, x only for directories (capital X) so uid 999
    # can both enter the credentials/ dir (exec bit) and read files inside it.
    chmod -R a+rX "$OPENCLAW_STATE_DIR/credentials" 2>/dev/null || true
    # Re-take ownership of secrets.json. Pinchy writes it as uid 999 (the
    # pinchy user inside its container); OpenClaw's secret-resolver requires
    # owner == process uid (root) and refuses to reload otherwise. The 30 s
    # mtime watch loop in start-openclaw.sh further chowns it after a write,
    # but the [reload] pipeline triggered by inotify on openclaw.json fires
    # within ~100 ms of Pinchy's regenerateOpenClawConfig() — long before that
    # loop wakes up. Without this fast tick, a freshly created agent surfaces
    # as `unknown agent id` because the reload fails on secrets and the new
    # agents.list never enters runtime. See issue #200.
    if [ -f "$SECRETS_FILE" ]; then
        chown root:root "$SECRETS_FILE" 2>/dev/null || true
        chmod 0600 "$SECRETS_FILE" 2>/dev/null || true
    fi

    # Per-agent auth-profiles.json files are written by Pinchy (uid 999) into
    # agents/<id>/agent/. OpenClaw (root) reads uid-999-owned files fine, so the
    # files themselves only need tightening — but the DIRECTORIES have to be
    # pinchy-OWNED, and that is the whole of issue #934.
    #
    # The trap: agents/<id>/agent is not exclusively Pinchy's. OpenClaw derives
    # each agent's models.json there, creating the directory with
    # `mkdir(…, { mode: 0o700 })` and then re-asserting 0700 on every subsequent
    # write (its `enforcePrivatePathMode` chmods and verifies). So whoever gets
    # there first sets the owner:
    #
    #   Pinchy first → 999-owned, and OpenClaw's 0700 reads as "pinchy rwx".
    #                  Both sides keep working; root ignores mode bits anyway.
    #   OpenClaw first → root-owned 0700, and Pinchy is locked out FOREVER.
    #                  writeAgentAuthProfiles() gets EACCES, which aborts
    #                  regenerateOpenClawConfig() before it pushes openclaw.json,
    #                  so OpenClaw never learns the provider and every dispatch
    #                  dies with `Unknown model: <provider>/<model>`. What the
    #                  user sees is that Smithers stopped answering.
    #
    # This used to chown only the agents/ root, on the reasoning that Pinchy
    # creates the subdirectories itself — true only when Pinchy wins the race.
    # Repairing the MODE cannot substitute: OpenClaw undoes it on the next
    # models.json write, and root-owned 0755 still denies uid 999 the write.
    # Ownership is the only durable lever.
    #
    # `! -uid` gates the chown so an already-correct directory is left alone:
    # chown rewrites ctime, and OpenClaw's session-takeover detector reads a
    # ctime change as external modification (same reason the `-not -perm` gates
    # below exist). At a 50 ms tick an ungated chown would be ~20 ctime bumps a
    # second, per agent, forever.
    #
    # -maxdepth 1 covers the agents/ root (so new agent dirs can be created) and
    # agents/<id>; the second find covers exactly agents/<id>/agent.
    find "$OPENCLAW_STATE_DIR/agents" -maxdepth 1 -type d ! -uid "$PINCHY_UID" \
        -exec chown "$PINCHY_UID:$PINCHY_GID" {} \; 2>/dev/null || true
    find "$OPENCLAW_STATE_DIR/agents" -mindepth 2 -maxdepth 2 -type d -name agent ! -uid "$PINCHY_UID" \
        -exec chown "$PINCHY_UID:$PINCHY_GID" {} \; 2>/dev/null || true
    find "$OPENCLAW_STATE_DIR/agents" -name "auth-profiles.json" -type f -not -perm 0600 \
        -exec chmod 0600 {} \; 2>/dev/null || true

    # Cross-uid read access for Pinchy's self-service diagnostics export.
    # OpenClaw writes per-agent sessions.json and *.trajectory.jsonl as root
    # under agents/<agentId>/sessions/ — with default umask these emerge
    # 0644/0755, but OpenClaw 2026.5.x ships with a tighter umask that
    # produces 0600/0700, so Pinchy (uid 999) gets EACCES on the dir traversal.
    # Diagnostics is read-only against these files; 0755/0644 is sufficient.
    # The 50 ms tick catches runtime-created sessions (same pattern as the
    # openclaw.json mode race).
    #
    # `-not -perm` gates: skip files that already have the right mode. chmod
    # would otherwise rewrite the inode's ctime on every tick, and OpenClaw's
    # embedded-prompt session-takeover detector treats any ctime change as
    # "session file modified externally" and aborts the in-flight turn with
    # EmbeddedAttemptSessionTakeoverError. Without the gate, every chat turn
    # races our 50 ms loop against the assistant's response.
    find "$OPENCLAW_STATE_DIR/agents" -mindepth 1 -maxdepth 1 -type d -not -perm 0755 -exec chmod 0755 {} \; 2>/dev/null || true
    find "$OPENCLAW_STATE_DIR/agents" -type d -name sessions -not -perm 0755 -exec chmod 0755 {} \; 2>/dev/null || true
    find "$OPENCLAW_STATE_DIR/agents" \( -name "sessions.json" -o -name "*.trajectory.jsonl" \) -type f -not -perm 0644 -exec chmod 0644 {} \; 2>/dev/null || true
}
