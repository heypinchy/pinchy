/**
 * Global operational ceiling on the *effective* runtime context budget Pinchy
 * ships to OpenClaw as `models.providers.*.models[].contextTokens`.
 *
 * OpenClaw's shouldCompact() fires when the measured context exceeds
 * `(contextTokens ?? contextWindow) − reserveTokens` (reserveTokens=16384). For
 * a model with a large native window and no cap, that threshold sits so high it
 * never fires in practice: glm-5.2 (999,424) would only compact past 983,040.
 * The 2026-07-24 Piper incident ran a glm-5.2 session to ~633K input tokens with
 * compactionCount:0 — a single uncached turn then reprocessed all 633K tokens
 * (543s) and the multi-MB session file blocked Node's event loop on every poll.
 *
 * The per-model deepseek-v4-pro cap (2026-07-16) did NOT generalize; capping one
 * model at a time leaks the moment another large-window model is used. This is a
 * blanket bound — an operational limit on worst-case turn latency and cache-miss
 * cost, distinct from a per-model quality knee — so every model (current and
 * future) gets a compaction trigger no higher than this.
 *
 * 262144 (256K) is not arbitrary: it is the largest native window that already
 * compacts healthily in production (kimi-k2.6, observed compactionCount up to
 * 79), i.e. a proven-tolerable operating point in this very deployment.
 *
 * Known limitation: because the clamp below takes the `min`, this is a HARD
 * upper bound — a per-model `contextTokens` can only pull the effective budget
 * *below* it, never above. If a future model genuinely warrants a >256K
 * effective window (a proven-healthy large-context model whose worst-case turn
 * latency we accept), raising it means lifting this global constant, not adding
 * a per-model override — deliberately so, to keep the bug *class* closed by
 * default.
 */
export const MAX_EFFECTIVE_CONTEXT_TOKENS = 262144;

/**
 * Clamps the effective context budget of every model in the emitted
 * `models.providers` tree, in place.
 *
 * This runs as a single choke point over the finished tree rather than at each
 * provider block, and that placement is the whole point: Pinchy emits models
 * from four independent paths (built-in catalogs, ollama-cloud, locally
 * discovered Ollama models, and admin-configured OpenAI-compatible providers),
 * and three of them shipped uncapped windows — built-in Gemini alone advertises
 * 1,048,576. Capping them one call site at a time would repeat exactly the
 * per-model whack-a-mole that let the incident happen after deepseek-v4-pro was
 * already capped. Clamping the assembled tree means a future fifth path is
 * covered the day it is added, without anyone remembering to opt in.
 *
 * A model's own `contextTokens` (a researched per-model quality knee, e.g.
 * deepseek-v4-pro's 131072) is preserved where it is already lower — the clamp
 * only ever lowers, never raises.
 *
 * Models with no numeric `contextWindow` are left untouched: without a window
 * there is no honest budget to derive, and inventing one could claim MORE
 * context than the model actually supports. OpenClaw resolves those from its
 * own catalog instead.
 */
export function applyEffectiveContextCeiling(providers: Record<string, unknown>): void {
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;

    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const entry = model as { contextWindow?: unknown; contextTokens?: unknown };

      const knee = typeof entry.contextTokens === "number" ? entry.contextTokens : undefined;
      const window = typeof entry.contextWindow === "number" ? entry.contextWindow : undefined;
      const budget = knee ?? window;
      if (budget === undefined) continue;

      entry.contextTokens = Math.min(budget, MAX_EFFECTIVE_CONTEXT_TOKENS);
    }
  }
}
