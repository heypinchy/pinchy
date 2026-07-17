// packages/web/eval/kb/run-kb-eval.test.ts
//
// Unit tests for the keyless/pure parts of run-kb-eval.ts (Task 3.4): the
// (model, goldId) resume filter and the --corpus=synthetic|noack switch. The
// JSONL/scorecard I/O (appendRunResult/readExistingRuns/writeScorecard) is
// straight filesystem plumbing identical in shape to ../run-eval.ts's
// already-exercised equivalents and is exercised for real by the live sweep
// (kb-eval-models.spec.ts), not re-tested here.
import { describe, expect, it } from "vitest";

import {
  corpusFromEnv,
  countRunsForPair,
  noackCorpusDir,
  pendingPairs,
  retrievedSourcesFromAuditEntries,
  scorecardRuns,
} from "./run-kb-eval";
import type { KbRunResult } from "../../src/lib/eval/kb/answer-graders";
import type { KnowledgeSearchAuditEntry } from "./run-kb-eval";

function run(overrides: Partial<KbRunResult> = {}): KbRunResult {
  return {
    model: "ollama-cloud/kimi-k2.6",
    scenario: "gqa-happy-1",
    passed: true,
    tags: [],
    notes: [],
    latencyMs: 1000,
    ...overrides,
  };
}

describe("countRunsForPair", () => {
  it("counts only runs matching BOTH model and goldId (scenario)", () => {
    const existing: KbRunResult[] = [
      run({ model: "model-a", scenario: "gqa-happy-1" }),
      run({ model: "model-a", scenario: "gqa-happy-1" }),
      run({ model: "model-a", scenario: "gqa-happy-2" }),
      run({ model: "model-b", scenario: "gqa-happy-1" }),
    ];

    expect(countRunsForPair(existing, "model-a", "gqa-happy-1")).toBe(2);
    expect(countRunsForPair(existing, "model-a", "gqa-happy-2")).toBe(1);
    expect(countRunsForPair(existing, "model-b", "gqa-happy-1")).toBe(1);
    expect(countRunsForPair(existing, "model-b", "gqa-happy-2")).toBe(0);
  });
});

describe("pendingPairs (resume filter)", () => {
  it("returns every (model, goldId) pair when nothing is persisted yet", () => {
    const pending = pendingPairs([], ["model-a", "model-b"], ["gqa-1", "gqa-2"], 1);

    expect(pending).toEqual([
      { model: "model-a", goldId: "gqa-1", alreadyDone: 0 },
      { model: "model-a", goldId: "gqa-2", alreadyDone: 0 },
      { model: "model-b", goldId: "gqa-1", alreadyDone: 0 },
      { model: "model-b", goldId: "gqa-2", alreadyDone: 0 },
    ]);
  });

  it("skips a (model, goldId) pair that already has n runs on disk (the resume case)", () => {
    const existing: KbRunResult[] = [run({ model: "model-a", scenario: "gqa-1" })];

    const pending = pendingPairs(existing, ["model-a"], ["gqa-1", "gqa-2"], 1);

    // gqa-1 already has its 1 run — only gqa-2 is still pending.
    expect(pending).toEqual([{ model: "model-a", goldId: "gqa-2", alreadyDone: 0 }]);
  });

  it("carries forward alreadyDone for a pair with SOME but not all of n runs done", () => {
    const existing: KbRunResult[] = [run({ model: "model-a", scenario: "gqa-1" })];

    const pending = pendingPairs(existing, ["model-a"], ["gqa-1"], 3);

    expect(pending).toEqual([{ model: "model-a", goldId: "gqa-1", alreadyDone: 1 }]);
  });

  it("returns an empty list once every pair has reached n (fully resumed sweep is a no-op)", () => {
    const existing: KbRunResult[] = [
      run({ model: "model-a", scenario: "gqa-1" }),
      run({ model: "model-a", scenario: "gqa-1" }),
    ];

    expect(pendingPairs(existing, ["model-a"], ["gqa-1"], 2)).toEqual([]);
  });

  it("a run for a DIFFERENT scenario never counts toward this pair (non-vacuous: the filter actually discriminates)", () => {
    // Same model, but every existing run is for a DIFFERENT goldId than the
    // one pendingPairs is asked about — proves the filter isn't vacuously
    // "any run for this model satisfies any goldId."
    const existing: KbRunResult[] = [
      run({ model: "model-a", scenario: "gqa-other" }),
      run({ model: "model-a", scenario: "gqa-other" }),
    ];

    const pending = pendingPairs(existing, ["model-a"], ["gqa-1"], 1);

    expect(pending).toEqual([{ model: "model-a", goldId: "gqa-1", alreadyDone: 0 }]);
  });
});

describe("corpusFromEnv", () => {
  it("defaults to synthetic with no env/argv input", () => {
    expect(corpusFromEnv({}, [])).toBe("synthetic");
  });

  it("honors --corpus=synthetic explicitly", () => {
    expect(corpusFromEnv({}, ["node", "script.js", "--corpus=synthetic"])).toBe("synthetic");
  });

  it("honors KB_EVAL_CORPUS=synthetic via env", () => {
    expect(corpusFromEnv({ KB_EVAL_CORPUS: "synthetic" }, [])).toBe("synthetic");
  });

  it("rejects an unknown --corpus value", () => {
    expect(() => corpusFromEnv({}, ["--corpus=bogus"])).toThrow(/Unknown --corpus value/);
  });

  it("honors --corpus=noack ONLY with the explicit local opt-in (KB_EVAL_CORPUS_DIR set, no CI)", () => {
    expect(corpusFromEnv({ KB_EVAL_CORPUS_DIR: "/opt/noack-corpus" }, ["--corpus=noack"])).toBe(
      "noack"
    );
  });

  it("rejects --corpus=noack when KB_EVAL_CORPUS_DIR is not set, even outside CI", () => {
    expect(() => corpusFromEnv({}, ["--corpus=noack"])).toThrow(/KB_EVAL_CORPUS_DIR/);
  });

  it("hard-errors on --corpus=noack when CI is set, even with KB_EVAL_CORPUS_DIR present", () => {
    expect(() =>
      corpusFromEnv({ CI: "1", KB_EVAL_CORPUS_DIR: "/opt/noack-corpus" }, ["--corpus=noack"])
    ).toThrow(/CI/);
  });

  it("hard-errors on KB_EVAL_CORPUS=noack (env-only selection) when CI is set", () => {
    expect(() =>
      corpusFromEnv({ CI: "true", KB_EVAL_CORPUS: "noack", KB_EVAL_CORPUS_DIR: "/x" }, [])
    ).toThrow(/CI/);
  });

  it("a bare --corpus flag with no value does not silently select noack (falls through to the unknown-value error)", () => {
    // Regression guard for a naive regex: "--corpus=" with an empty value
    // must not be treated as falsy-and-ignored (which would silently fall
    // through to the synthetic default) OR misparsed into "noack".
    expect(() => corpusFromEnv({}, ["--corpus="])).toThrow(/Unknown --corpus value ""/);
  });
});

describe("retrievedSourcesFromAuditEntries", () => {
  function entry(
    returnedDocumentIds: Array<{ id: string; name: string }>
  ): KnowledgeSearchAuditEntry {
    return { detail: { toolName: "knowledge_search", success: true, returnedDocumentIds } };
  }

  it("builds RetrievedSource[] from returnedDocumentIds, n assigned by insertion order, page always null", () => {
    const entries = [
      entry([
        { id: "/data/it-equipment-policy.md", name: "it-equipment-policy.md" },
        { id: "/data/onboarding-part1.md", name: "onboarding-part1.md" },
      ]),
    ];

    expect(retrievedSourcesFromAuditEntries(entries)).toEqual([
      { n: 1, sourcePath: "/data/it-equipment-policy.md", page: null },
      { n: 2, sourcePath: "/data/onboarding-part1.md", page: null },
    ]);
  });

  it("dedupes the same sourcePath appearing across MULTIPLE knowledge_search calls (audit rows), keeping first-seen order", () => {
    const entries = [
      entry([{ id: "/data/it-equipment-policy.md", name: "it-equipment-policy.md" }]),
      entry([
        { id: "/data/onboarding-part1.md", name: "onboarding-part1.md" },
        { id: "/data/it-equipment-policy.md", name: "it-equipment-policy.md" },
      ]),
    ];

    expect(retrievedSourcesFromAuditEntries(entries)).toEqual([
      { n: 1, sourcePath: "/data/it-equipment-policy.md", page: null },
      { n: 2, sourcePath: "/data/onboarding-part1.md", page: null },
    ]);
  });

  it("returns an empty array when no audit entry carries returnedDocumentIds (e.g. a failed/no-result search)", () => {
    expect(
      retrievedSourcesFromAuditEntries([{ detail: { toolName: "knowledge_search" } }])
    ).toEqual([]);
    expect(retrievedSourcesFromAuditEntries([{ detail: null }])).toEqual([]);
    expect(retrievedSourcesFromAuditEntries([])).toEqual([]);
  });

  it("ignores a malformed entry (non-string id) without throwing", () => {
    const entries: KnowledgeSearchAuditEntry[] = [
      { detail: { returnedDocumentIds: [{ id: 42, name: "bad" }] } },
    ];
    expect(retrievedSourcesFromAuditEntries(entries)).toEqual([]);
  });
});

describe("scorecardRuns (invalid-trial exclusion)", () => {
  it("drops run-infra-error rows so a harness flake never counts as a model failure", () => {
    const runs: KbRunResult[] = [
      run({ model: "model-a", passed: true, tags: [] }),
      run({ model: "model-a", passed: false, tags: ["run-infra-error"] }),
      run({ model: "model-a", passed: false, tags: ["ungrounded-claim"] }),
    ];

    const valid = scorecardRuns(runs);

    expect(valid).toHaveLength(2);
    expect(valid.some((r) => r.tags.includes("run-infra-error"))).toBe(false);
    // A genuine model failure (ungrounded-claim) is kept — only the invalid
    // trial is excluded, matching export-kb-scorecard.ts's aggregateKbResults.
    expect(valid.some((r) => r.tags.includes("ungrounded-claim"))).toBe(true);
  });

  it("keeps every run when none is an invalid trial", () => {
    const runs: KbRunResult[] = [
      run({ passed: true }),
      run({ passed: false, tags: ["off-topic-grounded"] }),
    ];
    expect(scorecardRuns(runs)).toHaveLength(2);
  });
});

describe("noackCorpusDir", () => {
  it("returns the trimmed directory when KB_EVAL_CORPUS_DIR is set", () => {
    expect(noackCorpusDir({ KB_EVAL_CORPUS_DIR: "  /opt/noack-corpus  " })).toBe(
      "/opt/noack-corpus"
    );
  });

  it("throws when KB_EVAL_CORPUS_DIR is unset", () => {
    expect(() => noackCorpusDir({})).toThrow(/KB_EVAL_CORPUS_DIR/);
  });
});
