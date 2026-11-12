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
# OpenClaw runs as root; overridable only so the test can stand in for root.
OPENCLAW_UID="${OPENCLAW_UID:-0}"

fix_config_permissions() {
    # Gated like the `-not -perm` repairs below, for a stronger reason than
    # ctime alone. OpenClaw 2026.9 watches openclaw.json with a 300 ms debounce
    # that every event restarts, attribute events included, and on Linux a chmod
    # to the mode the file already has is still one. Ungated, this line fired
    # every 50 ms, so the debounce never elapsed: a config Pinchy wrote to the
    # file (the fallback for a change config.apply refuses, such as retiring the
    # implicit `main` agent on a fresh install) was never reloaded, and every
    # later config.apply failed "config changed since last load".
    find "$OPENCLAW_STATE_DIR/openclaw.json" -maxdepth 0 -type f -not -perm 0666 \
        -exec chmod 666 {} \; 2>/dev/null || true
    # Re-take ownership of secrets.json. Pinchy writes it as uid 999 (the
    # pinchy user inside its container); OpenClaw's secret-resolver requires
    # owner == process uid (root) and refuses to reload otherwise. The 30 s
    # mtime watch loop in start-openclaw.sh further chowns it after a write,
    # but the [reload] pipeline triggered by inotify on openclaw.json fires
    # within ~100 ms of Pinchy's regenerateOpenClawConfig() — long before that
    # loop wakes up. Without this fast tick, a freshly created agent surfaces
    # as `unknown agent id` because the reload fails on secrets and the new
    # agents.list never enters runtime. See issue #200.
    #
    # Gated on owner and mode, like every repair on this tick: a chown or chmod
    # to what a file already has is still an inotify attribute event and a
    # ctime bump on Linux, and openclaw.json above shows what that does to a
    # watcher when it fires every 50 ms. Nothing in OpenClaw 2026.9 watches the
    # secrets file, so this is not a live bug — it keeps the tick from becoming
    # one when a release starts watching it.
    find "$SECRETS_FILE" -maxdepth 0 -type f ! -uid "$OPENCLAW_UID" \
        -exec chown root:root {} \; 2>/dev/null || true
    find "$SECRETS_FILE" -maxdepth 0 -type f -not -perm 0600 \
        -exec chmod 0600 {} \; 2>/dev/null || true

    # agents/<id>/agent has to be pinchy-OWNED — the whole of issue #934. Up to
    # OpenClaw 2026.7 Pinchy (uid 999) wrote each agent's auth-profiles.json
    # there; OpenClaw 2026.9 retired that file (see remove_retired_auth_profiles
    # below), so Pinchy writes nothing there any more and this repair is only
    # kept until that is confirmed on a released install.
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
    #                  writeAgentAuthProfiles() got EACCES, which aborted
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

    # The same trap, one directory over: workspaces/<id>/ holds the bootstrap
    # files (AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md)
    # that BOTH sides write. Pinchy writes them as uid 999 from
    # regenerateOpenClawConfig(); OpenClaw creates any that are missing from its
    # own bundled template, as root, when it boots the agent.
    #
    # Pinchy opened the race itself. Up to OpenClaw 2026.7 the mailbox context
    # lived in TOOLS.md, which Pinchy DELETED for an agent with no mailbox
    # (rmSync — so a revoked permission cannot leave a stale mailbox identity
    # behind), and the next agent start found the file missing and re-created
    # it root-owned. Grant that agent an email connection afterwards and
    # Pinchy's writeFileSync got EACCES forever. Since 2026.9 the context lives
    # in IDENTITY.md (writeMailboxContext) and Pinchy only ever removes the old
    # TOOLS.md; IDENTITY.md is one of the files OpenClaw still seeds root-owned.
    #
    # This reached production (#1095): `pinchy.heypinchy.com` carried two
    # root-owned TOOLS.md files on 2026-08-04 and had rejected every agent save
    # since 2026-08-02 08:25, the last successful `agent.updated` audit row. The
    # two symptoms looked unrelated and were one bug — the EACCES aborts
    # regenerateOpenClawConfig() before the push, so the model the user saved
    # never reached the runtime AND pinchy-email never entered the plugin list,
    # leaving the agent to truthfully answer that it has no mailbox access while
    # the UI showed the connection saved.
    #
    # Ownership again, not mode: the file lands 0644 root-owned, which already
    # grants uid 999 read — it is the WRITE that is denied, and root ignores any
    # chmod we make. The directory needs it too, or a deleted TOOLS.md can never
    # be recreated.
    #
    # Scoped to the bootstrap filenames rather than a recursive sweep: this runs
    # on a 50 ms tick, and workspaces also hold uploads/ and memory/ with
    # unbounded file counts. Same `! -uid` ctime gate as above.
    #
    # The directory pass has no `-mindepth`, so it covers workspaces/ ITSELF as
    # well as workspaces/<id> — deliberately. ensureWorkspace() mkdirs a new
    # agent's directory as uid 999 and needs write permission on the parent to
    # do it, so a root-owned workspaces/ breaks every agent that does not exist
    # yet, not just the saves of the ones that do.
    find "$OPENCLAW_STATE_DIR/workspaces" -maxdepth 1 -type d ! -uid "$PINCHY_UID" \
        -exec chown "$PINCHY_UID:$PINCHY_GID" {} \; 2>/dev/null || true
    find "$OPENCLAW_STATE_DIR/workspaces" -mindepth 2 -maxdepth 2 -type f \
        \( -name "AGENTS.md" -o -name "SOUL.md" -o -name "TOOLS.md" \
        -o -name "IDENTITY.md" -o -name "USER.md" -o -name "HEARTBEAT.md" \) \
        ! -uid "$PINCHY_UID" \
        -exec chown "$PINCHY_UID:$PINCHY_GID" {} \; 2>/dev/null || true

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

# OpenClaw 2026.9 retired the per-agent auth-profiles.json: auth profiles live
# in its SQLite store now, and the file is only ever read to detect an
# unmigrated install. One an earlier Pinchy wrote, next to an empty store, gets
# that agent marked AuthProfileMigrationRequiredError ("run openclaw doctor
# --fix"), which refuses every dispatch for it. The gateway's startup preflight
# runs only doctor's config checks, not that migration; nothing in a Pinchy
# deployment runs `doctor --fix`, and there is nothing to migrate: the file held only a keyRef to
# the provider key that openclaw.json already passes to OpenClaw as a
# SecretRef. Pinchy no longer writes the file, so start-openclaw.sh runs this
# once before each gateway start rather than on the 50 ms tick.
remove_retired_auth_profiles() {
    find "$OPENCLAW_STATE_DIR/agents" -mindepth 3 -maxdepth 3 -type f -path "*/agent/auth-profiles.json" \
        -delete 2>/dev/null || true
}

# credentials/ belongs to OpenClaw. Up to OpenClaw 2026.8 Pinchy read Telegram
# pairing codes and allow lists from JSON files there, so the 50 ms tick opened
# the tree to everyone (a+rX) and config/fix-volume-ownership.sh handed it to
# uid 999. OpenClaw 2026.9 keeps both in its state database, which Pinchy
# reaches through the pinchy-audit plugin, and Pinchy reads nothing here any
# more. What is left is OpenClaw's own: its browser relay secret, which it
# ignores unless the file belongs to its own uid and no other user can read it,
# and legacy OAuth files its doctor imports.
#
# Neither script opens the tree any more; this takes back a volume an earlier
# Pinchy already opened, with the modes OpenClaw's own `security audit --fix`
# sets (directories 0700, files 0600). start-openclaw.sh runs it before each
# gateway start. Gated on owner and mode like every other repair here.
restore_credentials_privacy() {
    local dir="$OPENCLAW_STATE_DIR/credentials"
    [ -d "$dir" ] || return 0
    find "$dir" ! -uid "$OPENCLAW_UID" -exec chown root:root {} \; 2>/dev/null || true
    find "$dir" -type d -not -perm 0700 -exec chmod 0700 {} \; 2>/dev/null || true
    find "$dir" -type f -not -perm 0600 -exec chmod 0600 {} \; 2>/dev/null || true
}

# OpenClaw 2026.9 keeps its gateway lock directory in the state dir
# (`tmp/openclaw-<uid>`, mode 0700) and refuses to start when that directory is
# not owned by its own uid: "Gateway failed to start: device identity
# coordinator directory belongs to another user". config/fix-volume-ownership.sh
# no longer hands tmp/ to the pinchy uid; an earlier Pinchy did, on every boot,
# so a volume upgraded from it still carries a 999-owned lock directory. Hand it
# back before each gateway start. Gated on the uid like every other chown here.
restore_gateway_lock_ownership() {
    [ -d "$OPENCLAW_STATE_DIR/tmp" ] || return 0
    find "$OPENCLAW_STATE_DIR/tmp" ! -uid 0 -exec chown root:root {} \; 2>/dev/null || true
}
