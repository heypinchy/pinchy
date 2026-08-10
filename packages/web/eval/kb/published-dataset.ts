/**
 * Reader for the EVIDENCE half of the published KB dataset — the
 * `*.trajectories.jsonl` sidecars `export-kb-scorecard.ts` deliberately skips.
 *
 * It lives in its own module rather than beside `readAllRows` because the two
 * answer opposite questions. The exporter reads verdicts and must never see a
 * trajectory (counting one doubles `totalRuns`); everything that re-derives a
 * verdict — the reproducibility guard and the offline re-grade — reads
 * trajectories and never the verdict rows. One module each keeps that
 * separation legible instead of turning the exporter into a file that both
 * skips and reads the same sidecar.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { isCanaryLine } from "../canary";
import { parseJsonlLine } from "../jsonl-line";
import type { KbFailureTag } from "../../src/lib/eval/kb/types";
import type { RetrievedSource } from "../../src/lib/eval/kb/attribution-graders";

const DATA_DIR = path.join(__dirname, "data");

/**
 * One published trajectory line. Structurally `PersistedKbTrajectory` from
 * `run-kb-eval.ts`, redeclared here rather than imported: that module re-exports
 * the sweep's HTTP helpers from `../run-eval`, and neither the guard nor the
 * re-grade should drag a browser-driving harness into their import graph to
 * learn the shape of a JSON line.
 */
export interface PublishedTrajectory {
  model: string;
  query: string;
  answer: string;
  retrieved: RetrievedSource[];
  citedPassageTexts: string[];
  latencyMs: number;
  goldId: string;
  passed: boolean;
  tags: KbFailureTag[];
}

/**
 * Every field the type above promises, not a representative sample of them.
 *
 * A predicate that asserts `PublishedTrajectory` while checking five of its
 * nine fields hands its callers a lie in the shape of a type: `query` and
 * `latencyMs` go straight into the judge's input in `regrade-kb-runs.ts`, so a
 * line missing `query` re-grades an answer against `undefined` and publishes
 * the verdict, and `passed` is what the reproducibility guard compares on.
 */
function isCompleteTrajectory(value: unknown): value is PublishedTrajectory {
  const t = value as Partial<PublishedTrajectory> | null;
  return (
    typeof t?.model === "string" &&
    typeof t.goldId === "string" &&
    typeof t.query === "string" &&
    typeof t.answer === "string" &&
    typeof t.latencyMs === "number" &&
    typeof t.passed === "boolean" &&
    Array.isArray(t.retrieved) &&
    Array.isArray(t.citedPassageTexts) &&
    Array.isArray(t.tags)
  );
}

/**
 * Reads every `*.trajectories.jsonl` under `dataDir`, skipping the canary
 * header.
 *
 * Throws — naming file and line — on a line it cannot read as a trajectory,
 * for the reason `readAllRows` throws on an unknown axis: a reader that
 * silently drops what it does not understand reports a short list, and a short
 * list of evidence reads exactly like evidence that was checked and found
 * clean.
 */
export async function readAllTrajectories(
  dataDir: string = DATA_DIR
): Promise<PublishedTrajectory[]> {
  let files: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied dir, test-only parameter; defaults to the module's own data/
    files = (await readdir(dataDir)).filter((f) => f.endsWith(".trajectories.jsonl"));
  } catch {
    return [];
  }

  const trajectories: PublishedTrajectory[] = [];
  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- name comes from readdir of the directory above
    const text = await readFile(path.join(dataDir, file), "utf8");
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo++;
      if (line.trim().length === 0 || isCanaryLine(line)) continue;
      const parsed: unknown = parseJsonlLine(file, lineNo, line);
      if (!isCompleteTrajectory(parsed)) {
        throw new Error(
          `${file} line ${lineNo}: not a complete trajectory (needs model, goldId, query, answer, ` +
            `latencyMs, passed, retrieved, citedPassageTexts, tags).`
        );
      }
      trajectories.push(parsed);
    }
  }
  return trajectories;
}

/** The key both published files are joined on: one run is one (model, gold question) pair. */
export function runKey(model: string, goldId: string): string {
  return `${model}::${goldId}`;
}
