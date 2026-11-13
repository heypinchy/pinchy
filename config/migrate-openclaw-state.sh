#!/bin/bash
# One-time import of pre-2026.9 OpenClaw state, run before every gateway start
# by start-openclaw.sh. Extracted (same pattern as fix-config-permissions.sh) so
# its contract is unit-testable — see
# packages/web/src/__tests__/lib/migrate-openclaw-state.test.ts — and exercised
# end to end against real v0.10.x state by scripts/openclaw-state-upgrade/run.sh.
#
# Why it exists: OpenClaw 2026.9 moved session stores and workspace setup state
# into SQLite, and only `openclaw doctor --fix` imports the old files. The
# gateway fails closed while any of them is on disk ("Legacy workspace setup
# state requires migration …", "Legacy session store requires migration …"),
# so an install upgraded from Pinchy v0.10.x crash-loops until doctor has run.
#
# Why it is safe to run doctor --fix here:
#   - It only runs when the gateway would refuse to start. Detection mirrors
#     the gateway's two guards (assertNoUnmigratedWorkspaceState for the
#     configured agents' workspaces, assertSessionStoreMigrationComplete for any
#     sessions.json store), so a migrated install costs one `node -e` per boot.
#   - Doctor gets a throwaway COPY of openclaw.json via OPENCLAW_CONFIG_PATH.
#     openclaw.json is Pinchy's (regenerated from the database on every boot);
#     whatever doctor would normalize in it is discarded with the copy.
#   - --non-interactive: no prompts on a headless boot.
#   - Heartbeats: Pinchy sets heartbeat.every "0m" on every agent, so the
#     heartbeat rows doctor reconciles are created disabled — the same rows the
#     gateway's own cron service reconciles on start.
#   - Doctor archives what it imports (agents/<id>/session-sqlite-import-archive,
#     <workspace>/openclaw-workspace-state.json.migrated.*) rather than deleting.
#
# Fails open: a failed migration logs the exit code and the manual command, and
# the gateway start that follows reports OpenClaw's own error.
#
# Paths, the binary and the timeout are env-overridable so the unit test can
# drive the real function against temp dirs; production uses the defaults.

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/root/.openclaw}"
# A doctor run that imports many large chat histories takes a while; one that
# hangs must not block the gateway forever.
OPENCLAW_MIGRATION_TIMEOUT="${OPENCLAW_MIGRATION_TIMEOUT:-1800}"

# Prints one line per piece of legacy state that would stop the gateway.
# Prints nothing (and succeeds) when there is none or no config yet.
list_legacy_openclaw_state() {
    [ -f "$OPENCLAW_STATE_DIR/openclaw.json" ] || return 0
    OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const stateDir = process.env.OPENCLAW_STATE_DIR;
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const found = [];
const hit = (p) => { if (exists(p) || exists(p + ".doctor-importing")) found.push(p); };
// <workspace>.attested sits outside the state dir, so the gateway only counts a
// regular file that starts with its own header (legacyWorkspaceSiblingAttestationMayExist).
const ATTESTATION_HEADER = "openclaw-workspace-attestation:v1\n";
const isAttestation = (p) => {
  try {
    if (!fs.lstatSync(p).isFile()) return false;
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(ATTESTATION_HEADER.length);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8") === ATTESTATION_HEADER;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
};
const hitSibling = (p) => { if (isAttestation(p) || isAttestation(p + ".doctor-importing")) found.push(p); };

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8")); } catch {}
const agents = cfg.agents || {};
const entries = [
  ...(Array.isArray(agents.list) ? agents.list : []),
  ...Object.values(agents.entries && typeof agents.entries === "object" ? agents.entries : {}),
];
const home = process.env.HOME || "/root";
const workspaces = new Set();
for (const e of entries) {
  const ws = e && typeof e.workspace === "string" ? e.workspace.trim() : "";
  if (ws) workspaces.add(path.resolve(ws.replace(/^~(?=$|\/)/, home)));
}

// Gateway guard 1: workspace setup state of a configured workspace. Pinchy
// gives every agent an explicit workspace, sets no session.store and no
// sandbox, so the other gateway sources (implicit default workspaces, legacy
// state dirs, sandbox copies) never apply to a Pinchy install.
for (const ws of workspaces) {
  const paths = new Set([ws]);
  try { paths.add(fs.realpathSync(ws)); } catch {}
  for (const p of paths) {
    hit(path.join(p, "openclaw-workspace-state.json"));
    hit(path.join(p, ".openclaw", "workspace-state.json"));
    hitSibling(p + ".attested");
    const key = crypto.createHash("sha256").update(p).digest("hex");
    hit(path.join(stateDir, "workspace-attestations", key + ".attested"));
  }
}

// Gateway guard 2: any legacy JSON session store, configured agent or not.
hit(path.join(stateDir, "sessions", "sessions.json"));
let agentDirs = [];
try { agentDirs = fs.readdirSync(path.join(stateDir, "agents")); } catch {}
for (const id of agentDirs) hit(path.join(stateDir, "agents", id, "sessions", "sessions.json"));

for (const p of [...new Set(found)]) console.log(p);
'
}

migrate_legacy_openclaw_state() {
    local legacy
    legacy="$(list_legacy_openclaw_state 2>&1)" || {
        echo "[state-migration] WARNING: could not check for pre-2026.9 OpenClaw state: $legacy"
        return 0
    }
    [ -n "$legacy" ] || return 0

    echo "[state-migration] Found OpenClaw state from before 2026.9 that the gateway refuses to start with:"
    echo "$legacy" | head -20 | sed 's/^/[state-migration]   /'
    echo "[state-migration] Importing it into SQLite with 'openclaw doctor --fix' (one time; originals are archived, not deleted)..."

    local workdir rc start
    workdir="$(mktemp -d "${TMPDIR:-/tmp}/pinchy-oc-state-migration.XXXXXX")" || {
        echo "[state-migration] FAILED (exit 1): could not create a temp dir. Run manually: docker compose exec openclaw openclaw doctor --fix"
        return 0
    }
    # Every command below is guarded: start-openclaw.sh runs under `set -e`,
    # and an unguarded failure here would kill the entrypoint, not fail open.
    cp "$OPENCLAW_STATE_DIR/openclaw.json" "$workdir/openclaw.json" || {
        rm -rf "$workdir"
        echo "[state-migration] FAILED: could not copy openclaw.json. Run manually: docker compose exec openclaw openclaw doctor --fix"
        return 0
    }
    local limit=()
    command -v timeout >/dev/null 2>&1 && limit=(timeout "$OPENCLAW_MIGRATION_TIMEOUT")
    start=$(date +%s)
    OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" OPENCLAW_CONFIG_PATH="$workdir/openclaw.json" \
        "${limit[@]}" openclaw doctor --fix --non-interactive 2>&1 \
        | sed 's/^/[state-migration] doctor: /'
    rc=${PIPESTATUS[0]}
    rm -rf "$workdir"
    local took=$(( $(date +%s) - start ))

    # Judge by what is left, not by doctor's exit code: doctor --fix runs dozens
    # of unrelated checks, and one failing after the import must not tell the
    # operator the gateway won't start. The exit code is reported either way.
    local remaining
    remaining="$(list_legacy_openclaw_state 2>/dev/null)" || remaining="(could not re-check)"
    if [ -z "$remaining" ]; then
        echo "[state-migration] Migration complete in ${took}s (doctor exit $rc)."
        return 0
    fi
    echo "[state-migration] FAILED (doctor exit $rc) after ${took}s. This is still on disk, and the gateway won't start until it is imported:"
    echo "$remaining" | head -20 | sed 's/^/[state-migration]   /'
    echo "[state-migration] It is retried on the next gateway start. To run it by hand: docker compose exec openclaw openclaw doctor --fix"
    return 0
}
