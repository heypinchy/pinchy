/**
 * The published KB dataset must reproduce its own verdicts.
 *
 * Every number in `data/` was produced by graders that live in this repo and
 * keep changing — four of the five sweeps before publication measured a grader
 * defect rather than a model, and the fifth needed #1173's parser fix before
 * its citation numbers meant anything. A dataset published beside the code that
 * graded it, with nothing tying the two together, drifts the moment a grader is
 * corrected: the files still parse, the scorecard still exports, and the numbers
 * quietly describe a grader that no longer exists.
 *
 * So this guard re-derives each published verdict from the published ANSWER and
 * fails when the two disagree. Same contract as `manifest-tools-drift.test.ts`
 * next door: the one list with a guard is the one list that stays correct.
 *
 * It re-derives with the corpus's `nearDuplicatePathGroups()`, the same input
 * the sweep and the re-grade pass. That is not a detail: for the dataset's
 * whole life this file called `gradeAttribution` without them, which happens to
 * be exactly how `dedup-inflation` stayed at a 0 that no check could question
 * (#1181). A re-derivation that grades differently from the pipeline proves the
 * pipeline nothing.
 *
 * **It covers the deterministic half only, and that limit is the honest part.**
 * `gradeAttribution` and `gradeCitationCorrectness` are pure functions of the
 * answer text and the retrieved set, so they re-run here in milliseconds with no
 * network. The other four tags — `ungrounded-claim`, `off-topic-grounded`,
 * `missed-abstention`, `false-abstention` — come from an LLM judge over Ollama
 * Cloud, and a stochastic judge cannot be asserted equal to a stored verdict
 * without either an API key in CI or a tolerance band that would let real drift
 * through. Those are re-derived by `regrade-kb-runs.ts`, on demand, by a human.
 * A green run here means the citation axes are reproducible; it says nothing
 * about the groundedness axes.
 */
import { describe, expect, it } from "vitest";

import { readAllRows } from "./export-kb-scorecard";
import { nearDuplicatePathGroups } from "./corpus/manifest";
import { readAllTrajectories, runKey } from "./published-dataset";
import {
  gradeAttribution,
  composeKbGraderResults,
} from "../../src/lib/eval/kb/attribution-graders";
import { gradeCitationCorrectness } from "../../src/lib/eval/kb/answer-graders";
import type { KbFailureTag } from "../../src/lib/eval/kb/types";

/**
 * The tags a pure grader can hand down. Anything a re-derivation produces
 * outside this set fails the last test in this file rather than being compared
 * against a published row that never had a chance to carry it — so adding an
 * attribution tag forces a decision here instead of silently narrowing what
 * this guard checks.
 */
const DETERMINISTIC_TAGS: readonly KbFailureTag[] = [
  "citation-unresolved",
  "source-uncited",
  "sources-format",
  "path-not-cited",
  "dedup-inflation",
];

const DETERMINISTIC = new Set<string>(DETERMINISTIC_TAGS);

/** The published dataset is 48 runs; a reader that finds far fewer is broken, not thorough. */
const MIN_EXPECTED_RUNS = 40;

/** Derived once, not per trajectory: same input for all 48, and it validates the corpus once. */
const NEAR_DUPLICATE_GROUPS = nearDuplicatePathGroups();

function sorted(tags: readonly string[]): string[] {
  return [...tags].sort();
}

describe("the published KB dataset reproduces its own deterministic verdicts", () => {
  it("pairs every published verdict with exactly one trajectory", async () => {
    const rows = await readAllRows();
    const trajectories = await readAllTrajectories();

    expect(rows.length).toBeGreaterThanOrEqual(MIN_EXPECTED_RUNS);
    expect(trajectories.length).toBe(rows.length);

    const rowKeys = sorted(rows.map((r) => runKey(r.model, r.scenario ?? "")));
    const trajKeys = sorted(trajectories.map((t) => runKey(t.model, t.goldId)));
    expect(trajKeys).toEqual(rowKeys);
  });

  it("stores the same verdict in the verdict file and in the evidence file", async () => {
    const rows = await readAllRows();
    const trajectories = await readAllTrajectories();

    // Grouped and compared as MULTISETS per key, not looked up one-to-one. The
    // dataset is one run per (model, gold question) today, so a Map keyed that
    // way reads the same — and would quietly compare a single row against both
    // trajectories the moment a sweep publishes n > 1.
    const verdict = (v: { passed: boolean; tags: readonly string[] }) =>
      `${v.passed ? "pass" : "fail"} [${sorted(v.tags).join(", ")}]`;

    const groupVerdicts = <T extends { passed: boolean; tags: readonly string[] }>(
      items: T[],
      key: (item: T) => string
    ) => {
      const map = new Map<string, string[]>();
      for (const item of items) {
        map.set(key(item), [...(map.get(key(item)) ?? []), verdict(item)]);
      }
      return map;
    };

    const rowVerdicts = groupVerdicts(rows, (r) => runKey(r.model, r.scenario ?? ""));
    const trajVerdicts = groupVerdicts(trajectories, (t) => runKey(t.model, t.goldId));

    for (const [key, published] of rowVerdicts) {
      expect(
        sorted(trajVerdicts.get(key) ?? []),
        `${key}: the evidence file records a different verdict than the verdict file`
      ).toEqual(sorted(published));
    }
  });

  it("re-derives every citation verdict from the published answer", async () => {
    const trajectories = await readAllTrajectories();
    expect(trajectories.length).toBeGreaterThanOrEqual(MIN_EXPECTED_RUNS);

    for (const traj of trajectories) {
      const recomputed = composeKbGraderResults([
        gradeAttribution({
          answer: traj.answer,
          retrieved: traj.retrieved,
          nearDuplicateGroups: NEAR_DUPLICATE_GROUPS,
        }),
        gradeCitationCorrectness(traj.answer, traj.retrieved),
      ]);
      const published = traj.tags.filter((tag) => DETERMINISTIC.has(tag));

      expect(
        sorted(recomputed.tags),
        `${runKey(traj.model, traj.goldId)}: the current graders no longer produce the published ` +
          `citation verdict. Re-grade the dataset (eval/kb/regrade-kb-runs.ts) rather than ` +
          `relaxing this guard.`
      ).toEqual(sorted(published));
    }
  });

  it("produces no citation tag outside the declared deterministic set", async () => {
    for (const traj of await readAllTrajectories()) {
      const recomputed = composeKbGraderResults([
        gradeAttribution({
          answer: traj.answer,
          retrieved: traj.retrieved,
          nearDuplicateGroups: NEAR_DUPLICATE_GROUPS,
        }),
        gradeCitationCorrectness(traj.answer, traj.retrieved),
      ]);
      for (const tag of recomputed.tags) {
        expect(
          DETERMINISTIC.has(tag),
          `A pure grader emitted "${tag}", which DETERMINISTIC_TAGS does not list — add it there ` +
            `so the re-derivation above actually checks it.`
        ).toBe(true);
      }
    }
  });
});
