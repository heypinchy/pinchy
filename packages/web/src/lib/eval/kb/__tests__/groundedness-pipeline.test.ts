// packages/web/src/lib/eval/kb/__tests__/groundedness-pipeline.test.ts
//
// Deterministic, keyless, harness-integrity self-test for the KB eval
// harness's Layer-3 gate (KB Eval Harness plan, Task 3.6). Proves the FULL
// pipeline — gradeKbRun's four composed graders through buildScorecard's
// aggregation math — is wired correctly end to end, using a STUBBED NLI
// client and a scripted RelevanceJudge (see ./stub-nli-client.ts and
// answer-graders.test.ts's fixedRelevanceJudge pattern). This is NOT a model
// quality eval: every verdict is scripted, so the expected KbRunResult and
// scorecard numbers are exact, not fuzzy.
//
// This is the read-side guard the harness itself can't silently rot: if a
// future refactor breaks a tag mapping (e.g. gradeGroundedness stops pushing
// "ungrounded-claim") or breaks buildScorecard's generic Tag boundary, this
// test catches it — a stubbed NLI verdict + scripted answer must always
// produce the same known KbRunResult and the same known scorecard entry.
import { describe, expect, it } from "vitest";
import { buildScorecard } from "../../scorecard";
import { gradeKbRun } from "../answer-graders";
import type { KbRunTrajectory, RelevanceJudge } from "../answer-graders";
import type { RetrievedSource } from "../attribution-graders";
import { stubNliClient } from "./stub-nli-client";
import type { GoldQA, KbFailureTag } from "../types";

function src(n: number, sourcePath: string, page: number | null = 1): RetrievedSource {
  return { n, sourcePath, page };
}

/** Always scores `score`, regardless of query/answer — a scripted, not judged, relevance verdict. */
function fixedRelevanceJudge(score: number): RelevanceJudge {
  return { score: async () => score };
}

const MODEL = "self-test-model";

describe("groundedness pipeline self-test: gradeKbRun -> buildScorecard, end to end", () => {
  // --- Fixture 1: grounded, on-topic answer with a clean Sources list. ---
  const groundedGold: GoldQA = {
    id: "q-grounded",
    lang: "en",
    query: "How long must invoices be retained?",
    relevantChunkIds: ["c1"],
    axis: "happy",
    referenceAnswer: "Seven years.",
  };
  const groundedTraj: KbRunTrajectory = {
    model: MODEL,
    query: groundedGold.query,
    answer: `Invoices must be retained for seven years [1].

**Sources:**

- [1] /data/handbook/retention.md — p. 4`,
    retrieved: [src(1, "/data/handbook/retention.md")],
    citedPassageTexts: ["Invoices must be kept on file for a period of seven years."],
    latencyMs: 100,
    tokens: { prompt: 50, completion: 20 },
  };
  // Scripted NLI: the one cited sentence is highly entailed by the cited
  // passage — a deterministic "grounded" verdict, not a real model judgment.
  const groundedNli = stubNliClient([0.95]);

  // --- Fixture 2: an answer with one ungrounded sentence. ---
  const ungroundedGold: GoldQA = {
    id: "q-ungrounded",
    lang: "en",
    query: "What color is the company logo?",
    relevantChunkIds: ["c2"],
    axis: "happy",
    referenceAnswer: "Blue.",
  };
  const ungroundedTraj: KbRunTrajectory = {
    model: MODEL,
    query: ungroundedGold.query,
    answer: `The company logo is bright purple with gold trim [1].

**Sources:**

- [1] /data/brand/style-guide.md — p. 1`,
    retrieved: [src(1, "/data/brand/style-guide.md")],
    citedPassageTexts: ["The company logo is a solid navy blue circle."],
    latencyMs: 110,
    tokens: { prompt: 45, completion: 18 },
  };
  // Scripted NLI: this sentence scores LOW against its cited passage — a
  // deterministic "not entailed" verdict (the passage says navy blue, the
  // answer claims purple/gold).
  const ungroundedNli = stubNliClient([0.1]);

  // --- Fixture 3: a correct abstention (gold says the corpus can't answer). ---
  const abstentionGold: GoldQA = {
    id: "q-abstain",
    lang: "en",
    query: "What is the CEO's home address?",
    relevantChunkIds: [],
    axis: "happy",
    referenceAnswer: "",
    expectAbstention: true,
  };
  const abstentionTraj: KbRunTrajectory = {
    model: MODEL,
    query: abstentionGold.query,
    answer: "I couldn't find this in the knowledge base.",
    retrieved: [],
    citedPassageTexts: [],
    latencyMs: 60,
    tokens: { prompt: 20, completion: 10 },
  };
  // NLI is never consulted for a correctly-abstained answer (gradeGroundednessForGold's
  // expectAbstention short-circuit) — any client would do; reuse groundedNli.

  it("grades all three fixtures to their known KbRunResult, then buildScorecard<KbFailureTag> aggregates them correctly", async () => {
    const relevance = fixedRelevanceJudge(0.9);

    const grounded = await gradeKbRun(groundedTraj, groundedGold, { nli: groundedNli, relevance });
    const ungrounded = await gradeKbRun(ungroundedTraj, ungroundedGold, {
      nli: ungroundedNli,
      relevance,
    });
    const abstained = await gradeKbRun(abstentionTraj, abstentionGold, {
      nli: groundedNli,
      relevance,
    });

    // Per-run KbRunResult assertions — the exact, scripted verdicts.
    expect(grounded).toEqual({
      model: MODEL,
      passed: true,
      tags: [],
      notes: [],
      latencyMs: 100,
      tokens: { prompt: 50, completion: 20 },
    });

    expect(ungrounded.passed).toBe(false);
    expect(ungrounded.tags).toEqual<KbFailureTag[]>(["ungrounded-claim"]);
    expect(ungrounded.latencyMs).toBe(110);
    expect(ungrounded.tokens).toEqual({ prompt: 45, completion: 18 });

    expect(abstained).toEqual({
      model: MODEL,
      passed: true,
      tags: [],
      notes: [],
      latencyMs: 60,
      tokens: { prompt: 20, completion: 10 },
    });

    // Feed the three KbRunResults straight into the SAME buildScorecard the
    // invoice harness uses — this is the Task 3.5/Part-1 boundary: no cast,
    // no KB-specific reimplementation.
    const runs = [grounded, ungrounded, abstained];
    const scorecard = buildScorecard<KbFailureTag>(runs);

    expect(scorecard).toHaveLength(1);
    const entry = scorecard[0]!;
    expect(entry.model).toBe(MODEL);
    expect(entry.n).toBe(3);
    expect(entry.passes).toBe(2);
    expect(entry.passRate).toBeCloseTo(2 / 3, 5);

    // wilson95 present and a genuine interval bracketing passRate.
    expect(entry.wilson95).toHaveLength(2);
    const [lower, upper] = entry.wilson95;
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(upper).toBeLessThanOrEqual(1);
    expect(lower).toBeLessThanOrEqual(entry.passRate);
    expect(upper).toBeGreaterThanOrEqual(entry.passRate);

    // pass^k: one run failed, so all-k consistency is 0 even though passRate is 2/3.
    expect(entry.passCaretK).toBe(0);

    // tagHistogram counts the KB tag exactly once (only the ungrounded run carries a tag).
    expect(entry.tagHistogram).toEqual({ "ungrounded-claim": 1 });

    expect(entry.medianLatencyMs).toBe(100);
    // median of {70, 63, 30} total tokens (60+... wait computed below) — see
    // dedicated assertion for the exact figure, kept out of this composite
    // check to document the arithmetic explicitly.
    const totalTokens = [70, 63, 30]; // 50+20, 45+18, 20+10
    const sorted = [...totalTokens].sort((a, b) => a - b); // [30, 63, 70]
    expect(entry.medianTokens).toBe(sorted[1]);
  });
});
