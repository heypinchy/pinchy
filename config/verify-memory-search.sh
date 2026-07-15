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
# refresh the registry — exactly what start-openclaw.sh's stage_llama_cpp_provider
# does on boot.
if ! ls -d /root/.openclaw/npm/projects/openclaw-llama-cpp-provider-* >/dev/null 2>&1; then
  mkdir -p /root/.openclaw/npm
  cp -r /opt/llama-cpp-deps/npm/. /root/.openclaw/npm/
fi
openclaw plugins registry --refresh >/dev/null 2>&1 || true

openclaw plugins list 2>&1 | grep -qiE 'llama.?cpp.*enabled' || {
  echo "::error::llama-cpp provider did not load from plugins.allow"
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
