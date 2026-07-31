/**
 * Every sweep's default candidate list must name models Ollama still serves.
 *
 * `eval-models.spec.ts` has stated this rule in prose since the first sweep —
 * "Every id must exist in src/lib/ollama-cloud-models.ts
 * TOOL_CAPABLE_OLLAMA_CLOUD_MODELS" — and nothing checked it. By the time this
 * guard was written the rule was broken twice over: Ollama retired
 * `deepseek-v3.2` and `glm-4.7` on 2026-07-15, both stayed in the invoice
 * default, and `glm-4.7` was one of only four KB Layer-3 candidates.
 *
 * The cost is not abstract. A sweep dispatches the retired id anyway, every
 * run 404s, and the rows land as `run-infra-error` — which the exporter
 * excludes from `n`, so the published scorecard simply has one fewer model
 * than the operator believes they measured. On the KB sweep that is a quarter
 * of the candidate set failing silently, discovered only by reading the
 * results by hand.
 *
 * The `run-model-eval` skill's iron rule 1 ("refresh the catalog first") is
 * the live half of this: `pnpm models:discover` asks the provider what it
 * serves today. This is the offline half — it costs nothing, needs no key, and
 * runs in `pnpm test`, so a catalog refresh that removes a model can no longer
 * leave a sweep default pointing at it.
 *
 * Retired models keep their published numbers (`eval/data/README.md`); this
 * guard only governs what a FUTURE sweep would dispatch.
 */

import { describe, expect, it } from "vitest";

import { TOOL_CAPABLE_OLLAMA_CLOUD_MODELS } from "@/lib/ollama-cloud-models";

import {
  DEFAULT_INVOICE_CANDIDATES,
  DEFAULT_KB_CANDIDATES,
  OLLAMA_CLOUD_PREFIX,
} from "../../../../eval/candidates";

const SERVED_IDS = new Set<string>(TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.map((m) => m.id));

const SWEEPS: Array<{ name: string; candidates: readonly string[] }> = [
  { name: "invoice (eval-models.spec.ts)", candidates: DEFAULT_INVOICE_CANDIDATES },
  { name: "KB Layer-3 (kb/kb-eval-models.spec.ts)", candidates: DEFAULT_KB_CANDIDATES },
];

describe.each(SWEEPS)("the $name sweep's default candidates", ({ candidates }) => {
  it("names at least one model", () => {
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("carries the ollama-cloud provider prefix on every id", () => {
    const unprefixed = candidates.filter((id) => !id.startsWith(OLLAMA_CLOUD_PREFIX));

    expect(unprefixed).toEqual([]);
  });

  it("names only models the curated catalog still serves", () => {
    const retired = candidates
      .map((id) => id.slice(OLLAMA_CLOUD_PREFIX.length))
      .filter((bare) => !SERVED_IDS.has(bare));

    expect(
      retired,
      `Not in TOOL_CAPABLE_OLLAMA_CLOUD_MODELS: ${retired.join(", ")}. ` +
        `A sweep would dispatch these and collect run-infra-error rows the ` +
        `exporter drops, so the scorecard would quietly measure fewer models ` +
        `than intended. Remove them here — their already-published numbers stay.`
    ).toEqual([]);
  });

  it("lists each model once, so a cell cannot be measured twice", () => {
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});
