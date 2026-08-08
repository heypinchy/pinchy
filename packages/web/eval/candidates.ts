/**
 * The default candidate model sets the two sweeps dispatch.
 *
 * These lived as `const`s inside their spec files, where nothing could check
 * them: a spec imports `@playwright/test`, so a vitest guard cannot reach it.
 * The rule they have to satisfy — every id exists in
 * `src/lib/ollama-cloud-models.ts` — was stated as a comment and broken twice
 * (see `src/__tests__/lib/eval/sweep-candidates.test.ts`). Extracting them into
 * a Playwright-free module is what lets that guard run in `pnpm test`, the same
 * move `eval/kb/sweep-agent.ts` and `eval/kb/chunk-texts.ts` made.
 *
 * Removing a retired id here governs only what a FUTURE sweep dispatches. The
 * numbers already measured for it stay published and citable — that is
 * `data/CHANGELOG.md`'s legacy policy, and the reason this file is not the
 * place to "clean up" a model's history.
 *
 * Both are overridable per run with `EVAL_CANDIDATE_MODELS`, which is why
 * `assertCandidatesDispatchable` below exists: the vitest guard can only see
 * the two lists in this file, and the override is the path an operator types
 * by hand.
 */

import { TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS } from "../src/lib/ollama-cloud-models";

/** Provider prefix every candidate id carries, stripped to index the catalog. */
export const OLLAMA_CLOUD_PREFIX = "ollama-cloud/";

const SERVED_IDS: ReadonlySet<string> = new Set(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS);

/**
 * The curated candidate set for the public open-weight agent-reliability
 * benchmark (pinchy#669). Chosen for vendor breadth AND intra-family
 * comparisons (does the bigger/newer sibling actually behave better on a real
 * tool-using workflow?).
 */
export const DEFAULT_INVOICE_CANDIDATES = [
  // — the original eight, now seven: `glm-4.7` sat here until Ollama retired
  //   it on 2026-07-15. (The published 2026-07-11 sweep in `data/` already ran
  //   all 14, expansion included — this block is a lineage, not a sweep.) —
  "ollama-cloud/kimi-k2.6",
  "ollama-cloud/gemma4:31b",
  "ollama-cloud/glm-5.2",
  "ollama-cloud/qwen3.5:397b",
  "ollama-cloud/minimax-m3",
  "ollama-cloud/gpt-oss:120b",
  "ollama-cloud/mistral-large-3:675b",
  // — breadth expansion: new vendors (DeepSeek, NVIDIA) + intra-family pairs.
  //   `deepseek-v3.2` sat here, retired in the same 2026-07-15 wave —
  "ollama-cloud/deepseek-v4-pro",
  "ollama-cloud/nemotron-3-ultra",
  "ollama-cloud/gpt-oss:20b",
  "ollama-cloud/glm-5.1",
  "ollama-cloud/minimax-m2.7",
];

/**
 * The KB Layer-3 candidate set. Deliberately SMALLER than the invoice set —
 * the groundedness gate is per-sentence NLI-judged, k=3 by default
 * (`nli.ts`'s `DEFAULT_NLI_K`), against every GOLD_QA item, so the call count
 * multiplies fast (models × goldQAs × sentences × k).
 */
export const DEFAULT_KB_CANDIDATES = [
  "ollama-cloud/kimi-k2.6",
  // Z.ai's slot, held by `glm-4.7` until its 2026-07-15 retirement. Kept as
  // the same family's successor rather than dropped: the four entries buy
  // vendor breadth (Moonshot / Z.ai / Alibaba / OpenAI), and removing one
  // would narrow what the sweep can say about groundedness across vendors.
  //
  // Read a weak glm-5.2 score here with that in mind: the family is
  // thinking-by-default and emits tool calls in its own format, and over
  // ollama-cloud's OpenAI `/v1` path we have already observed the result —
  // `odoo_create` reported success while nothing persisted (2026-06-25).
  // A KB run that never lands its `knowledge_search` call scores ungrounded
  // for a transport reason, not a groundedness one. That is a finding worth
  // having, but only if it is attributed correctly.
  "ollama-cloud/glm-5.2",
  "ollama-cloud/qwen3.5:397b",
  "ollama-cloud/gpt-oss:120b",
];

/**
 * The candidate ids the curated catalog does not serve, as written (not bare),
 * so an error message can echo back exactly what was typed. A missing provider
 * prefix counts as unserved too — `kimi-k2.6` without it is not an id any
 * dispatch path resolves.
 */
export function unservedCandidates(candidates: readonly string[]): string[] {
  return candidates.filter(
    (id) =>
      !id.startsWith(OLLAMA_CLOUD_PREFIX) || !SERVED_IDS.has(id.slice(OLLAMA_CLOUD_PREFIX.length))
  );
}

/**
 * Refuses a candidate set no sweep should dispatch — BEFORE the stack boots
 * and a real key is spent.
 *
 * `sweep-candidates.test.ts` checks the two lists above at `pnpm test` time,
 * but a sweep rarely runs them unmodified: `EVAL_CANDIDATE_MODELS` overrides
 * them wholesale, and the `run-model-eval` skill's iron rule 2 tells the
 * operator to probe with exactly that env var before every full sweep. A typo
 * or a just-retired id there hits the same silent failure the guard was
 * written for — every run 404s, the rows land as `run-infra-error`, the
 * exporter drops them from `n`, and the scorecard quietly holds fewer models
 * than the operator believes they measured.
 *
 * So the override gets the same three guarantees the defaults have (prefixed,
 * served, distinct), plus a non-empty check: `EVAL_CANDIDATE_MODELS=","`
 * currently produces an empty set and a sweep that "succeeds" measuring
 * nothing.
 *
 * There is deliberately no escape hatch for a model missing from the catalog.
 * The catalog is generated from what the provider serves (`pnpm
 * models:discover`, iron rule 1), so refreshing it is both the fix and the
 * step that should have happened first.
 */
export function assertCandidatesDispatchable(candidates: readonly string[], source: string): void {
  if (candidates.length === 0) {
    throw new Error(
      `${source} resolves to an empty candidate set. The sweep would boot the ` +
        `stack, dispatch nothing and export an empty scorecard — which reads as ` +
        `a clean run. Name at least one model.`
    );
  }

  const unserved = unservedCandidates(candidates);
  if (unserved.length > 0) {
    throw new Error(
      `${source} names models the curated catalog does not serve: ` +
        `${unserved.join(", ")}. Every run against these 404s and lands as a ` +
        `run-infra-error row the exporter drops from n, so the scorecard would ` +
        `quietly measure fewer models than intended. Ids need the ` +
        `"${OLLAMA_CLOUD_PREFIX}" prefix and must exist in ` +
        `src/lib/ollama-cloud-models.ts — run \`pnpm models:discover\` to ` +
        `refresh it before blaming the id.`
    );
  }

  const duplicates = [...new Set(candidates.filter((id, i) => candidates.indexOf(id) !== i))];
  if (duplicates.length > 0) {
    throw new Error(
      `${source} names the same model twice: ${duplicates.join(", ")}. Both ` +
        `copies write rows under one model key, so that cell's n comes out a ` +
        `multiple of every other cell's and the sweep costs more than it reports.`
    );
  }
}
