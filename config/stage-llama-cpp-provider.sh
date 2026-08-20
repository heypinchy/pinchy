#!/bin/bash
# Stages the bundled llama.cpp embedding provider into the OpenClaw config volume
# on boot. Extracted from start-openclaw.sh (same pattern as install-plugin-deps.sh)
# so the staging contract is unit-testable (stage-llama-cpp-provider.test.ts) AND
# the offline CI smoke test (config/verify-memory-search.sh) exercises the REAL
# function instead of a re-implemented copy that could drift from production.
#
# `openclaw plugins install @openclaw/llama-cpp-provider` runs at image-build time
# and writes the provider (with its prebuilt node-llama-cpp native runtime) under
# ~/.openclaw/npm/projects/. That path lives on the `openclaw-config` volume, which
# shadows the image-baked copy on upgrades — so the built provider is kept in
# /opt/llama-cpp-deps (non-volume) and copied into ~/.openclaw/npm here if absent,
# then the persisted plugin registry is refreshed so OpenClaw rediscovers it. This
# is what gives memory-core its key-less, OFFLINE `local` embedding provider — the
# backend Pinchy pins in agents.defaults.memorySearch (see MEMORY_EMBEDDING_MODEL_PATH
# in openclaw-config/build.ts). Without it, memory_search returns 0 chunks and
# agent recall silently fails. Same volume-shadow-defeating pattern as
# install_plugin_deps.
#
# Paths are env-overridable so the unit test can drive it against temp dirs;
# production uses the defaults.

LLAMA_CPP_DEPS_ROOT="${LLAMA_CPP_DEPS_ROOT:-/opt/llama-cpp-deps}"
OPENCLAW_NPM_ROOT="${OPENCLAW_NPM_ROOT:-/root/.openclaw/npm}"

stage_llama_cpp_provider() {
    [ -d "$LLAMA_CPP_DEPS_ROOT/npm" ] || return 0
    if ! ls -d "$OPENCLAW_NPM_ROOT"/projects/openclaw-llama-cpp-provider-* >/dev/null 2>&1; then
        echo "[llama-cpp] staging bundled embedding provider into ${OPENCLAW_NPM_ROOT}"
        mkdir -p "$OPENCLAW_NPM_ROOT"
        cp -r "$LLAMA_CPP_DEPS_ROOT"/npm/. "$OPENCLAW_NPM_ROOT"/
    fi
    # OpenClaw's plugin loader refuses a candidate whose files are not root-owned
    # ("blocked plugin candidate: suspicious ownership … uid=999, expected uid=0
    # or root"), and the openclaw-config volume is uid 999 nearly throughout
    # because Pinchy shares it. start-openclaw.sh already force-chowns
    # extensions/ for exactly this reason; npm/ holds a plugin too and was
    # missed, so on production the provider sat blocked and every memory_search
    # answered "Unknown memory embedding provider: local." (#1196).
    #
    # OUTSIDE the staging guard on purpose. The copy above runs at most once per
    # volume, so a tree staged by an earlier release is never rewritten — if the
    # repair rode along with the copy, an upgraded deployment would stay blocked
    # forever. That is the state #1196 was found in.
    #
    # Warn rather than swallow, same contract as the registry refresh below: a
    # silent failure here means recall regresses to 0 chunks with nothing said.
    if ! chown -R root:root "$OPENCLAW_NPM_ROOT" 2>/dev/null; then
        echo "[llama-cpp] WARNING: could not chown ${OPENCLAW_NPM_ROOT} to root — OpenClaw will block the embedding provider as 'suspicious ownership' and memory_search will return 0 chunks"
    fi
    # Idempotent, offline: rescans on-disk source roots (incl. the staged
    # provider) to rebuild the persisted registry so it loads. A silent failure
    # here means the provider never loads and recall regresses to 0 chunks — so
    # warn loudly instead of swallowing it, but stay non-fatal (boot continues;
    # the file-read fallback in memory-prompt.ts still works).
    if ! openclaw plugins registry --refresh >/dev/null 2>&1; then
        echo "[llama-cpp] WARNING: 'openclaw plugins registry --refresh' failed; embedding provider may not load — memory_search could return 0 chunks"
    fi
}
