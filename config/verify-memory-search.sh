#!/bin/bash
# Offline smoke test for the bundled local memory-search embedding provider.
#
# Proves the FULL Ebene-1 wiring works with NO network and NO API key, inside
# the shipped openclaw image:
#   - the llama-cpp provider loads from `plugins.allow` alone (no per-plugin
#     entry), after boot-staging + registry refresh (start-openclaw.sh),
#   - the bundled EmbeddingGemma GGUF is present at MODEL_PATH,
#   - `openclaw memory index` builds a non-empty vector index for the `local`
#     provider,
#   - `memory_search` semantically recalls a stored fact.
#
# Run against the built image in CI (docker-smoke job) with `--network none`, so
# a regression that reaches for a remote model or API key — e.g. a revert to
# memory-core's `openai` default — fails LOUD here instead of silently
# returning 0 chunks in production (the exact bug this whole change fixes).
#
# MODEL_PATH is kept in lockstep with MEMORY_EMBEDDING_MODEL_PATH in
# openclaw-config/build.ts and the GGUF download path in Dockerfile.openclaw by
# the memory-embedding-pin-drift unit test — change all three together.
set -euo pipefail

MODEL_PATH="/opt/embedding-models/embeddinggemma-300m-qat-Q8_0.gguf"
AGENT="memory-smoke-agent"
WS="/root/.openclaw/workspaces/$AGENT"

test -f "$MODEL_PATH" || {
  echo "::error::bundled embedding model missing at $MODEL_PATH"
  exit 1
}

mkdir -p "$WS/memory"
printf '# Accounting rules\n' >"$WS/MEMORY.md"
printf 'Invoices from supplier Helmcraft always post to collective account 3400.\n' \
  >"$WS/memory/accounts.md"

# Minimal Pinchy-shaped config: llama-cpp enabled via plugins.allow ONLY (no
# per-plugin entry — mirrors regenerateOpenClawConfig), memory-search pinned to
# the local provider + bundled model.
cat >/root/.openclaw/openclaw.json <<JSON
{"gateway":{"mode":"local","bind":"lan","auth":{"token":"smoke"}},
 "plugins":{"allow":["memory-core","llama-cpp"],"entries":{}},
 "agents":{"defaults":{"memorySearch":{"provider":"local","local":{"modelPath":"$MODEL_PATH"}}},
           "list":[{"id":"$AGENT","name":"Smoke","workspace":"$WS"}]}}
JSON

# Stage the bundled provider into the (normally volume-mounted) config dir and
# refresh the registry using the REAL boot-path function — sourced from the same
# helper start-openclaw.sh uses, so this smoke test can't pass against a staging
# implementation that has drifted from production.
source /stage-llama-cpp-provider.sh
stage_llama_cpp_provider

openclaw plugins list 2>&1 | grep -qiE 'llama.?cpp.*enabled' || {
  echo "::error::llama-cpp provider did not load from plugins.allow"
  openclaw plugins list 2>&1 | grep -i llama || true
  exit 1
}

# Second pass, against the state an UPGRADE produces rather than an install.
#
# Everything above ran in a fresh container, where /root/.openclaw is created
# root-owned and the staged provider inherits that. Production does not look
# like this: the openclaw-config volume is uid 999 nearly throughout, because
# Pinchy (uid 999) shares it. On production the provider was therefore 999-owned
# and OpenClaw blocked it — "suspicious ownership … expected uid=0" — so
# memory_search answered "Unknown memory embedding provider: local." for every
# call, while THIS test stayed green the whole time (#1196).
#
# So re-create that state deliberately and run the real boot function against
# it. The copy is guarded and will not re-run (the provider is already there),
# which is the point: the ownership repair has to stand on its own.
NPM_ROOT="${OPENCLAW_NPM_ROOT:-/root/.openclaw/npm}"
chown -R 999:999 "$NPM_ROOT"
stage_llama_cpp_provider

BAD_OWNER="$(find "$NPM_ROOT" ! -uid 0 -print -quit)"
if [ -n "$BAD_OWNER" ]; then
  echo "::error::staged provider is still not root-owned after re-staging: $BAD_OWNER"
  exit 1
fi

openclaw plugins list 2>&1 | grep -qiE 'llama.?cpp.*enabled' || {
  echo "::error::llama-cpp provider did not load after a 999-owned (upgrade-shaped) stage"
  openclaw plugins list 2>&1 | grep -i llama || true
  exit 1
}

openclaw memory index --agent "$AGENT"

STATUS="$(openclaw memory status --agent "$AGENT" 2>&1)"
echo "$STATUS" | grep -qi 'Provider: local' || {
  echo "::error::memory-search provider is not 'local'"
  echo "$STATUS"
  exit 1
}
echo "$STATUS" | grep -qiE 'Indexed:[^0-9]*[1-9]' || {
  echo "::error::embedding index built 0 chunks (provider unavailable?)"
  echo "$STATUS"
  exit 1
}

RESULT="$(openclaw memory search --agent "$AGENT" --query 'Where do Helmcraft invoices post to?' 2>&1)"
echo "$RESULT" | grep -q '3400' || {
  echo "::error::memory_search did not recall the stored fact (account 3400)"
  echo "$RESULT"
  exit 1
}

echo "OK: memory-search wiring verified offline — provider=local, index built, semantic recall returned account 3400"
