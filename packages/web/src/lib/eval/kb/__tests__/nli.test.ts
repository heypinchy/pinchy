import { describe, expect, it } from "vitest";

import { entailmentScore } from "../nli";
import { stubNliClient } from "./stub-nli-client";

describe("entailmentScore", () => {
  it("averages k stub scores ([0.8, 0.4] with k=2 -> mean 0.6)", async () => {
    const nli = stubNliClient([0.8, 0.4]);

    const score = await entailmentScore(nli, "The sky is blue.", "The sky has color.", { k: 2 });

    expect(score).toBeCloseTo(0.6);
  });

  it("calls entails exactly k times", async () => {
    const nli = stubNliClient([0.9]);

    await entailmentScore(nli, "premise", "hypothesis", { k: 4 });

    expect(nli.calls).toHaveLength(4);
  });

  it("defaults k to 3 when not specified (§262 hedge against a nondeterministic judge)", async () => {
    const nli = stubNliClient([1, 1, 1]);

    await entailmentScore(nli, "premise", "hypothesis");

    expect(nli.calls).toHaveLength(3);
  });

  it("applies the normalize hook to both premise and hypothesis before calling entails (§6 monolingual normalization)", async () => {
    const nli = stubNliClient(() => ({ label: "entailment" as const, score: 1 }));
    const normalize = (text: string) => `EN:${text}`;

    await entailmentScore(nli, "Der Himmel ist blau.", "Der Himmel hat Farbe.", {
      k: 1,
      normalize,
    });

    expect(nli.calls[0]).toEqual({
      premise: "EN:Der Himmel ist blau.",
      hypothesis: "EN:Der Himmel hat Farbe.",
    });
  });

  it("defaults normalize to identity when no hook is supplied", async () => {
    const nli = stubNliClient(() => ({ label: "entailment" as const, score: 1 }));

    await entailmentScore(nli, "premise text", "hypothesis text", { k: 1 });

    expect(nli.calls[0]).toEqual({ premise: "premise text", hypothesis: "hypothesis text" });
  });

  it("supports an async normalize hook (the real sweep wires a translator here later)", async () => {
    const nli = stubNliClient(() => ({ label: "entailment" as const, score: 1 }));
    const normalize = async (text: string) => `EN:${text}`;

    await entailmentScore(nli, "premise", "hypothesis", { k: 1, normalize });

    expect(nli.calls[0]).toEqual({ premise: "EN:premise", hypothesis: "EN:hypothesis" });
  });
});
