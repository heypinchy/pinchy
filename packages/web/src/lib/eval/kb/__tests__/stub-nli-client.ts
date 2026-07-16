// packages/web/src/lib/eval/kb/__tests__/stub-nli-client.ts
//
// Deterministic NLI test double shared by nli.test.ts and
// groundedness-grader.test.ts. Not itself a *.test.ts / *.spec.ts, so it is
// not picked up by vitest's include glob and is not executed as a suite —
// it is only imported from the two test files above. Mirrors the existing
// convention of non-test helper files living inside __tests__ directories
// (e.g. src/__tests__/lib/plugin-tool-extraction.ts).
//
// A real NLI sidecar (Task 3.4) is an async network call; this stub keeps
// every KB Layer-3 grader test synchronous-in-spirit (`Promise.resolve`) and
// exactly deterministic, so mean-of-k assertions have exact expected values
// instead of a tolerance band.

import type { NliClient, NliLabel, NliVerdict } from "../nli";

export interface StubNliCall {
  premise: string;
  hypothesis: string;
}

export interface StubNliClient extends NliClient {
  /** Every (premise, hypothesis) pair `entails` was invoked with, call order. */
  calls: StubNliCall[];
}

function verdictForScore(score: number): NliVerdict {
  const label: NliLabel = score >= 0.5 ? "entailment" : "neutral";
  return { label, score };
}

/**
 * Two input shapes, chosen per test's need:
 *
 * - `number[]`: scores are consumed IN CALL ORDER across the client's whole
 *   lifetime (cycling via modulo if exhausted). Use this to control exactly
 *   what each of the k repeated calls for ONE (premise, hypothesis) pair
 *   returns — e.g. `[0.9, 0.9, 0.2]` to prove k-averaging smooths a single
 *   low outlier (mean 0.667) instead of letting it sink the sentence.
 * - a function of `(premise, hypothesis)`: returns a fixed verdict keyed off
 *   the text, regardless of call count. Use this when a single grader call
 *   grades MULTIPLE sentences that must score differently (e.g. one grounded
 *   sentence, one not) — every one of a sentence's k repeat calls returns the
 *   same verdict, so the mean equals that verdict's score.
 */
export function stubNliClient(
  source: number[] | ((premise: string, hypothesis: string) => NliVerdict)
): StubNliClient {
  let callIndex = 0;
  const calls: StubNliCall[] = [];
  return {
    calls,
    async entails(premise, hypothesis) {
      calls.push({ premise, hypothesis });
      if (typeof source === "function") {
        return source(premise, hypothesis);
      }
      const score = source[callIndex % source.length];
      callIndex += 1;
      return verdictForScore(score);
    },
  };
}
