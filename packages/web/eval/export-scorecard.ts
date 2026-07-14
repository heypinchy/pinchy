/**
 * Exports the published Eval-v1 dataset (packages/web/eval/data) as one
 * consolidated JSON for downstream surfaces (the heypinchy.com /reliability
 * hub renders from a copy of this output). Committed so the website's numbers
 * are reproducible from the open dataset with one command:
 *
 *   pnpm -C packages/web tsx eval/export-scorecard.ts > /tmp/reliability.json
 *
 * Grading source per scenario:
 * - `hetzner-invoice-duplicate-models` is RE-GRADED from its (complete)
 *   trajectory log with the CURRENT graders — some early stored RunResults
 *   predate the verify-required duplicate grader fix.
 * - All other scenarios use the stored RunResults: they were collected with
 *   the current grader generation, and their earliest runs (happy's original
 *   cohort, most of rejected) have no trajectories to re-grade from.
 * Rows without a trajectory (run-timeouts are logged directly, bypassing the
 * trajectory dump) keep their stored failed grade in either mode.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gradeRunForScenario } from "../src/lib/eval/graders";
import type { RunResult, RunTrajectory } from "../src/lib/eval/types";
import { hetznerInvoiceDuplicateScenario } from "./scenarios/hetzner-invoice-duplicate";

const DATA_DIR = path.join(__dirname, "data");

/** Scenario labels in presentation order, with the axis each one measures. */
const SCENARIOS = [
  { label: "hetzner-invoice-models", slug: "happy-path", axis: "task capability" },
  {
    label: "hetzner-invoice-distractor-models",
    slug: "distractor-inbox",
    axis: "document selection",
  },
  {
    label: "hetzner-invoice-conflict-models",
    slug: "conflicting-data",
    axis: "extraction discipline",
  },
  { label: "hetzner-invoice-lineitems-models", slug: "line-items", axis: "structured data entry" },
  {
    label: "hetzner-invoice-duplicate-models",
    slug: "duplicate-guard",
    axis: "verify before write",
  },
  {
    label: "hetzner-invoice-rejected-models",
    slug: "hard-rejection",
    axis: "honesty under loud failure",
  },
  {
    label: "hetzner-invoice-silent-failure-models",
    slug: "silent-failure",
    axis: "honesty under silent failure",
  },
] as const;

/** Scenarios whose published grade comes from re-grading trajectories. */
const REGRADE_FROM_TRAJECTORIES = new Set(["hetzner-invoice-duplicate-models"]);

interface Cell {
  model: string;
  n: number;
  passes: number;
  passRate: number;
  passAllK: boolean;
  tagHistogram: Record<string, number>;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await readFile(path.join(DATA_DIR, file), "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

function aggregate(runs: RunResult[]): Cell[] {
  const byModel = new Map<string, RunResult[]>();
  for (const r of runs) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  return [...byModel.entries()]
    .map(([model, list]) => {
      const passes = list.filter((r) => r.passed).length;
      const tagHistogram: Record<string, number> = {};
      for (const r of list) {
        for (const t of r.tags) tagHistogram[t] = (tagHistogram[t] ?? 0) + 1;
      }
      return {
        model: model.replace(/^ollama-cloud\//, ""),
        n: list.length,
        passes,
        passRate: Number((passes / list.length).toFixed(3)),
        passAllK: passes === list.length && list.length > 0,
        tagHistogram,
      };
    })
    .sort((a, b) => b.passRate - a.passRate || a.model.localeCompare(b.model));
}

async function main(): Promise<void> {
  const scenarios = [];
  for (const s of SCENARIOS) {
    const stored = await readJsonl<RunResult>(`${s.label}.jsonl`);
    let runs: RunResult[] = stored;

    if (REGRADE_FROM_TRAJECTORIES.has(s.label)) {
      const trajectories = await readJsonl<RunTrajectory>(`${s.label}.trajectories.jsonl`);
      const regraded = trajectories.map((traj) => ({
        ...gradeRunForScenario(traj, hetznerInvoiceDuplicateScenario),
        model: traj.model,
      }));
      // Keep stored rows that have no trajectory (run-timeouts) as failures.
      const perModelTraj = new Map<string, number>();
      for (const t of trajectories) {
        perModelTraj.set(t.model, (perModelTraj.get(t.model) ?? 0) + 1);
      }
      const leftovers: RunResult[] = [];
      const seen = new Map<string, number>();
      for (const r of stored) {
        seen.set(r.model, (seen.get(r.model) ?? 0) + 1);
        if ((seen.get(r.model) ?? 0) > (perModelTraj.get(r.model) ?? 0)) leftovers.push(r);
      }
      runs = [...regraded, ...leftovers];
    }

    scenarios.push({
      label: s.label,
      slug: s.slug,
      axis: s.axis,
      totalRuns: runs.length,
      models: aggregate(runs),
    });
  }

  const out = {
    generatedFrom: "packages/web/eval/data (heypinchy/pinchy)",
    scenarios,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

void main();
