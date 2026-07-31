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
 * Both are overridable per run with `EVAL_CANDIDATE_MODELS`.
 */

/** Provider prefix every candidate id carries, stripped to index the catalog. */
export const OLLAMA_CLOUD_PREFIX = "ollama-cloud/";

/**
 * The curated candidate set for the public open-weight agent-reliability
 * benchmark (pinchy#669). Chosen for vendor breadth AND intra-family
 * comparisons (does the bigger/newer sibling actually behave better on a real
 * tool-using workflow?).
 */
export const DEFAULT_INVOICE_CANDIDATES = [
  // — original 8-model sweep (2026-07-11) —
  "ollama-cloud/kimi-k2.6",
  "ollama-cloud/gemma4:31b",
  // `glm-4.7` and `deepseek-v3.2` sat here until Ollama retired both on
  // 2026-07-15. Their measured numbers stay published (`data/CHANGELOG.md`);
  // only the serving path lost them, and a sweep that still dispatched them
  // collected 404s.
  "ollama-cloud/glm-5.2",
  "ollama-cloud/qwen3.5:397b",
  "ollama-cloud/minimax-m3",
  "ollama-cloud/gpt-oss:120b",
  "ollama-cloud/mistral-large-3:675b",
  // — breadth expansion: new vendors (DeepSeek, NVIDIA) + intra-family pairs —
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
  "ollama-cloud/glm-5.2",
  "ollama-cloud/qwen3.5:397b",
  "ollama-cloud/gpt-oss:120b",
];
