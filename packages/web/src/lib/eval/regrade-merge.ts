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
 */
export function applyTrajectoryRegrade(
  stored: RunResult[],
  trajectories: RunTrajectory[],
  gradeRun: (traj: RunTrajectory) => RunResult
): RunResult[] {
  const key = (model: string, latencyMs: number): string => `${model}::${String(latencyMs)}`;
  const regradedByKey = new Map<string, RunResult>();
  for (const traj of trajectories) {
    regradedByKey.set(key(traj.model, traj.latencyMs), gradeRun(traj));
  }
  return stored.map((r) => regradedByKey.get(key(r.model, r.latencyMs)) ?? r);
}
