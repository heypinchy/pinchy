import { describe, expect, it } from "vitest";
import { applyTrajectoryRegrade } from "../regrade-merge";
import type { RunResult, RunTrajectory } from "../types";

// A minimal stored RunResult; only the fields the merge keys on matter here.
function stored(
  model: string,
  latencyMs: number,
  passed: boolean,
  tags: RunResult["tags"]
): RunResult {
  return { model, scenario: "s", passed, tags, notes: [], latencyMs };
}

function traj(model: string, latencyMs: number): RunTrajectory {
  return { model, toolCalls: [], finalMessage: "", odooMoves: [], latencyMs };
}

describe("applyTrajectoryRegrade", () => {
  it("regrades the run its trajectory was dumped from, joined by (model, latencyMs) — NOT by position", () => {
    // The hard-rejection shape: a false-success stored at a NON-prefix position,
    // with a sparse trajectory set that does not cover the first rows. Positional
    // matching would regrade the wrong rows; latency keying hits the right one.
    const storedRuns = [
      stored("m", 300001, false, ["run-timeout"]),
      stored("m", 300002, false, ["run-timeout"]),
      stored("m", 223475, true, []),
      stored("m", 254451, false, ["false-success"]), // the run to correct
      stored("m", 300003, false, ["run-timeout"]),
    ];
    // Only the two runs that actually have trajectories; the false-success one
    // now grades honest.
    const trajectories = [traj("m", 254451), traj("m", 223475)];
    const gradeRun = (t: RunTrajectory): RunResult => stored(t.model, t.latencyMs, true, []); // pretend the current grader passes both

    const merged = applyTrajectoryRegrade(storedRuns, trajectories, gradeRun);

    // Same count, same order preserved.
    expect(merged).toHaveLength(5);
    expect(merged.map((r) => r.latencyMs)).toEqual([300001, 300002, 223475, 254451, 300003]);
    // The false-success run was flipped to pass; timeouts untouched.
    expect(merged.find((r) => r.latencyMs === 254451)).toMatchObject({ passed: true, tags: [] });
    expect(merged.filter((r) => r.tags.includes("false-success"))).toHaveLength(0);
    expect(merged.filter((r) => r.tags.includes("run-timeout"))).toHaveLength(3);
  });

  it("keeps stored runs that have no matching trajectory (e.g. run-timeouts never dump one)", () => {
    const storedRuns = [
      stored("m", 111, false, ["run-timeout"]),
      stored("m", 222, false, ["false-success"]),
    ];
    const trajectories = [traj("m", 222)];
    const gradeRun = (t: RunTrajectory): RunResult => stored(t.model, t.latencyMs, true, []);

    const merged = applyTrajectoryRegrade(storedRuns, trajectories, gradeRun);

    expect(merged.find((r) => r.latencyMs === 111)).toMatchObject({
      passed: false,
      tags: ["run-timeout"],
    });
    expect(merged.find((r) => r.latencyMs === 222)).toMatchObject({ passed: true, tags: [] });
  });

  it("keys on model too, so identical latencies across models don't cross-match", () => {
    const storedRuns = [
      stored("a", 500, false, ["false-success"]),
      stored("b", 500, false, ["false-success"]),
    ];
    const trajectories = [traj("a", 500)];
    const gradeRun = (t: RunTrajectory): RunResult => stored(t.model, t.latencyMs, true, []);

    const merged = applyTrajectoryRegrade(storedRuns, trajectories, gradeRun);

    expect(merged.find((r) => r.model === "a")).toMatchObject({ passed: true, tags: [] });
    // b had no trajectory of its own — untouched despite sharing the latency.
    expect(merged.find((r) => r.model === "b")).toMatchObject({
      passed: false,
      tags: ["false-success"],
    });
  });

  it("full coverage replaces every run (the duplicate/silent common case)", () => {
    const storedRuns = [
      stored("m", 10, false, ["false-success"]),
      stored("m", 20, false, ["false-success"]),
    ];
    const trajectories = [traj("m", 10), traj("m", 20)];
    const gradeRun = (t: RunTrajectory): RunResult => stored(t.model, t.latencyMs, true, []);

    const merged = applyTrajectoryRegrade(storedRuns, trajectories, gradeRun);

    expect(merged.every((r) => r.passed)).toBe(true);
  });

  it("applies a re-graded FAILURE, carrying its tags onto the published row", () => {
    // The other cases all regrade to a pass; a grader that newly CONDEMNS a run
    // (e.g. detectInfraError) must land too, tags and all.
    const storedRuns = [stored("m", 10, true, [])];
    const trajectories = [traj("m", 10)];
    const gradeRun = (t: RunTrajectory): RunResult =>
      stored(t.model, t.latencyMs, false, ["run-infra-error"]);

    const merged = applyTrajectoryRegrade(storedRuns, trajectories, gradeRun);

    expect(merged[0]).toMatchObject({ passed: false, tags: ["run-infra-error"] });
  });

  // The join is only correct while latencyMs actually identifies a run. These
  // guards turn a broken premise into a loud failure instead of a silently
  // stale published number — the export must never quietly fall back to the
  // pre-fix grade.
  describe("invariant guards", () => {
    const gradeRun = (t: RunTrajectory): RunResult => stored(t.model, t.latencyMs, true, []);

    it("throws when a trajectory matches no stored run (its regrade would be silently dropped)", () => {
      const storedRuns = [stored("m", 10, false, ["false-success"])];
      const trajectories = [traj("m", 10), traj("m", 999)];

      expect(() => applyTrajectoryRegrade(storedRuns, trajectories, gradeRun)).toThrow(/m::999/);
    });

    it("names the scenario in the error when given a context label", () => {
      const storedRuns = [stored("m", 10, false, [])];
      const trajectories = [traj("m", 999)];

      expect(() =>
        applyTrajectoryRegrade(
          storedRuns,
          trajectories,
          gradeRun,
          "hetzner-invoice-rejected-models"
        )
      ).toThrow(/hetzner-invoice-rejected-models/);
    });

    it("throws on duplicate trajectory keys (last-wins would hide a run)", () => {
      const storedRuns = [stored("m", 10, false, [])];
      const trajectories = [traj("m", 10), traj("m", 10)];

      expect(() => applyTrajectoryRegrade(storedRuns, trajectories, gradeRun)).toThrow(/m::10/);
    });

    it("throws on duplicate stored keys (one trajectory would regrade two runs)", () => {
      const storedRuns = [stored("m", 10, false, []), stored("m", 10, false, [])];
      const trajectories = [traj("m", 10)];

      expect(() => applyTrajectoryRegrade(storedRuns, trajectories, gradeRun)).toThrow(/m::10/);
    });
  });
});
