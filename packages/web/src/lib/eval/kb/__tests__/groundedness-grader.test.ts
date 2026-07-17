import { describe, expect, it } from "vitest";

import {
  gradeGroundedness,
  gradeGroundednessForGold,
  isAbstention,
  splitSentences,
} from "../groundedness-grader";
import { stubNliClient } from "./stub-nli-client";
import type { GoldQA, KbGraderResult } from "../types";

function highScoreClient() {
  return stubNliClient(() => ({ label: "entailment" as const, score: 0.95 }));
}

describe("splitSentences", () => {
  it("splits on '.', '!', '?' followed by whitespace", () => {
    expect(splitSentences("First sentence. Second sentence! Third sentence?")).toEqual([
      "First sentence.",
      "Second sentence!",
      "Third sentence?",
    ]);
  });

  it("does not split on a decimal number like 2.5", () => {
    expect(splitSentences("The score was 2.5 out of 5. That is a strong result.")).toEqual([
      "The score was 2.5 out of 5.",
      "That is a strong result.",
    ]);
  });

  it("does not split inside a [N] citation marker", () => {
    expect(splitSentences("The policy requires review [1]. It is enforced annually [2].")).toEqual([
      "The policy requires review [1].",
      "It is enforced annually [2].",
    ]);
  });

  it("ignores empty/whitespace-only fragments and trims each sentence", () => {
    expect(splitSentences("  One sentence.   ")).toEqual(["One sentence."]);
  });

  it("returns an empty array for an empty answer body", () => {
    expect(splitSentences("")).toEqual([]);
  });
});

describe("isAbstention", () => {
  it.each([
    "I couldn't find this in the knowledge base.",
    "I could not find that information anywhere.",
    "The corpus doesn't contain an answer to this.",
    "The corpus does not contain any mention of this.",
    "This is not in the knowledge base.",
  ])("detects abstention phrase: %s", (answer) => {
    expect(isAbstention(answer)).toBe(true);
  });

  it("does not flag a normal answering sentence as abstention", () => {
    expect(isAbstention("The retention policy requires seven years [1].")).toBe(false);
  });

  it("does NOT flag a grounded, cited answer that merely uses an abstention phrase mid-sentence", () => {
    // Substring-match footgun: this answer literally contains "does not
    // contain" yet is a real, cited answer. An abstention cites nothing, so
    // the presence of an inline [N] citation is the discriminator — misreading
    // this as a refusal would spuriously trip false-abstention AND skip the
    // relevance judge, corrupting the (tracked) Layer-3 scorecard.
    expect(
      isAbstention(
        "The handbook does not contain a dedicated clause, but section 4 states records are kept for ten years [1]."
      )
    ).toBe(false);
  });

  it("still detects a genuine abstention (abstention phrase, no citations)", () => {
    expect(isAbstention("The knowledge base does not contain an answer to this.")).toBe(true);
  });
});

describe("gradeGroundedness", () => {
  it("passes when every sentence is entailed by the cited passages", async () => {
    const nli = highScoreClient();

    const result = await gradeGroundedness(
      "The retention policy requires seven years [1].",
      ["Records must be retained for seven years per policy."],
      nli
    );

    expect(result).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("flags a sentence below tau as an ungrounded-claim, quoting the sentence in the note", async () => {
    const nli = stubNliClient((_premise, hypothesis) => ({
      label: "entailment",
      score: hypothesis.includes("purple") ? 0.1 : 0.9,
    }));

    const result = await gradeGroundedness(
      "The retention policy requires seven years [1]. The sky is purple [1].",
      ["Records must be retained for seven years per policy."],
      nli
    );

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["ungrounded-claim"]);
    expect(result.notes[0]).toMatch(/sky is purple/);
  });

  it("band: mean 0.62 with tau=0.6 passes", async () => {
    const nli = stubNliClient([0.62, 0.62, 0.62]);

    const result = await gradeGroundedness("Grounded claim [1].", ["evidence"], nli, { tau: 0.6 });

    expect(result.passed).toBe(true);
  });

  it("band: mean 0.55 with tau=0.6 fails", async () => {
    const nli = stubNliClient([0.55, 0.55, 0.55]);

    const result = await gradeGroundedness("Ungrounded claim [1].", ["evidence"], nli, {
      tau: 0.6,
    });

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["ungrounded-claim"]);
  });

  it("k-averaging: a single low outlier ([0.9,0.9,0.2] -> mean 0.667) does not sink an otherwise-grounded sentence", async () => {
    const nli = stubNliClient([0.9, 0.9, 0.2]);

    const result = await gradeGroundedness("One grounded claim [1].", ["evidence"], nli, {
      tau: 0.6,
      k: 3,
    });

    expect(result.passed).toBe(true);
  });

  it("strips the Sources list before sentence-splitting (reuses attribution-graders' answer-body extraction)", async () => {
    const nli = stubNliClient((_premise, hypothesis) => ({
      label: "entailment",
      // Would fail the grade if a Sources bullet line were ever treated as a
      // "sentence" to grade -- its literal path text never appears in the
      // cited evidence prose below.
      score: hypothesis.includes("/data/") ? 0 : 0.95,
    }));

    const result = await gradeGroundedness(
      `The retention policy requires seven years [1].

**Sources:**

- [1] /data/handbook-2012/records-policy.md — p. 12`,
      ["Records must be retained for seven years per policy."],
      nli
    );

    expect(result).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });
});

describe("gradeGroundednessForGold", () => {
  const baseGold: GoldQA = {
    id: "q1",
    lang: "en",
    query: "How long must records be retained?",
    relevantChunkIds: ["c1"],
    axis: "happy",
    referenceAnswer: "Seven years.",
  };

  it("expectAbstention=true + abstaining answer -> pass (no groundedness check needed)", async () => {
    const nli = highScoreClient();
    const gold: GoldQA = { ...baseGold, expectAbstention: true };

    const result = await gradeGroundednessForGold(
      "I couldn't find this in the knowledge base.",
      [],
      gold,
      nli
    );

    expect(result).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
    expect(nli.calls).toHaveLength(0);
  });

  it("expectAbstention=true + answering anyway -> missed-abstention", async () => {
    const nli = highScoreClient();
    const gold: GoldQA = { ...baseGold, expectAbstention: true };

    const result = await gradeGroundednessForGold(
      "Records must be retained for seven years [1].",
      ["Records must be retained for seven years per policy."],
      gold,
      nli
    );

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["missed-abstention"]);
  });

  it("answerable gold + abstaining answer -> false-abstention", async () => {
    const nli = highScoreClient();
    const gold: GoldQA = { ...baseGold, expectAbstention: false };

    const result = await gradeGroundednessForGold(
      "I couldn't find this in the knowledge base.",
      ["Records must be retained for seven years per policy."],
      gold,
      nli
    );

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["false-abstention"]);
  });

  it("answerable gold + grounded answer -> pass (falls through to the normal groundedness check)", async () => {
    const nli = highScoreClient();
    const gold: GoldQA = { ...baseGold, expectAbstention: false };

    const result = await gradeGroundednessForGold(
      "Records must be retained for seven years [1].",
      ["Records must be retained for seven years per policy."],
      gold,
      nli
    );

    expect(result).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("answerable gold (expectAbstention omitted) + ungrounded answer -> ungrounded-claim", async () => {
    const nli = stubNliClient(() => ({ label: "neutral" as const, score: 0.1 }));

    const result = await gradeGroundednessForGold(
      "The sky is purple [1].",
      ["Records must be retained for seven years per policy."],
      baseGold,
      nli
    );

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["ungrounded-claim"]);
  });
});
