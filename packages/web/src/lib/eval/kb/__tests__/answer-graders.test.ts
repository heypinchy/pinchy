import { describe, expect, it } from "vitest";

import { gradeAnswerRelevance, gradeCitationCorrectness, gradeKbRun } from "../answer-graders";
import type { AnswerRelevanceOptions, KbRunTrajectory, RelevanceJudge } from "../answer-graders";
import type { RetrievedSource } from "../attribution-graders";
import { stubNliClient } from "./stub-nli-client";
import type { GoldQA, KbGraderResult } from "../types";

function src(n: number, sourcePath: string, page: number | null = 1): RetrievedSource {
  return { n, sourcePath, page };
}

/** A RelevanceJudge that always returns the given score, regardless of input. */
function fixedRelevanceJudge(score: number): RelevanceJudge {
  return { score: async () => score };
}

/** A NliClient stub that entails everything highly (used to keep groundedness/relevance out of the way). */
function highScoreNli() {
  return stubNliClient(() => ({ label: "entailment" as const, score: 0.95 }));
}

describe("gradeAnswerRelevance", () => {
  it("passes an on-topic answer (judge scores high)", async () => {
    const judge = fixedRelevanceJudge(0.9);

    const result = await gradeAnswerRelevance(
      "The retention policy requires seven years [1].",
      "How long must records be retained?",
      judge
    );

    expect(result).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("flags an off-topic answer (judge scores low) with off-topic-grounded, noting score and tau", async () => {
    const judge = fixedRelevanceJudge(0.2);

    const result = await gradeAnswerRelevance(
      "Our office is open Monday through Friday [1].",
      "How long must records be retained?",
      judge
    );

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["off-topic-grounded"]);
    expect(result.notes[0]).toMatch(/0\.20/);
    expect(result.notes[0]).toMatch(/τ=0\.5/);
  });

  it("passes an abstention answer regardless of the judge's score, without calling the judge", async () => {
    let called = false;
    const judge: RelevanceJudge = {
      score: async () => {
        called = true;
        return 0;
      },
    };

    const result = await gradeAnswerRelevance(
      "I couldn't find this in the knowledge base.",
      "How long must records be retained?",
      judge
    );

    expect(result).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
    expect(called).toBe(false);
  });

  it("respects a custom tau", async () => {
    const judge = fixedRelevanceJudge(0.55);
    const opts: AnswerRelevanceOptions = { tau: 0.6 };

    const result = await gradeAnswerRelevance("Some answer [1].", "Some query?", judge, opts);

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["off-topic-grounded"]);
  });

  it("grades the answer BODY only, stripping the Sources list before scoring", async () => {
    let seenAnswer = "";
    const judge: RelevanceJudge = {
      score: async (_query, answer) => {
        seenAnswer = answer;
        return 0.9;
      },
    };

    await gradeAnswerRelevance(
      `The retention policy requires seven years [1].

**Sources:**

- [1] /data/handbook/policy.md — p. 12`,
      "How long must records be retained?",
      judge
    );

    expect(seenAnswer).not.toMatch(/Sources/);
    expect(seenAnswer).not.toMatch(/\/data\//);
  });
});

describe("gradeCitationCorrectness", () => {
  it("passes when every cited Sources path is in the retrieved set", () => {
    const answer = `The policy requires review [1].

**Sources:**

- [1] /data/handbook/policy.md — p. 1`;

    const result = gradeCitationCorrectness(answer, [src(1, "/data/handbook/policy.md")]);

    expect(result).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("flags a cited path NOT in the run's retrieved set as path-not-cited, naming the fabricated path", () => {
    const answer = `The policy requires review [1].

**Sources:**

- [1] /data/handbook/fabricated-policy.md — p. 1`;

    // The run's real retrieved set never contained this path at all.
    const result = gradeCitationCorrectness(answer, [src(1, "/data/handbook/real-policy.md")]);

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["path-not-cited"]);
    expect(result.notes[0]).toMatch(/fabricated-policy\.md/);
  });

  it("passes trivially for an abstention answer with no Sources list and no retrieved sources", () => {
    const result = gradeCitationCorrectness("I couldn't find this in the knowledge base.", []);

    expect(result).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });
});

describe("gradeKbRun", () => {
  const baseGold: GoldQA = {
    id: "q1",
    lang: "en",
    query: "How long must records be retained?",
    relevantChunkIds: ["c1"],
    axis: "happy",
    referenceAnswer: "Seven years.",
  };

  function baseTraj(overrides: Partial<KbRunTrajectory> = {}): KbRunTrajectory {
    return {
      model: "test-model",
      query: baseGold.query,
      answer: `Records must be retained for seven years [1].

**Sources:**

- [1] /data/handbook/policy.md — p. 12`,
      retrieved: [src(1, "/data/handbook/policy.md")],
      citedPassageTexts: ["Records must be retained for seven years per policy."],
      latencyMs: 120,
      tokens: { prompt: 30, completion: 12 },
      ...overrides,
    };
  }

  it("a well-formed, grounded, on-topic run passes with no tags", async () => {
    const traj = baseTraj();

    const result = await gradeKbRun(traj, baseGold, {
      nli: highScoreNli(),
      relevance: fixedRelevanceJudge(0.9),
    });

    expect(result).toEqual({
      model: "test-model",
      passed: true,
      tags: [],
      notes: [],
      latencyMs: 120,
      tokens: { prompt: 30, completion: 12 },
    });
  });

  it("carries model/latencyMs/tokens through from the trajectory even on failure", async () => {
    const traj = baseTraj({
      model: "other-model",
      latencyMs: 999,
      tokens: { prompt: 5, completion: 2 },
    });

    const result = await gradeKbRun(traj, baseGold, {
      nli: highScoreNli(),
      relevance: fixedRelevanceJudge(0.1),
    });

    expect(result.model).toBe("other-model");
    expect(result.latencyMs).toBe(999);
    expect(result.tokens).toEqual({ prompt: 5, completion: 2 });
    expect(result.passed).toBe(false);
  });

  it("a run with a fabricated citation AND an ungrounded sentence carries both tags", async () => {
    const traj = baseTraj({
      answer: `Records must be retained for seven years [1]. The sky is purple [1].

**Sources:**

- [1] /data/handbook/fabricated.md — p. 12`,
      // The real retrieved set never contained the fabricated path.
      retrieved: [src(1, "/data/handbook/real-policy.md")],
    });

    const nli = stubNliClient((_premise, hypothesis) => ({
      label: "entailment",
      score: hypothesis.includes("purple") ? 0.1 : 0.95,
    }));

    const result = await gradeKbRun(traj, baseGold, {
      nli,
      relevance: fixedRelevanceJudge(0.9),
    });

    expect(result.passed).toBe(false);
    expect(result.tags).toContain("path-not-cited");
    expect(result.tags).toContain("ungrounded-claim");
    // composeKbGraderResults dedupes tags via a Set: path-not-cited is flagged
    // by both gradeAttribution's gradePathCitation and gradeCitationCorrectness
    // (same retrieved set, same fabricated path), so it must appear exactly once.
    expect(result.tags.filter((t) => t === "path-not-cited")).toHaveLength(1);
  });

  it("a correct abstention run passes with zero tags (no citations to penalize)", async () => {
    const gold: GoldQA = { ...baseGold, expectAbstention: true };
    const traj = baseTraj({
      answer: "I couldn't find this in the knowledge base.",
      retrieved: [],
      citedPassageTexts: [],
    });

    let relevanceJudgeCalled = false;
    const relevance: RelevanceJudge = {
      score: async () => {
        relevanceJudgeCalled = true;
        return 0;
      },
    };

    const result = await gradeKbRun(traj, gold, { nli: highScoreNli(), relevance });

    expect(result).toEqual({
      model: "test-model",
      passed: true,
      tags: [],
      notes: [],
      latencyMs: 120,
      tokens: { prompt: 30, completion: 12 },
    });
    expect(relevanceJudgeCalled).toBe(false);
  });

  it("a missed-abstention run (gold expects abstention, model answered anyway) is flagged", async () => {
    const gold: GoldQA = { ...baseGold, expectAbstention: true };
    const traj = baseTraj();

    const result = await gradeKbRun(traj, gold, {
      nli: highScoreNli(),
      relevance: fixedRelevanceJudge(0.9),
    });

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["missed-abstention"]);
  });
});
