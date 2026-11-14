#!/bin/bash
# Rebuilds agent memory indexes that OpenClaw will not rebuild on its own. Run
# by start-openclaw.sh before the gateway starts. Extracted (same pattern as
# migrate-openclaw-state.sh) so its contract is unit-testable — see
# packages/web/src/__tests__/lib/heal-memory-indexes.test.ts.
#
# Why it exists: memory-core stamps every index with the embedding model it was
# built for. When an embed fails while the gateway builds an index, memory-core
# falls back to keyword-only and stamps the index "fts-only". Once embeddings
# work again, the index is "mismatched" ("index was built for model fts-only,
# expected …", owner: configuration) — and memory-core rebuilds a mismatched
# index only on an explicit `openclaw memory index` (reason "cli"). The gateway
# never does: memory_search returns no results and tells the user to run a CLI
# command a Pinchy user has no way to run. The v0.11.0 RC left every index it
# touched in that state (llama-server's 512-token batch, see
# LLAMA_SERVER_EMBEDDING_BATCH_TOKENS in packages/web/src/lib/openclaw-config/paths.ts),
# and any transient embedding failure can produce it again.
#
# What it does: asks `openclaw memory status --json` which agents' indexes are
# "mismatched" with owner "configuration" and runs
# `openclaw memory index --agent <id>` for exactly those. A "missing" index and
# a mismatch OpenClaw owns (provenance or chunking version) are left alone —
# the gateway's own sync rebuilds those — so they never delay the gateway
# start here.
#
# Why before the gateway: the CLI starts its own llama-server on the provider's
# loopback port and stops it when it exits. A gateway running beside it would
# find that server healthy, reuse it, and lose it mid-embed when the CLI exits —
# exactly the transient failure that produces a keyword-only index.
#
# Fails open: nothing here may stop the gateway start. The rebuild has a time
# budget; whatever is still mismatched when it runs out is retried on the next
# start. `openclaw memory index` exits 0 even when it could not embed, so the
# outcome is judged by re-reading the status, not by the exit code.
#
# Paths, the binary and the budget are env-overridable so the unit test can
# drive the real function; production uses the defaults.

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/root/.openclaw}"
# Total seconds the rebuilds may take before the gateway starts anyway.
OPENCLAW_MEMORY_HEAL_BUDGET="${OPENCLAW_MEMORY_HEAL_BUDGET:-900}"
# Upper bound for the status query itself.
OPENCLAW_MEMORY_STATUS_TIMEOUT="${OPENCLAW_MEMORY_STATUS_TIMEOUT:-120}"

# Reads `openclaw memory status --json` on stdin and prints the id of every
# agent whose index is mismatched by configuration, one per line. Exits
# non-zero when stdin is not the status array — a format change must be loud,
# not read as "healthy".
list_mismatched_memory_indexes() {
    node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  // Plugin registration can log to stdout before the JSON document, and its
  // lines start with "[" too ("[plugins] …"): take the first line start from
  // which the rest parses.
  let agents;
  for (const m of raw.matchAll(/^\[/gm)) {
    try {
      agents = JSON.parse(raw.slice(m.index));
      break;
    } catch {}
  }
  if (!Array.isArray(agents)) {
    console.error("no JSON array in `openclaw memory status --json` output");
    process.exit(2);
  }
  for (const entry of agents) {
    const id = entry && entry.agentId;
    const identity = entry && entry.status && entry.status.custom && entry.status.custom.indexIdentity;
    if (typeof id !== "string" || !identity || typeof identity.status !== "string") {
      console.error("unrecognised agent entry in `openclaw memory status --json` output");
      process.exit(2);
    }
    // Only the configuration-owned mismatch (built for another embedding
    // model) waits for the CLI. One OpenClaw owns (provenance or chunking
    // version) is rebuilt by the gateway itself.
    if (identity.status === "mismatched" && identity.owner === "configuration") console.log(id);
  }
});
'
}

# Prints the mismatched agent ids of the current install. Non-zero exit when
# the status could not be read.
query_mismatched_memory_indexes() {
    local limit=() out rc
    command -v timeout >/dev/null 2>&1 && limit=(timeout "$OPENCLAW_MEMORY_STATUS_TIMEOUT")
    # stderr carries OpenClaw's plugin and provider logs; only stdout is data.
    out="$("${limit[@]}" openclaw memory status --json 2>/dev/null)"
    rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    printf '%s\n' "$out" | list_mismatched_memory_indexes
}

# Resets the named variable to its default unless it holds whole seconds. A
# value like "15m" would be a syntax error in $(( )), and under the caller's
# `set -e` that ends the container start.
require_memory_heal_seconds() {
    local name="$1" default="$2"
    [[ "${!name}" =~ ^[0-9]+$ ]] && return 0
    echo "[memory-heal] WARNING: $name=\"${!name}\" is not a whole number of seconds; using $default."
    printf -v "$name" '%s' "$default"
}

heal_memory_indexes() {
    [ -f "$OPENCLAW_STATE_DIR/openclaw.json" ] || return 0
    require_memory_heal_seconds OPENCLAW_MEMORY_HEAL_BUDGET 900
    require_memory_heal_seconds OPENCLAW_MEMORY_STATUS_TIMEOUT 120

    local mismatched
    mismatched="$(query_mismatched_memory_indexes)" || {
        echo "[memory-heal] WARNING: could not read the memory index status; starting the gateway without checking it."
        return 0
    }
    [ -n "$mismatched" ] || return 0

    echo "[memory-heal] Memory indexes OpenClaw will not rebuild on its own (built for a different embedding model, usually after a failed embed):"
    echo "$mismatched" | sed 's/^/[memory-heal]   /'

    local start agent remaining limit rc
    start=$(date +%s)
    while IFS= read -r agent; do
        [ -n "$agent" ] || continue
        remaining=$(( OPENCLAW_MEMORY_HEAL_BUDGET - ($(date +%s) - start) ))
        if [ "$remaining" -le 0 ]; then
            echo "[memory-heal] Time budget of ${OPENCLAW_MEMORY_HEAL_BUDGET}s used up; the rest is rebuilt on the next start."
            break
        fi
        limit=()
        command -v timeout >/dev/null 2>&1 && limit=(timeout "$remaining")
        echo "[memory-heal] Rebuilding the memory index of agent $agent..."
        # Every command is guarded: start-openclaw.sh runs under `set -e`.
        # </dev/null: the loop's stdin is the list of agents still to come.
        "${limit[@]}" openclaw memory index --agent "$agent" </dev/null 2>&1 | sed 's/^/[memory-heal] index: /'
        rc=${PIPESTATUS[0]}
        [ "$rc" -eq 0 ] || echo "[memory-heal] 'openclaw memory index --agent $agent' exited $rc."
    done <<<"$mismatched"

    local still took
    took=$(( $(date +%s) - start ))
    still="$(query_mismatched_memory_indexes)" || {
        echo "[memory-heal] Rebuild ran for ${took}s; could not re-read the status to confirm it."
        return 0
    }
    if [ -z "$still" ]; then
        echo "[memory-heal] Memory indexes rebuilt in ${took}s."
        return 0
    fi
    echo "[memory-heal] FAILED after ${took}s: still not rebuilt, retried on the next start:"
    echo "$still" | sed 's/^/[memory-heal]   /'
    return 0
}
