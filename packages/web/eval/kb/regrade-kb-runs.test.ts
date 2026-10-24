/**
 * The pure half of the offline re-grade: rebuilding a run's grading input from
 * a published trajectory. The judge loop is not covered here — it is a network
 * call by construction — but everything it is handed is.
 */
import { describe, expect, it } from "vitest";

import { chunkTextsByPath, rebuildTrajectory, tagHistogram } from "./regrade-kb-runs";
import { KB_EVAL_CORPUS } from "./corpus/manifest";
import type { PublishedTrajectory } from "./published-dataset";

const CORPUS_PATH = "/data/it-equipment-policy.md";

function publishedRun(overrides: Partial<PublishedTrajectory> = {}): PublishedTrajectory {
  return {
    model: "ollama-cloud/test",
    query: "How often does Northwind replace employee laptops?",
    answer: "Every three years [1].\n\n### Sources\n\n- [1] `it-equipment-policy.md`",
    retrieved: [{ n: 1, sourcePath: CORPUS_PATH, page: null }],
    citedPassageTexts: [],
    latencyMs: 1234,
    goldId: "gqa-happy-1",
    passed: false,
    tags: ["ungrounded-claim"],
    ...overrides,
  };
}

describe("chunkTextsByPath", () => {
  it("stands in for the kb_chunks table the sweep queries", () => {
    const texts = chunkTextsByPath();
    expect(texts.size).toBe(KB_EVAL_CORPUS.length);

    // Every premise the grader can be handed comes from here, so an empty
    // entry would silently score every sentence against nothing — the exact
    // failure mode the second unpublished sweep shipped.
    for (const doc of KB_EVAL_CORPUS) {
      expect(texts.get(doc.sourcePath), doc.sourcePath).toEqual(doc.chunks.map((c) => c.text));
      expect(texts.get(doc.sourcePath)!.length).toBeGreaterThan(0);
    }
  });
});

describe("rebuildTrajectory", () => {
  it("re-derives the premise instead of reusing the stored one", () => {
    // The published run stores NO premise — the state #1173's parser fix
    // changes. Reusing `citedPassageTexts` would re-run the judge against the
    // empty string and reproduce the verdict the re-grade exists to correct.
    const rebuilt = rebuildTrajectory(publishedRun({ citedPassageTexts: [] }));

    expect(rebuilt.citedPassageTexts.length).toBeGreaterThan(0);
    expect(rebuilt.citedPassageTexts).toEqual(chunkTextsByPath().get(CORPUS_PATH));
  });

  it("carries the record of what happened through unchanged", () => {
    const published = publishedRun();
    const rebuilt = rebuildTrajectory(published);

    expect(rebuilt.model).toBe(published.model);
    expect(rebuilt.query).toBe(published.query);
    expect(rebuilt.answer).toBe(published.answer);
    expect(rebuilt.retrieved).toEqual(published.retrieved);
    expect(rebuilt.latencyMs).toBe(published.latencyMs);
  });

  it("leaves the premise empty when the answer cites nothing", () => {
    // `premiseSourcePaths` refuses to recover premises for an answer with no
    // inline citation at all — otherwise an answer that asserts and appends an
    // uncited Sources list would pass groundedness for free.
    const rebuilt = rebuildTrajectory(
      publishedRun({ answer: "Every three years.", citedPassageTexts: ["stale premise"] })
    );

    expect(rebuilt.citedPassageTexts).toEqual([]);
  });
});

describe("tagHistogram", () => {
  it("counts each tag occurrence across runs", () => {
    const counts = tagHistogram([
      { tags: ["sources-format", "ungrounded-claim"] },
      { tags: ["sources-format"] },
      { tags: [] },
    ]);

    expect(counts.get("sources-format")).toBe(2);
    expect(counts.get("ungrounded-claim")).toBe(1);
    expect(counts.get("citation-unresolved")).toBeUndefined();
  });
});
