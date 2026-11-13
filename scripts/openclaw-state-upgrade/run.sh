#!/bin/bash
# OpenClaw state upgrade test: real state written by the PREVIOUS release's
# OpenClaw image must start, and stay readable, under THIS build's image.
#
#   scripts/openclaw-state-upgrade/run.sh <old-openclaw-image> <new-openclaw-image>
#
# Why it exists: OpenClaw 2026.9 refuses to start on state written by 2026.8 or
# older until `openclaw doctor --fix` has imported it into SQLite. The
# end-user-upgrade job only checked Pinchy's /api/health — with no agents and no
# chats, on an install whose OpenClaw container could crash-loop without Pinchy
# noticing — so v0.11.0-rc shipped that crash loop. This test is the missing
# half: agents, chats, the gateway coming up, and the old chat coming back.
#
# Phase 1 runs the old image's gateway directly against a seeded openclaw.json
# with two agents and sends one chat to each through a tiny inline
# OpenAI-compatible mock (node inside the old image — no `docker build`, see
# agent-rules/ci.md on the disk guard). Phase 2 drops one agent from the config,
# the way deleting an agent in Pinchy does, and boots the new image through its
# real entrypoint (start-openclaw.sh) on the same volumes. It asserts:
#   - the gateway reaches `ready`;
#   - both chats are readable via chat.history, the deleted agent's included;
#   - across the SQLite cutover, the migration ran and completed;
#   - openclaw.json is byte-identical (the migration works on a copy);
#   - a second boot does not migrate again.
#
# What it does not cover: Pinchy itself (the end-user-upgrade job's other
# steps do), Telegram/channel state, and secrets.json-backed provider keys.
set -euo pipefail

OLD_IMAGE="${1:?old openclaw image}"
NEW_IMAGE="${2:?new openclaw image}"
P="oc-state-upgrade-$$"
NET="$P-net"
CFG="$P-cfg"
WS="$P-ws"
TOKEN="state-upgrade-token"
REPLY="Legacy reply from before the upgrade"
PLATFORM="--platform=linux/amd64"
WORK="$(mktemp -d)"

cleanup() {
    docker rm -f "$P-mock" "$P-old" "$P-new" >/dev/null 2>&1 || true
    docker volume rm "$CFG" "$WS" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
    echo "::error::$*"
    for c in "$P-old" "$P-new"; do
        docker ps -a --format '{{.Names}}' | grep -qx "$c" || continue
        echo "----- logs: $c (last 120 lines)"
        docker logs "$c" 2>&1 | tail -120
    done
    exit 1
}

# Wait until $2 (a command) succeeds, up to $1 seconds.
wait_for() {
    local deadline=$((SECONDS + $1))
    shift
    until "$@"; do
        [ "$SECONDS" -lt "$deadline" ] || return 1
        sleep 2
    done
}

# Not `grep -q`: it exits on the first match, docker logs gets SIGPIPE, and
# pipefail turns a hit into a failure.
logs_have() { docker logs "$1" 2>&1 | grep "$2" >/dev/null; }
count_in_logs() { docker logs "$1" 2>&1 | grep -c "$2" || true; }

history_of() {
    docker exec "$1" openclaw gateway call chat.history --token "$TOKEN" --json \
        --params "{\"sessionKey\":\"agent:$2:direct:user-1\"}" 2>/dev/null || true
}
history_has_reply() { history_of "$1" "$2" | grep -q "$REPLY"; }

oc_version() {
    docker run --rm "$PLATFORM" --entrypoint openclaw "$1" --version | grep -oE '[0-9]{4}\.[0-9]+' | head -1
}

# OpenClaw before 2026.9 configures agents as `agents.list`, 2026.9 and later
# as `agents.entries` (Pinchy's build.ts emits the latter).
write_config() { # <file> <oc-version> <agent ids...>
    local file="$1" version="$2"
    shift 2
    node - "$file" "$version" "$TOKEN" "$@" <<'EOF'
const fs = require("fs");
const [file, version, token, ...ids] = process.argv.slice(2);
const [year, month] = version.split(".").map(Number);
const modern = year > 2026 || (year === 2026 && month >= 9);
const agent = (id) => ({
  name: id,
  model: "mock/mock-model",
  workspace: `/root/.openclaw/workspaces/${id}`,
  heartbeat: { every: "0m" },
});
const agents = { defaults: { model: { primary: "mock/mock-model" }, heartbeat: { every: "0m" } } };
if (modern) agents.entries = Object.fromEntries(ids.map((id) => [id, agent(id)]));
else agents.list = ids.map((id) => ({ id, ...agent(id) }));
fs.writeFileSync(file, JSON.stringify({
  gateway: { mode: "local", bind: "lan", auth: { mode: "token", token }, controlUi: { enabled: false } },
  discovery: { mdns: { mode: "off" } },
  update: { checkOnStart: false },
  agents,
  session: { reset: { mode: "idle", idleMinutes: 525600 } },
  models: { providers: { mock: {
    baseUrl: "http://llm-mock:11435/v1",
    api: "openai-completions",
    apiKey: "not-a-secret",
    request: { allowPrivateNetwork: true },
    models: [{ id: "mock-model", name: "mock-model", contextWindow: 32768, maxTokens: 4096, input: ["text"] }],
  } } },
}, null, 2));
EOF
}

# Streams $REPLY for every chat completion; enough of the OpenAI surface for
# OpenClaw's openai-completions provider.
MOCK_JS='
const http = require("http");
const reply = process.env.REPLY;
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] }));
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunk = (delta, finish) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: "mock-model",
        choices: [{ index: 0, delta, finish_reason: finish }] });
      res.write("data: " + JSON.stringify(chunk({ role: "assistant", content: reply }, null)) + "\n\n");
      res.write("data: " + JSON.stringify(chunk({}, "stop")) + "\n\n");
      res.write("data: " + JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "mock-model", choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + "\n\n");
      return res.end("data: [DONE]\n\n");
    }
    res.writeHead(404);
    res.end();
  });
}).listen(11435);
'

OLD_VERSION="$(oc_version "$OLD_IMAGE")"
NEW_VERSION="$(oc_version "$NEW_IMAGE")"
echo "Upgrading OpenClaw state: $OLD_IMAGE ($OLD_VERSION) -> $NEW_IMAGE ($NEW_VERSION)"

docker network create "$NET" >/dev/null
docker volume create "$CFG" >/dev/null
docker volume create "$WS" >/dev/null

# --- Phase 1: the previous release writes state ---------------------------
docker run -d --name "$P-mock" "$PLATFORM" --network "$NET" --network-alias llm-mock \
    -e REPLY="$REPLY" --entrypoint node "$OLD_IMAGE" -e "$MOCK_JS" >/dev/null

write_config "$WORK/old.json" "$OLD_VERSION" keeper deleted
docker run --rm "$PLATFORM" -v "$CFG:/root/.openclaw" -v "$WORK:/seed:ro" --entrypoint sh "$OLD_IMAGE" \
    -c 'cp /seed/old.json /root/.openclaw/openclaw.json && chmod 600 /root/.openclaw/openclaw.json'

docker run -d --name "$P-old" "$PLATFORM" --network "$NET" \
    -v "$CFG:/root/.openclaw" -v "$WS:/root/.openclaw/workspaces" \
    --entrypoint openclaw "$OLD_IMAGE" gateway --port 18789 >/dev/null
wait_for 180 logs_have "$P-old" '\[gateway\] ready\|listening on' || fail "old gateway did not come up"

for agent in keeper deleted; do
    docker exec "$P-old" openclaw gateway call chat.send --token "$TOKEN" --json --timeout 120000 \
        --params "{\"sessionKey\":\"agent:$agent:direct:user-1\",\"message\":\"hello $agent\",\"idempotencyKey\":\"upgrade-$agent\"}" \
        >/dev/null || fail "chat.send to $agent failed on the old gateway"
    wait_for 120 history_has_reply "$P-old" "$agent" || fail "old gateway never stored the reply for $agent"
done
echo "Phase 1: both agents have a chat on $OLD_VERSION"
docker stop "$P-old" >/dev/null

# --- Phase 2: this build boots on that state ------------------------------
# Deleting an agent in Pinchy drops it from openclaw.json but leaves its files.
write_config "$WORK/new.json" "$NEW_VERSION" keeper
docker run --rm "$PLATFORM" -v "$CFG:/root/.openclaw" -v "$WORK:/seed:ro" --entrypoint sh "$OLD_IMAGE" \
    -c 'cp /seed/new.json /root/.openclaw/openclaw.json'
CONFIG_SHA="$(docker run --rm "$PLATFORM" -v "$CFG:/c:ro" --entrypoint sha256sum "$OLD_IMAGE" /c/openclaw.json | cut -d' ' -f1)"

docker run -d --name "$P-new" "$PLATFORM" --network "$NET" -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
    -v "$CFG:/root/.openclaw" -v "$WS:/root/.openclaw/workspaces" "$NEW_IMAGE" >/dev/null
wait_for 600 logs_have "$P-new" '\[gateway\] ready' \
    || fail "$NEW_VERSION gateway never became ready on state written by $OLD_VERSION"

for agent in keeper deleted; do
    wait_for 60 history_has_reply "$P-new" "$agent" \
        || fail "the $agent chat written by $OLD_VERSION is not readable on $NEW_VERSION"
done
echo "Phase 2: gateway ready and both chats readable on $NEW_VERSION"

# Across the SQLite cutover, the readable chats must be the migration's work —
# otherwise a previous release already on 2026.9 would make this test vacuous.
old_major="$(echo "$OLD_VERSION" | awk -F. '{ print ($1 > 2026 || ($1 == 2026 && $2 >= 9)) ? "sqlite" : "files" }')"
if [ "$old_major" = files ]; then
    logs_have "$P-new" '\[state-migration\] Found' \
        || fail "no state migration ran, though $OLD_VERSION wrote pre-SQLite state"
    logs_have "$P-new" '\[state-migration\] Migration complete' \
        || fail "the state migration did not complete"
fi

AFTER_SHA="$(docker exec "$P-new" sha256sum /root/.openclaw/openclaw.json | cut -d' ' -f1)"
[ "$AFTER_SHA" = "$CONFIG_SHA" ] || fail "openclaw.json changed during the upgrade (the migration must work on a copy)"

MIGRATIONS="$(count_in_logs "$P-new" '\[state-migration\] Found')"
READY="$(count_in_logs "$P-new" '\[gateway\] ready')"
docker restart "$P-new" >/dev/null
ready_again() { [ "$(count_in_logs "$P-new" '\[gateway\] ready')" -gt "$READY" ]; }
wait_for 300 ready_again || fail "$NEW_VERSION gateway did not come back after a restart"
[ "$(count_in_logs "$P-new" '\[state-migration\] Found')" = "$MIGRATIONS" ] \
    || fail "the second boot migrated again — detection does not match what doctor leaves behind"
wait_for 60 history_has_reply "$P-new" keeper || fail "the keeper chat is gone after a restart"

echo "OpenClaw state upgrade $OLD_VERSION -> $NEW_VERSION: OK"
