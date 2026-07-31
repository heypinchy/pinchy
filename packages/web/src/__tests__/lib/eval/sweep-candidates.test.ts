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
 * Retired models keep their published numbers — every superseded version stays
 * published and citable, per `eval/data/CHANGELOG.md`. This guard only governs
 * what a FUTURE sweep would dispatch.
 */

import { describe, expect, it } from "vitest";

import { TOOL_CAPABLE_OLLAMA_CLOUD_MODELS } from "@/lib/ollama-cloud-models";
import { DEFAULT_KB_JUDGE_MODEL } from "@/lib/eval/kb/llm-nli";

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

/**
 * The KB sweep dispatches one model the candidate lists do not name: the
 * NLI/relevance judge (`llm-nli.ts`). It is deliberately pinned and separate
 * from the models under test, so score drift over a long sweep reflects the
 * candidate's behavior rather than the judge's — which is exactly why it is
 * the id nobody thinks to re-check after a retirement wave.
 *
 * Its failure is louder than a candidate's (`createOllamaCloudChatFn` throws
 * on a non-2xx, and the spec's `withRetry` gives up after 4 attempts) but it
 * arrives later and costs more: the sweep has already booted the stack, seeded
 * the corpus and spent a real key by the time the first sentence is judged.
 */
describe("the KB sweep's pinned NLI judge", () => {
  it("carries the ollama-cloud provider prefix", () => {
    expect(DEFAULT_KB_JUDGE_MODEL.startsWith(OLLAMA_CLOUD_PREFIX)).toBe(true);
  });

  it("names a model the curated catalog still serves", () => {
    const bare = DEFAULT_KB_JUDGE_MODEL.slice(OLLAMA_CLOUD_PREFIX.length);

    expect(
      SERVED_IDS.has(bare),
      `The pinned judge \`${bare}\` is not in TOOL_CAPABLE_OLLAMA_CLOUD_MODELS. ` +
        `Every NLI verdict would fail against a retired judge, so no KB run ` +
        `can be graded at all — after the stack is up and the key is spent. ` +
        `Repin DEFAULT_KB_JUDGE_MODEL in src/lib/eval/kb/llm-nli.ts.`
    ).toBe(true);
  });
});
