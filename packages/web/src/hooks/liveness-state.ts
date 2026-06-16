/**
 * Pure state machine for agent-run liveness shown in the chat UI.
 *
 * The cardinal rule: the `failed` status may ONLY be entered from an
 * authoritative terminal `failed` event coming from the server (which gets it
 * from the OpenClaw gateway). It is structurally impossible for a timer or a
 * soft "slow" hint to ever produce `failed` — that false-failure (the old
 * "The agent didn't respond" 60s timer bug) is made unrepresentable here.
 *
 * `slow` is only a display hint meaning "still responding, taking longer than
 * expected". It is never a failure and never alters a non-responding state.
 */
export type LivenessStatus = "idle" | "responding" | "slow" | "failed";

export interface LivenessState {
  status: LivenessStatus;
  reason?: string;
}

export type LivenessEvent =
  | { type: "started" } // user sent / a run became active
  | { type: "slowHint" } // soft timer fired while responding (display only)
  | { type: "completed" } // authoritative: run finished successfully
  | { type: "failed"; reason: string } // authoritative terminal failure (ONLY source of `failed`)
  | { type: "reset" }; // agent switch / clear

export const INITIAL_LIVENESS: LivenessState = { status: "idle" };

/** `responding` and `slow` both mean a run is in flight. */
export function isRunningStatus(status: LivenessStatus): boolean {
  return status === "responding" || status === "slow";
}

export function livenessReducer(state: LivenessState, event: LivenessEvent): LivenessState {
  switch (event.type) {
    case "started":
      // A new turn starts from any state and clears any previous reason.
      return { status: "responding" };

    case "slowHint":
      // A slow hint only escalates an in-flight `responding` run. From any
      // other state it is a no-op so it can never resurrect or alter a
      // non-responding (idle / failed / already-slow) state.
      return state.status === "responding" ? { status: "slow" } : state;

    case "completed":
      // A turn finished successfully; ready for the next one. A `completed`
      // must NEVER override an authoritative `failed` — a fast-run reconnect
      // verdict (`failed`) and the pipe's own terminal `completed` can overlap
      // on the wire, and the failure has to win. Only `started`/`reset` clears
      // a failed state. (Cardinal rule corollary: `failed` is sticky.)
      return state.status === "failed" ? state : { status: "idle" };

    case "failed":
      // The ONLY transition that yields `failed`.
      return { status: "failed", reason: event.reason };

    case "reset":
      return INITIAL_LIVENESS;
  }
}
