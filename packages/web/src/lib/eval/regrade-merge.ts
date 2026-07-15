import type { RunResult, RunTrajectory } from "./types";

/**
 * Overlay freshly-graded trajectory results onto a scenario's stored
 * RunResults, joined by (model, latencyMs).
 *
 * Trajectories are a possibly-sparse, NON-prefix subset of the stored runs: the
 * hard-rejection scenario captured only 4 of 12 deepseek runs, and NOT the
 * first 4. Positional matching (regrade the first k stored rows per model)
 * therefore silently regrades the wrong runs — it would flip real run-timeouts
 * to passes while leaving the actual false-success rows, which sit at
 * non-prefix positions, untouched.
 *
 * `latencyMs` is the per-run measured latency, written identically into both
 * the results log and the trajectory dump for the same run, so it is a stable
 * join key. A stored run with no matching trajectory (run-timeouts never dump
 * one; models with partial trajectory coverage keep their tail) retains its
 * stored grade. Order and count of `stored` are preserved exactly, so the
 * cell's n is unchanged.
 *
 * `gradeRun` must return a RunResult whose `model` is set (the caller applies
 * the current graders for the scenario).
 *
 * The join only holds while `latencyMs` really does identify a run, and a broken
 * premise fails QUIETLY by nature: an unmatched trajectory just drops its
 * re-grade, and the published cell silently keeps the stale pre-fix grade while
 * looking perfectly plausible. That is the exact false-green this module exists
 * to remove, so the premise is asserted rather than assumed — a violation must
 * turn into a red build, not a wrong number on the website.
 *
 * @param context Optional scenario label, echoed in errors so a failure names
 *   the dataset that broke.
 */
export function applyTrajectoryRegrade(
  stored: RunResult[],
  trajectories: RunTrajectory[],
  gradeRun: (traj: RunTrajectory) => RunResult,
  context?: string
): RunResult[] {
  const key = (model: string, latencyMs: number): string => `${model}::${String(latencyMs)}`;
  const where = context ? ` in ${context}` : "";

  const storedKeys = new Set<string>();
  const duplicateStored = new Set<string>();
  for (const r of stored) {
    const k = key(r.model, r.latencyMs);
    if (storedKeys.has(k)) duplicateStored.add(k);
    storedKeys.add(k);
  }
  if (duplicateStored.size > 0) {
    throw new Error(
      `applyTrajectoryRegrade: duplicate (model, latencyMs) among stored runs${where}: ` +
        `${[...duplicateStored].join(", ")}. latencyMs no longer identifies a run, so one ` +
        `trajectory would re-grade several runs.`
    );
  }

  const regradedByKey = new Map<string, RunResult>();
  const orphans: string[] = [];
  const duplicateTrajectories: string[] = [];
  for (const traj of trajectories) {
    const k = key(traj.model, traj.latencyMs);
    if (!storedKeys.has(k)) orphans.push(k);
    if (regradedByKey.has(k)) duplicateTrajectories.push(k);
    regradedByKey.set(k, gradeRun(traj));
  }
  if (duplicateTrajectories.length > 0) {
    throw new Error(
      `applyTrajectoryRegrade: duplicate (model, latencyMs) among trajectories${where}: ` +
        `${duplicateTrajectories.join(", ")}. Only the last would be applied, hiding a run.`
    );
  }
  if (orphans.length > 0) {
    throw new Error(
      `applyTrajectoryRegrade: ${String(orphans.length)} trajectory/ies match no stored run` +
        `${where}: ${orphans.join(", ")}. Their re-grade would be dropped and the published ` +
        `cell would silently keep its stale stored grade.`
    );
  }

  return stored.map((r) => regradedByKey.get(key(r.model, r.latencyMs)) ?? r);
}
