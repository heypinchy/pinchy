#!/bin/bash
# Pinchy eval watchdog (pinchy#669).
# Keeps the pinchy-eval Docker stack up and RESUMES the active scenario's sweep
# if it isn't running — independent of any Claude Code session, surviving both
# session teardown and reboot (via launchd). Keyless: the sweep reads the Ollama
# key from the eval DB (eval-models.spec.ts fallback), so no secret lives here.
# Runs every ~15 min via ~/Library/LaunchAgents/com.pinchy.eval-watchdog.plist.
#
# INSTALL (full runbook: .claude/skills/run-model-eval/SKILL.md). This file is
# a TEMPLATE — __NODE_BIN__ / __REPO__ are filled in at install time:
#   1. mkdir -p ~/.pinchy-eval-watchdog
#      sed -e "s|__NODE_BIN__|$(dirname "$(command -v node)")|" \
#          -e "s|__REPO__|<absolute path of the checkout sweeps run from>|" \
#          watchdog.sh > ~/.pinchy-eval-watchdog/watchdog.sh
#      chmod +x ~/.pinchy-eval-watchdog/watchdog.sh
#   2. ADJUST MODELS (current candidate list) and EXPECTED_RUNS (= models × N).
#   3. sed "s|__HOME__|$HOME|g" com.pinchy.eval-watchdog.plist \
#        > ~/Library/LaunchAgents/com.pinchy.eval-watchdog.plist
#      launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pinchy.eval-watchdog.plist
#   4. Control: echo <scenario-label|none> > ~/.pinchy-eval-watchdog/active-scenario
#      Stop:    launchctl bootout gui/$(id -u)/com.pinchy.eval-watchdog
set -u

export PATH="__NODE_BIN__:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

WD="$HOME/.pinchy-eval-watchdog"
REPO="__REPO__"
WEB="$REPO/packages/web"
LOG="$WD/watchdog.log"
ACTIVE="$WD/active-scenario"
LOCK="$WD/lock.d"

MODELS='ollama-cloud/kimi-k2.6,ollama-cloud/gemma4:31b,ollama-cloud/glm-4.7,ollama-cloud/glm-5.2,ollama-cloud/qwen3.5:397b,ollama-cloud/minimax-m3,ollama-cloud/gpt-oss:120b,ollama-cloud/mistral-large-3:675b,ollama-cloud/deepseek-v3.2,ollama-cloud/deepseek-v4-pro,ollama-cloud/nemotron-3-ultra,ollama-cloud/gpt-oss:20b,ollama-cloud/glm-5.1,ollama-cloud/minimax-m2.7'
N=12
EXPECTED_RUNS=168 # 14 models x 12

COMPOSE=(docker compose -p pinchy-eval -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.eval.yml)

log() { echo "$(date '+%F %T') $*" >>"$LOG"; }

# Single-instance lock (atomic mkdir); stale-lock breaker at 30 min.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -d "$LOCK" ] && [ "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

cd "$REPO" 2>/dev/null || { log "ERROR repo missing: $REPO"; exit 1; }

# 1) Ensure every stack container is up. Match the EXACT container name
# (compose names them "<project>-<service>-1") so an already-running container
# is never needlessly `up -d`'d — which could recreate it and disrupt a live
# sweep. Only a genuinely absent container is (re)started.
for c in db openclaw pinchy odoo-mock graph-mock; do
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "pinchy-eval-$c-1"; then
    log "container $c not running -> up -d"
    PINCHY_VERSION=latest DB_PASSWORD=eval_dev_pw "${COMPOSE[@]}" up -d "$c" >>"$LOG" 2>&1
  fi
done

# 1b) Continuously back up results off the fragile worktree copy (the results/
# dir is gitignored and lives under .claude/worktrees, which a cleanup can
# remove — a single disk/worktree loss would otherwise wipe the whole dataset).
BK="$HOME/pinchy-eval-data/latest"
mkdir -p "$BK"
cp -p "$WEB"/eval/results/*.jsonl "$WEB"/eval/results/*.json "$BK/" 2>/dev/null

# 2) Active scenario? (empty / "none" = nothing to sweep, just keep stack warm)
SCEN="$(tr -d '[:space:]' <"$ACTIVE" 2>/dev/null)"
if [ -z "$SCEN" ] || [ "$SCEN" = "none" ]; then
  exit 0
fi

# 3) Already complete?
JSONL="$WEB/eval/results/$SCEN.jsonl"
COUNT=0
[ -f "$JSONL" ] && COUNT="$(wc -l <"$JSONL" | tr -d ' ')"
if [ "$COUNT" -ge "$EXPECTED_RUNS" ]; then
  exit 0
fi

# 4) A sweep already running? Match "eval:models": the caffeinate/pnpm process
# carries it from t=0, whereas the "playwright test" child only spawns seconds
# later — matching on that races and double-launches concurrent sweeps that then
# corrupt each other's shared mock/agent state.
# If it IS running, only leave it alone while it's making PROGRESS: a hung run
# (process alive, run count static for STALL_SECS) is killed so it can resume
# cleanly instead of blocking for up to the 24h test timeout.
STALL_SECS=1800
PROG="$WD/progress"
if pgrep -f "eval:models" >/dev/null 2>&1; then
  NOW="$(date +%s)"
  PREV_COUNT=0
  PREV_TS=0
  [ -f "$PROG" ] && read -r PREV_COUNT PREV_TS <"$PROG"
  if [ "$COUNT" -gt "$PREV_COUNT" ] || [ "$PREV_TS" -eq 0 ]; then
    echo "$COUNT $NOW" >"$PROG"
    exit 0
  fi
  if [ $((NOW - PREV_TS)) -lt "$STALL_SECS" ]; then
    exit 0
  fi
  log "sweep STALLED at $COUNT runs for $((NOW - PREV_TS))s -> killing to resume"
  pkill -9 -f "eval:models" 2>/dev/null
  pkill -9 -f "playwright.*eval" 2>/dev/null
  sleep 3
  echo "$COUNT $NOW" >"$PROG"
  # fall through to relaunch
fi

# 5) Resume the sweep, detached, keeping the Mac awake for its duration.
log "resuming '$SCEN' ($COUNT/$EXPECTED_RUNS) — no sweep running"
cd "$WEB" || exit 1
SWEEPLOG="$WD/sweep.log"
nohup /usr/bin/caffeinate -s /usr/bin/env \
  DB_PASSWORD=eval_dev_pw \
  EVAL_SCENARIO="$SCEN" \
  EVAL_CANDIDATE_MODELS="$MODELS" \
  EVAL_N="$N" \
  pnpm eval:models >>"$SWEEPLOG" 2>&1 &
disown
log "launched sweep (pid $!) for '$SCEN'"
