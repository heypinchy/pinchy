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
 * What this file cannot see is the set an operator types by hand
 * (`EVAL_CANDIDATE_MODELS`), which is the set most sweeps actually dispatch —
 * iron rule 2 makes every probe use it. That path is guarded at runtime by
 * `assertCandidatesDispatchable`, whose behavior is pinned at the bottom of
 * this file, so both halves of the same rule live in one place.
 *
 * Retired models keep their published numbers — every superseded version stays
 * published and citable, per `eval/data/CHANGELOG.md`. This guard only governs
 * what a FUTURE sweep would dispatch.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_KB_JUDGE_MODEL } from "@/lib/eval/kb/llm-nli";

import {
  DEFAULT_INVOICE_CANDIDATES,
  DEFAULT_KB_CANDIDATES,
  OLLAMA_CLOUD_PREFIX,
  assertCandidatesDispatchable,
  assertJudgeDispatchable,
  candidateModelsFromEnv,
  judgeModelFromEnv,
  unservedCandidates,
} from "../../../../eval/candidates";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The message a refusal carried, so a case can assert WHICH check fired rather
 * than only that something did. Two of these refusals differ by their advice,
 * and a test matching the model id alone passes for either one.
 */
function refusalMessage(call: () => unknown): string {
  try {
    call();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("Expected the call to refuse, but it returned normally.");
}

const EVAL_DIR = path.join(__dirname, "..", "..", "..", "..", "eval");

const README = await readFile(path.join(EVAL_DIR, "README.md"), "utf8");

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
    // Through the same oracle the runtime guard uses, so the checked-in lists
    // and a hand-typed override can never disagree about what "served" means.
    const retired = unservedCandidates(candidates);

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
    const [unserved] = unservedCandidates([DEFAULT_KB_JUDGE_MODEL]);

    expect(
      unserved,
      `The pinned judge \`${DEFAULT_KB_JUDGE_MODEL}\` is not in ` +
        `TOOL_CAPABLE_OLLAMA_CLOUD_MODELS. Every NLI verdict would fail against ` +
        `a retired judge, so no KB run can be graded at all — after the stack is ` +
        `up and the key is spent. Repin DEFAULT_KB_JUDGE_MODEL in ` +
        `src/lib/eval/kb/llm-nli.ts.`
    ).toBeUndefined();
  });

  it("stays out of the candidate sets, so it never grades its own runs", () => {
    // The pin only buys independence while the judge is not also under test.
    // Nothing structural prevents the overlap: `gpt-oss:20b` — the judge — is
    // already a live id in DEFAULT_INVOICE_CANDIDATES, one copy-paste from the
    // KB list. A judge grading its own output would move every groundedness
    // score for that one model without leaving a trace in the scorecard.
    expect(DEFAULT_KB_CANDIDATES).not.toContain(DEFAULT_KB_JUDGE_MODEL);
  });
});

/**
 * The runtime half: the same rule applied to whatever a sweep is about to
 * dispatch, whether it came from `candidates.ts` or from a shell.
 */
describe("assertCandidatesDispatchable", () => {
  it("accepts the checked-in defaults", () => {
    expect(() => assertCandidatesDispatchable(DEFAULT_INVOICE_CANDIDATES, "test")).not.toThrow();
    expect(() => assertCandidatesDispatchable(DEFAULT_KB_CANDIDATES, "test")).not.toThrow();
  });

  it("refuses a model the catalog no longer serves, naming it", () => {
    expect(() =>
      assertCandidatesDispatchable(["ollama-cloud/kimi-k2.6", "ollama-cloud/glm-4.7"], "test")
    ).toThrow(/glm-4\.7/);
  });

  it("refuses an id missing the provider prefix", () => {
    // Reaches the dispatch path as an unresolvable model rather than a typo.
    expect(() => assertCandidatesDispatchable(["kimi-k2.6"], "test")).toThrow(/kimi-k2\.6/);
  });

  it("tells a missing prefix apart from a retirement, so the advice fits", () => {
    // `kimi-k2.6` IS in the catalog — only the prefix is missing. Reporting it
    // as unserved states something false and sends the operator to `pnpm
    // models:discover`, which refreshes a catalog that already has the model
    // and leaves them exactly where they started. This guard exists to save
    // that hour, so its two refusals must not read alike.
    const message = refusalMessage(() => assertCandidatesDispatchable(["kimi-k2.6"], "test"));

    expect(message).toContain(`"${OLLAMA_CLOUD_PREFIX}"`);
    expect(message).not.toMatch(/does not serve/);
    expect(message).not.toMatch(/models:discover/);
  });

  it("refuses an empty set rather than exporting an empty scorecard", () => {
    expect(() => assertCandidatesDispatchable([], "test")).toThrow(/empty/i);
  });

  it("refuses the same model twice, which would double one cell's n", () => {
    expect(() =>
      assertCandidatesDispatchable(["ollama-cloud/kimi-k2.6", "ollama-cloud/kimi-k2.6"], "test")
    ).toThrow(/twice/i);
  });

  it("names its source, so the operator knows which set to fix", () => {
    expect(() => assertCandidatesDispatchable(["nope"], "EVAL_CANDIDATE_MODELS")).toThrow(
      /EVAL_CANDIDATE_MODELS/
    );
  });
});

/**
 * And the wiring, because an assertion nothing calls guards nothing: this is
 * the single function both sweeps and `kb/run-kb-eval.ts` resolve their
 * candidates through.
 */
describe("candidateModelsFromEnv", () => {
  it("returns the caller's default when the env var is unset", () => {
    vi.stubEnv("EVAL_CANDIDATE_MODELS", undefined);

    expect(candidateModelsFromEnv([...DEFAULT_KB_CANDIDATES])).toEqual(DEFAULT_KB_CANDIDATES);
  });

  it("parses a comma-separated override, trimming whitespace", () => {
    vi.stubEnv("EVAL_CANDIDATE_MODELS", "ollama-cloud/kimi-k2.6, ollama-cloud/gpt-oss:120b");

    expect(candidateModelsFromEnv([...DEFAULT_KB_CANDIDATES])).toEqual([
      "ollama-cloud/kimi-k2.6",
      "ollama-cloud/gpt-oss:120b",
    ]);
  });

  it("throws on an override naming a retired model, before anything is dispatched", () => {
    vi.stubEnv("EVAL_CANDIDATE_MODELS", "ollama-cloud/kimi-k2.6,ollama-cloud/glm-4.7");

    expect(() => candidateModelsFromEnv([...DEFAULT_KB_CANDIDATES])).toThrow(/glm-4\.7/);
    expect(() => candidateModelsFromEnv([...DEFAULT_KB_CANDIDATES])).toThrow(
      /EVAL_CANDIDATE_MODELS/
    );
  });

  it("throws on an override that parses to nothing", () => {
    vi.stubEnv("EVAL_CANDIDATE_MODELS", " , ");

    expect(() => candidateModelsFromEnv([...DEFAULT_KB_CANDIDATES])).toThrow(/empty/i);
  });
});

/**
 * The judge is the OTHER model a KB sweep dispatches, and it has the same
 * hand-typed override — `KB_EVAL_JUDGE_MODEL`. Both properties the two
 * describes above pin for the checked-in default (served, and not itself under
 * test) are properties of whatever the sweep ends up using, so they belong on
 * the resolved value rather than on the literal.
 *
 * A judge id is the more expensive of the two to get wrong: a bad candidate
 * costs that model's column, a bad judge fails every verdict, so NO KB run is
 * gradeable at all — discovered after the stack is up, the corpus is seeded and
 * a real key has been spent.
 */
describe("assertJudgeDispatchable", () => {
  it("accepts the pinned default against the checked-in KB set", () => {
    expect(() =>
      assertJudgeDispatchable(DEFAULT_KB_JUDGE_MODEL, DEFAULT_KB_CANDIDATES, "test")
    ).not.toThrow();
  });

  it("refuses a judge the catalog no longer serves", () => {
    expect(() =>
      assertJudgeDispatchable("ollama-cloud/glm-4.7", DEFAULT_KB_CANDIDATES, "test")
    ).toThrow(/glm-4\.7/);
  });

  it("refuses a judge that is also under test", () => {
    // The pin buys independence only while the judge is not a candidate. The
    // overlap leaves no trace in the scorecard: one model's groundedness column
    // is simply self-graded, and every other column is not.
    expect(() =>
      assertJudgeDispatchable("ollama-cloud/kimi-k2.6", DEFAULT_KB_CANDIDATES, "test")
    ).toThrow(/kimi-k2\.6/);
  });
});

describe("judgeModelFromEnv", () => {
  it("returns the pinned default when the env var is unset", () => {
    vi.stubEnv("KB_EVAL_JUDGE_MODEL", undefined);

    expect(judgeModelFromEnv(DEFAULT_KB_JUDGE_MODEL, DEFAULT_KB_CANDIDATES)).toBe(
      DEFAULT_KB_JUDGE_MODEL
    );
  });

  it("takes the override, trimming whitespace", () => {
    vi.stubEnv("KB_EVAL_JUDGE_MODEL", "  ollama-cloud/gpt-oss:120b  ");

    expect(judgeModelFromEnv(DEFAULT_KB_JUDGE_MODEL, [])).toBe("ollama-cloud/gpt-oss:120b");
  });

  it("throws on an override naming a retired judge, before anything is graded", () => {
    vi.stubEnv("KB_EVAL_JUDGE_MODEL", "ollama-cloud/glm-4.7");

    const message = refusalMessage(() =>
      judgeModelFromEnv(DEFAULT_KB_JUDGE_MODEL, DEFAULT_KB_CANDIDATES)
    );

    expect(message).toMatch(/glm-4\.7/);
    expect(message).toMatch(/KB_EVAL_JUDGE_MODEL/);
  });

  it("throws on an override that puts the judge in the candidate set", () => {
    vi.stubEnv("KB_EVAL_JUDGE_MODEL", "ollama-cloud/qwen3.5:397b");

    expect(() => judgeModelFromEnv(DEFAULT_KB_JUDGE_MODEL, DEFAULT_KB_CANDIDATES)).toThrow(
      /qwen3\.5:397b/
    );
  });

  it("names the pin, not the env var, when the default is the bad one", () => {
    vi.stubEnv("KB_EVAL_JUDGE_MODEL", undefined);

    expect(() => judgeModelFromEnv("ollama-cloud/glm-4.7", DEFAULT_KB_CANDIDATES)).toThrow(
      /DEFAULT_KB_JUDGE_MODEL/
    );
  });
});

/**
 * `eval/README.md` states both set sizes as prose. That is the same shape of
 * claim this whole file exists because of — a rule stated in a comment for two
 * sweeps and broken without anything going red. The counts are worth keeping
 * (a reader wants to know the sweep is 12 models, not 3), so they get parsed
 * out of the sentence rather than restated here: rewrite the sentence and this
 * guard tells you; change a list and it tells you that too.
 *
 * Same technique as `eval/__tests__/comparisons-published-guard.test.ts`.
 */
describe("eval/README.md's candidate-set claims", () => {
  /** Pulls one number out of a README sentence, failing loudly if it moved. */
  function claim(pattern: RegExp, what: string): number {
    const match = README.match(pattern);
    if (!match) {
      throw new Error(
        `eval/README.md no longer states ${what} in a form this guard can read ` +
          `(${pattern}). The claim and its guard must move together — update the ` +
          `regex if you rewrote the sentence, and re-check the number while you ` +
          `are there.`
      );
    }
    return Number(match[1]);
  }

  it("states the invoice sweep's size", () => {
    expect(
      claim(/leaving the \*\*(\d+)\*\* a sweep dispatches today/, "the invoice set size")
    ).toBe(DEFAULT_INVOICE_CANDIDATES.length);
  });

  it("states the KB sweep's size", () => {
    expect(claim(/deliberately smaller set of (\d+)/, "the KB set size")).toBe(
      DEFAULT_KB_CANDIDATES.length
    );
  });
});
