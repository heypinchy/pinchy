import { describe, expect, it } from "vitest";

import {
  gradeGroundedness,
  gradeGroundednessForGold,
  isAbstention,
  splitSentences,
} from "../groundedness-grader";
import { stubNliClient } from "./stub-nli-client";
import type { AbstentionJudge } from "../groundedness-grader";
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

/** An AbstentionJudge stub returning a fixed score, recording what it was shown. */
function stubAbstentionJudge(score: number) {
  const calls: { query: string; answer: string }[] = [];
  const judge: AbstentionJudge & { calls: typeof calls } = {
    calls,
    async declines(query, answer) {
      calls.push({ query, answer });
      return score;
    },
  };
  return judge;
}

describe("isAbstention", () => {
  /** Judge that reads every answer as a refusal — isolates STRUCTURE from judge quality. */
  const judgeSaysYes = () => stubAbstentionJudge(0.95);
  /** Judge that reads every answer as an answer — proves the threshold is real, not a rubber stamp. */
  const judgeSaysNo = () => stubAbstentionJudge(0.05);

  const Q = "What is Northwind's parental leave policy?";

  it.each([
    "I couldn't find this in the knowledge base.",
    "I could not find that information anywhere.",
    "The corpus doesn't contain an answer to this.",
    "The corpus does not contain any mention of this.",
    "This is not in the knowledge base.",
  ])("detects abstention: %s", async (answer) => {
    expect(await isAbstention(Q, answer, judgeSaysYes())).toBe(true);
  });

  it("does not flag a normal answering sentence as abstention", async () => {
    expect(
      await isAbstention(Q, "The retention policy requires seven years [1].", judgeSaysNo())
    ).toBe(false);
  });

  it("does NOT flag a grounded, cited answer that merely uses an abstention phrase mid-sentence", async () => {
    // Substring-match footgun: this answer literally contains "does not
    // contain" yet is a real, cited answer — it ANSWERS the question and
    // happens to negate along the way. Misreading it as a refusal would
    // spuriously trip false-abstention AND skip the relevance judge,
    // corrupting the (tracked) Layer-3 scorecard.
    //
    // What separates it from a real abstention is not whether it carries a
    // citation (the veto this detector used to apply, see below) but whether
    // it states the requested fact. That is a question about meaning, so it is
    // the judge's; this pins the wiring, and `buildAbstentionPrompt` is where
    // the judge is told the distinction.
    expect(
      await isAbstention(
        "How long are records kept?",
        "The handbook does not contain a dedicated clause, but section 4 states records are kept for ten years [1].",
        judgeSaysNo()
      )
    ).toBe(false);
  });

  it("still detects a genuine abstention (no citations at all)", async () => {
    expect(
      await isAbstention(
        Q,
        "The knowledge base does not contain an answer to this.",
        judgeSaysYes()
      )
    ).toBe(true);
  });

  it("shows the judge the question, and the answer BODY with the Sources list stripped", async () => {
    const judge = judgeSaysYes();

    await isAbstention(
      Q,
      "I could not find the policy text [1].\n\n**Sources:**\n\n- [1] absent-topic-pointer.md",
      judge
    );

    expect(judge.calls).toHaveLength(1);
    // The question is load-bearing, not decoration: asking about the answer
    // alone did not separate abstentions from answers on ANY judge model
    // tried (see `buildAbstentionPrompt`).
    expect(judge.calls[0].query).toBe(Q);
    // Not the Sources list: a citation line quoting a document title is not
    // the answer's claim, and feeding it to the judge grades the wrong text.
    expect(judge.calls[0].answer).toBe("I could not find the policy text [1].");
  });

  it("uses the abstention tau, not the groundedness one", async () => {
    // 0.55 sits above DEFAULT_ABSTENTION_TAU (0.5) and below DEFAULT_TAU
    // (0.6). Reading the wrong default here would flip this verdict.
    expect(await isAbstention(Q, "Some answer.", stubAbstentionJudge(0.55))).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Regressions from the 2026-08-05 sweep. Both answers below are verbatim
  // model output from that run; both were charged `missed-abstention` (and
  // `off-topic-grounded` downstream) by the previous detector, which
  //
  //   1. vetoed any answer carrying an inline [N] marker, on the stated
  //      premise that "an abstention cites NOTHING" — but all four models
  //      cited the index document as EVIDENCE that only a section title
  //      exists, which is the better behaviour, and
  //   2. matched a literal, English-only phrase list, which no German
  //      abstention can satisfy — making the DE abstention item structurally
  //      unpassable in a harness that has a cross-lingual axis and a skill
  //      file instructing the agent to answer in the user's language.
  //
  // A stub judge cannot prove a real judge reads these correctly; that was
  // measured separately against the live judge (all 8 abstentions 0.95–1.00,
  // all 40 answering runs 0.00 — see `buildAbstentionPrompt`). What these two
  // pin is that the detector no longer rules them out BEFORE the judge sees
  // them.
  // ---------------------------------------------------------------------

  it("recognises an abstention that cites its evidence (sweep: qwen3.5, gqa-abstention-1)", async () => {
    const answer = [
      "I couldn't find the actual text of Northwind's parental leave policy in the indexed documents.",
      "",
      "The search results show that parental leave is listed as one of the HR policy sections maintained by the People Operations team [1], but the detailed policy text itself doesn't appear in the search results.",
    ].join("\n");

    expect(await isAbstention(Q, answer, judgeSaysYes())).toBe(true);
  });

  it("recognises an abstention written in German (sweep: glm-5.2, gqa-abstention-2)", async () => {
    const answer =
      "Ich konnte in den indizierten Dokumenten leider **keine eigentliche Richtlinie zur Elternzeit** (parental leave) finden.";

    expect(
      await isAbstention("Wie lautet Northwinds Richtlinie zur Elternzeit?", answer, judgeSaysYes())
    ).toBe(true);
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
      nli,
      true
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
      nli,
      false
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
      nli,
      true
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
      nli,
      false
    );

    expect(result).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("answerable gold (expectAbstention omitted) + ungrounded answer -> ungrounded-claim", async () => {
    const nli = stubNliClient(() => ({ label: "neutral" as const, score: 0.1 }));

    const result = await gradeGroundednessForGold(
      "The sky is purple [1].",
      ["Records must be retained for seven years per policy."],
      baseGold,
      nli,
      false
    );

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["ungrounded-claim"]);
  });
});
