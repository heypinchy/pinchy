// packages/web/src/lib/eval/kb/__tests__/llm-nli.test.ts
//
// Unit tests for the keyless, pure parts of the LLM-as-NLI-judge module
// (Task 3.4): parseNliResponse / parseRelevanceResponse (robust extraction +
// fallback), and LlmNliClient/LlmRelevanceJudge wired to a scripted stub
// `LlmChatFn` — no network, no key. `createOllamaCloudChatFn` is
// deliberately NOT covered here (see its doc comment in ../llm-nli.ts): it
// needs a real key + live network to exercise meaningfully.
import { describe, expect, it } from "vitest";

import {
  LlmNliClient,
  LlmRelevanceJudge,
  NLI_PARSE_FALLBACK,
  RELEVANCE_PARSE_FALLBACK,
  parseNliResponse,
  parseRelevanceResponse,
} from "../llm-nli";
import { entailmentScore } from "../nli";
import type { LlmChatFn } from "../llm-nli";

describe("parseNliResponse", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseNliResponse('{"label": "entailment", "score": 0.92}')).toEqual({
      label: "entailment",
      score: 0.92,
    });
  });

  it("parses a verdict wrapped in a ```json fence", () => {
    const raw = '```json\n{"label": "contradiction", "score": 0.1}\n```';
    expect(parseNliResponse(raw)).toEqual({ label: "contradiction", score: 0.1 });
  });

  it("parses a verdict wrapped in a bare ``` fence (no json tag)", () => {
    const raw = '```\n{"label": "neutral", "score": 0.4}\n```';
    expect(parseNliResponse(raw)).toEqual({ label: "neutral", score: 0.4 });
  });

  it("extracts the JSON object from extra surrounding prose", () => {
    const raw = 'Here is my verdict:\n{"label": "entailment", "score": 0.75}\nHope that helps!';
    expect(parseNliResponse(raw)).toEqual({ label: "entailment", score: 0.75 });
  });

  it("falls back to neutral/0 (not a throw) when no JSON object is present", () => {
    expect(parseNliResponse("I think this is entailed.")).toEqual(NLI_PARSE_FALLBACK);
  });

  it("falls back to neutral/0 (not a throw) on malformed JSON", () => {
    expect(parseNliResponse('{"label": "entailment", "score": }')).toEqual(NLI_PARSE_FALLBACK);
  });

  it("falls back to neutral/0 when label is missing/invalid", () => {
    expect(parseNliResponse('{"label": "maybe", "score": 0.9}')).toEqual(NLI_PARSE_FALLBACK);
    expect(parseNliResponse('{"score": 0.9}')).toEqual(NLI_PARSE_FALLBACK);
  });

  it("falls back to neutral/0 when score is missing/non-numeric", () => {
    expect(parseNliResponse('{"label": "entailment", "score": "high"}')).toEqual(
      NLI_PARSE_FALLBACK
    );
    expect(parseNliResponse('{"label": "entailment"}')).toEqual(NLI_PARSE_FALLBACK);
  });

  it("clamps an out-of-range score into [0, 1]", () => {
    expect(parseNliResponse('{"label": "entailment", "score": 1.4}')).toEqual({
      label: "entailment",
      score: 1,
    });
    expect(parseNliResponse('{"label": "contradiction", "score": -0.3}')).toEqual({
      label: "contradiction",
      score: 0,
    });
  });
});

describe("parseRelevanceResponse", () => {
  it("parses a clean JSON score", () => {
    expect(parseRelevanceResponse('{"score": 0.85}')).toBe(0.85);
  });

  it("parses a score wrapped in a ```json fence with surrounding prose", () => {
    const raw = 'Sure, here you go:\n```json\n{"score": 0.3}\n```\nLet me know if you need more.';
    expect(parseRelevanceResponse(raw)).toBe(0.3);
  });

  it("falls back to the defined fallback (not a throw) on a malformed reply", () => {
    expect(parseRelevanceResponse("not json at all")).toBe(RELEVANCE_PARSE_FALLBACK);
    expect(parseRelevanceResponse('{"score": "high"}')).toBe(RELEVANCE_PARSE_FALLBACK);
    expect(parseRelevanceResponse('{"score": }')).toBe(RELEVANCE_PARSE_FALLBACK);
  });

  it("clamps an out-of-range score into [0, 1]", () => {
    expect(parseRelevanceResponse('{"score": 2}')).toBe(1);
    expect(parseRelevanceResponse('{"score": -1}')).toBe(0);
  });
});

describe("LlmNliClient", () => {
  it("sends a premise/hypothesis prompt to the injected chat fn and parses its reply", async () => {
    const calls: string[] = [];
    const chat: LlmChatFn = async (prompt) => {
      calls.push(prompt);
      return '{"label": "entailment", "score": 0.88}';
    };
    const client = new LlmNliClient(chat);

    const verdict = await client.entails("The cat sat on the mat.", "There is a cat.");

    expect(verdict).toEqual({ label: "entailment", score: 0.88 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("The cat sat on the mat.");
    expect(calls[0]).toContain("There is a cat.");
  });

  it("wires into entailmentScore's k-averaging (repeated calls, mean of k)", async () => {
    // A scripted chat fn returning a different score per call proves the
    // repeated-call contract (entailmentScore calls entails() k times, here
    // via LlmNliClient) rather than just returning one memoized value.
    const scores = [0.9, 0.6, 0.3];
    let callIndex = 0;
    const chat: LlmChatFn = async () => {
      const score = scores[callIndex % scores.length];
      callIndex += 1;
      return JSON.stringify({ label: "entailment", score });
    };
    const client = new LlmNliClient(chat);

    const mean = await entailmentScore(client, "premise text", "hypothesis text", { k: 3 });

    expect(mean).toBeCloseTo(0.6, 5);
    expect(callIndex).toBe(3);
  });

  it("a single malformed judge reply degrades to a low (not crashing) score within k-averaging", async () => {
    const replies = ['{"label": "entailment", "score": 0.9}', "garbage, not json"];
    let callIndex = 0;
    const chat: LlmChatFn = async () => {
      const reply = replies[callIndex % replies.length];
      callIndex += 1;
      return reply;
    };
    const client = new LlmNliClient(chat);

    const mean = await entailmentScore(client, "premise", "hypothesis", { k: 2 });

    // (0.9 + 0) / 2 — the malformed reply falls back to score 0, not a throw.
    expect(mean).toBeCloseTo(0.45, 5);
  });
});

describe("LlmRelevanceJudge", () => {
  it("sends a query/answer prompt to the injected chat fn and parses its reply", async () => {
    const calls: string[] = [];
    const chat: LlmChatFn = async (prompt) => {
      calls.push(prompt);
      return '{"score": 0.7}';
    };
    const judge = new LlmRelevanceJudge(chat);

    const score = await judge.score("How often are laptops replaced?", "Every 3 years.");

    expect(score).toBe(0.7);
    expect(calls[0]).toContain("How often are laptops replaced?");
    expect(calls[0]).toContain("Every 3 years.");
  });
});
