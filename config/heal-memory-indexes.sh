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
# Fails open: nothing here may stop the gateway start. One time budget covers
# every status query and every rebuild together; whatever is still mismatched
# when it runs out is retried on the next start. The only things past it are
# the 10 seconds a step that ignores SIGTERM gets before SIGKILL, and the few
# seconds it takes to stop a llama-server a killed rebuild left behind.
# `openclaw memory index` exits 0 even when it could not embed, so the outcome
# is judged by re-reading the status, not by the exit code.
#
# Paths, the binary and the budget are env-overridable so the unit test can
# drive the real function; production uses the defaults.

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/root/.openclaw}"
# Total seconds the heal may hold the gateway start back: status queries and
# rebuilds together.
OPENCLAW_MEMORY_HEAL_BUDGET="${OPENCLAW_MEMORY_HEAL_BUDGET:-900}"
# Upper bound for a single status query, within the budget.
OPENCLAW_MEMORY_STATUS_TIMEOUT="${OPENCLAW_MEMORY_STATUS_TIMEOUT:-120}"
# How long a leftover llama-server gets to exit on SIGTERM before SIGKILL.
OPENCLAW_LLAMA_SERVER_STOP_TIMEOUT="${OPENCLAW_LLAMA_SERVER_STOP_TIMEOUT:-15}"

# Reads `openclaw memory status --json` on stdin and prints the id of every
# agent whose index is mismatched by configuration, one per line. Exits
# non-zero when stdin is not the status array — a format change must be loud,
# not read as "healthy" — and, given an agent id, when the array has no entry
# for it: OpenClaw prints `[]` for an agent whose memory manager fails to open.
list_mismatched_memory_indexes() {
    node -e '
const expected = process.argv[1];
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
  if (expected && !agents.some((entry) => entry.agentId === expected)) {
    console.error("no entry for agent " + expected + " in `openclaw memory status --json` output");
    process.exit(2);
  }
});
' "${1:-}"
}

# Prints the mismatched agent ids of the current install (or, given `--agent
# <id>`, of that one agent). Non-zero exit when the status could not be read.
#
# A non-zero exit from the status command alone is not "unreadable": when one
# agent's memory manager throws, the command still prints the array for every
# other agent and then exits non-zero. Whatever parses is used; only output
# that does not parse counts as a failure.
#
# Inside heal_memory_indexes the query also stops at the heal's deadline
# (memory_heal_deadline, a local there and visible here through bash's dynamic
# scoping), and returns 124 like a timed-out command once it has passed.
query_mismatched_memory_indexes() {
    local limit=() out rc seconds="$OPENCLAW_MEMORY_STATUS_TIMEOUT" left expected=""
    [ "${1:-}" != "--agent" ] || expected="${2:-}"
    if [ -n "${memory_heal_deadline:-}" ]; then
        left=$(( memory_heal_deadline - $(date +%s) ))
        [ "$left" -gt 0 ] || return 124
        [ "$left" -ge "$seconds" ] || seconds="$left"
    fi
    # -k: a query that ignores SIGTERM is killed 10s later.
    command -v timeout >/dev/null 2>&1 && limit=(timeout -k 10 "$seconds")
    # stderr carries OpenClaw's plugin and provider logs; only stdout is data.
    out="$("${limit[@]}" openclaw memory status "$@" --json 2>/dev/null)"
    rc=$?
    if ! printf '%s\n' "$out" | list_mismatched_memory_indexes "$expected"; then
        [ "$rc" -ne 0 ] || rc=2
        return "$rc"
    fi
    [ "$rc" -eq 0 ] || echo "[memory-heal] 'openclaw memory status' exited $rc; using the status it did print." >&2
    return 0
}

# Resets the named variable to its default unless it holds whole seconds of at
# least <min>, and normalises it to plain decimal. A value like "15m" is a
# syntax error in $(( )), and so is "0900" (a leading zero means octal) — an
# arithmetic error discards the whole heal_memory_indexes command, so the heal
# would be skipped without a word; "010" would quietly mean 8 seconds. A
# timeout of 0 is `timeout 0`, which means no limit at all.
require_memory_heal_seconds() {
    local name="$1" default="$2" min="$3" value="${!1}" at_least=""
    if [[ "$value" =~ ^[0-9]+$ ]]; then
        value=$((10#$value))
        if [ "$value" -ge "$min" ]; then
            printf -v "$name" '%s' "$value"
            return 0
        fi
    fi
    [ "$min" -eq 0 ] || at_least=" of at least $min"
    echo "[memory-heal] WARNING: $name=\"${!name}\" is not a whole number of seconds${at_least}; using $default."
    printf -v "$name" '%s' "$default"
}

# Stops any llama-server a rebuild left behind and waits until it is gone.
#
# A rebuild the budget kills gets SIGTERM, so the CLI's exit hook never stops
# the llama-server it spawned detached, in its own process group. Left on the
# provider port, the gateway would find it healthy and reuse a server it does
# not own and never idle-stops. SIGTERM itself takes seconds (the router stops
# its model children first), and a gateway started in between finds the same
# healthy server — hence the wait. No pkill means no cleanup; the gateway
# starts either way.
stop_leftover_llama_server() {
    command -v pkill >/dev/null 2>&1 || return 0
    pkill -x llama-server >/dev/null 2>&1 || return 0
    local waited=0
    while pkill -0 -x llama-server >/dev/null 2>&1; do
        if [ "$waited" -ge "$OPENCLAW_LLAMA_SERVER_STOP_TIMEOUT" ]; then
            echo "[memory-heal] llama-server did not stop within ${OPENCLAW_LLAMA_SERVER_STOP_TIMEOUT}s; killing it."
            pkill -KILL -x llama-server >/dev/null 2>&1 || true
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
}

heal_memory_indexes() {
    [ -f "$OPENCLAW_STATE_DIR/openclaw.json" ] || return 0
    require_memory_heal_seconds OPENCLAW_MEMORY_HEAL_BUDGET 900 0
    require_memory_heal_seconds OPENCLAW_MEMORY_STATUS_TIMEOUT 120 1
    require_memory_heal_seconds OPENCLAW_LLAMA_SERVER_STOP_TIMEOUT 15 1

    # One clock for everything below: query_mismatched_memory_indexes reads
    # this deadline too, so the status queries cannot add their own timeouts
    # on top of the rebuilds'.
    local start memory_heal_deadline
    start=$(date +%s)
    memory_heal_deadline=$(( start + OPENCLAW_MEMORY_HEAL_BUDGET ))
    local used_up="[memory-heal] Time budget of ${OPENCLAW_MEMORY_HEAL_BUDGET}s used up"
    if [ "$OPENCLAW_MEMORY_HEAL_BUDGET" -le 0 ]; then
        echo "$used_up; not checking the memory indexes."
        return 0
    fi

    local mismatched
    mismatched="$(query_mismatched_memory_indexes)" || {
        echo "[memory-heal] WARNING: could not read the memory index status; starting the gateway without checking it."
        return 0
    }
    [ -n "$mismatched" ] || return 0

    echo "[memory-heal] Memory indexes OpenClaw will not rebuild on its own (built for a different embedding model, usually after a failed embed):"
    echo "$mismatched" | sed 's/^/[memory-heal]   /'

    local agents=() failed=() agent i remaining limit rc still took broken="" ran=""
    local in_a_row=0
    while IFS= read -r agent; do
        [ -n "$agent" ] && agents+=("$agent")
    done <<<"$mismatched"

    for ((i = 0; i < ${#agents[@]}; i++)); do
        agent="${agents[i]}"
        remaining=$(( memory_heal_deadline - $(date +%s) ))
        if [ "$remaining" -le 0 ]; then
            echo "$used_up; the rest is rebuilt on the next start."
            break
        fi
        limit=()
        # -k: a rebuild that ignores SIGTERM is killed 10s later.
        command -v timeout >/dev/null 2>&1 && limit=(timeout -k 10 "$remaining")
        echo "[memory-heal] Rebuilding the memory index of agent $agent..."
        ran=1
        # Every command is guarded: start-openclaw.sh runs under `set -e`.
        # </dev/null: the rebuild must not read the caller's stdin.
        "${limit[@]}" openclaw memory index --agent "$agent" </dev/null 2>&1 | sed 's/^/[memory-heal] index: /'
        rc=${PIPESTATUS[0]}
        if [ "$rc" -ne 0 ]; then
            echo "[memory-heal] 'openclaw memory index --agent $agent' exited $rc."
        # The exit code says nothing about the embeds; the status does.
        elif ! still="$(query_mismatched_memory_indexes --agent "$agent")"; then
            echo "[memory-heal] Could not re-read the memory index status of agent $agent."
        elif [ -n "$still" ]; then
            echo "[memory-heal] The memory index of agent $agent is still mismatched after the rebuild."
        else
            in_a_row=0
            continue
        fi
        failed+=("$agent")
        # A step cut off by the deadline says nothing about the embeddings.
        if [ "$(date +%s)" -ge "$memory_heal_deadline" ]; then
            echo "$used_up; the rest is rebuilt on the next start."
            i=$((i + 1))
            break
        fi
        # One failure can be that agent's own (a corrupt or locked index), and
        # agent order is stable: stopping there would block every agent after
        # it on every start. Two in a row is what failing embeddings look like,
        # and those fail for every agent alike — trying the rest would spend
        # the whole budget on every start while the gateway waits.
        in_a_row=$((in_a_row + 1))
        if [ "$in_a_row" -ge 2 ]; then
            broken=1
            i=$((i + 1))
            break
        fi
    done

    [ -z "$ran" ] || stop_leftover_llama_server

    took=$(( $(date +%s) - start ))
    if [ "$i" -eq "${#agents[@]}" ] && [ "${#failed[@]}" -eq 0 ]; then
        echo "[memory-heal] Memory indexes rebuilt in ${took}s."
        return 0
    fi
    [ -z "$broken" ] || echo "[memory-heal] Not trying the remaining agents: two rebuilds in a row failed, and whatever broke them breaks theirs too."
    echo "[memory-heal] FAILED after ${took}s: still not rebuilt, retried on the next start:"
    printf '%s\n' "${failed[@]}" "${agents[@]:i}" | sed 's/^/[memory-heal]   /'
    return 0
}
