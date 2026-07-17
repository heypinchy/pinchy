/**
 * Content fingerprint of the PUBLISHED Eval-v1 scorecards (pinchy#669, #802).
 *
 * WHY THIS EXISTS. The dataset's versioning rule (`eval/data/CHANGELOG.md`)
 * says a re-grade that moves a published number must ship as a recorded
 * version bump. Pinning the version constant to the changelog's newest entry
 * does not enforce that: both files are edited together anyway, so a commit
 * touching only `eval/data/*.jsonl` satisfies it while changing every number
 * on the /reliability hub. This digest is the part that actually notices —
 * `eval/__tests__/dataset-version.test.ts` compares it against the committed
 * `DATASET_FINGERPRINT` and goes red until someone bumps the version and
 * writes down what moved.
 *
 * It hashes the numbers as PUBLISHED (`buildPublishedScenarios()`), not the
 * raw files, which is the semantics the versioning rule already uses: three
 * scenarios are re-graded from their trajectories at export time, so a grader
 * fix moves published numbers without any data file changing, and a re-ordered
 * data file that moves no number is not a release. Both cases land correctly
 * here.
 */
import { createHash } from "node:crypto";

/**
 * Everything the export publishes except the release metadata itself — today
 * `{ scenarios, comparisons }`, structurally satisfied by `buildExport()`'s
 * output minus `datasetVersion`/`generatedFrom`.
 *
 * Deliberately an open object rather than the precise export type: the digest
 * must cover whatever the export grows next (pass^k comparisons were added by
 * #796 after this guard landed, and are published numbers with statistics of
 * their own). Typing it narrowly would let the next field slip through
 * unhashed — the exact failure this guard exists to prevent.
 */
export type PublishedPayload = Record<string, unknown>;

/**
 * JSON with every object's keys sorted, so the digest tracks values only.
 * `tagHistogram`'s key order follows the order tags appear across a cell's
 * runs — re-ordering a data file's lines permutes it without moving a number,
 * and that must not read as a release.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * SHA-256 over the published payload. Hashes every field actually present, not
 * a fixed list: a new output field is an additive dataset change (MINOR) and
 * must move the digest too.
 */
export function fingerprintPublished(published: PublishedPayload): string {
  return createHash("sha256").update(stableStringify(published)).digest("hex");
}
