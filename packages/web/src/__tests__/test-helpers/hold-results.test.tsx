// @vitest-environment jsdom
import { vi } from "vitest";

// Preempt React's Scheduler, deterministically. The Scheduler captures
// `setImmediate` once, when it loads; this runs before any import, so React's
// copy lands every task 5ms late. That is the loaded-CI-worker case the helper
// exists for: a wait that only works because the Scheduler happened to win a
// race against waitFor's trailing setTimeout(0) goes red here every time,
// instead of once a week. (Vitest runs each test file in its own process, so
// the delay cannot leak into another file.)
const preempted = vi.hoisted(() => {
  const original = globalThis.setImmediate;
  const state = { original, tasks: 0 };
  globalThis.setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    state.tasks++;
    return setTimeout(() => fn(...args), 5);
  }) as unknown as typeof setImmediate;
  return state;
});

import { useEffect, useState } from "react";
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { holdResults } from "@/test-helpers/hold-results";

// Only React's captured copy stays delayed; everything else gets the real one.
globalThis.setImmediate = preempted.original;

type Status = { overdue: boolean };

/**
 * Shows the fetched status, and DERIVES a warning from it in a second effect —
 * so the warning lands one commit (one Scheduler task) after the data does.
 * The data's own commit mutates the DOM, which is what lets a waitFor keyed on
 * that commit return before the warning exists.
 */
function EffectDerivedWarning({ load }: { load: () => Promise<Status> }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [warn, setWarn] = useState(false);
  useEffect(() => {
    void load().then(setStatus);
  }, [load]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the update an effect derives from the data, one commit late, IS the case under test
    if (status?.overdue) setWarn(true);
  }, [status]);
  if (!status) return null;
  return (
    <div>
      <p>Status loaded</p>
      {warn && <div role="alert">Overdue</div>}
    </div>
  );
}

/** Swallows a failed read — and, as a canary, says so. */
function SwallowedFailure({ load }: { load: () => Promise<Status> }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    load().catch(() => setFailed(true));
  }, [load]);
  return failed ? <div role="alert">Read failed</div> : null;
}

/** Requests the data only after a click, behind an extra await. */
function LoadOnClick({ load }: { load: () => Promise<Status> }) {
  const [warn, setWarn] = useState(false);
  const onClick = async () => {
    await Promise.resolve();
    const status = await load();
    if (status.overdue) setWarn(true);
  };
  return (
    <div>
      <button onClick={onClick}>Check</button>
      {warn && <div role="alert">Overdue</div>}
    </div>
  );
}

// Each test below is a canary: the component DOES render the forbidden thing
// for the held outcome, and it must be visible by the time release() returns.
// That is what makes a negative assertion after release() mean something — if
// the canary could still be on its way, `not.toBeInTheDocument()` would pass on
// a broken component.
describe("holdResults", () => {
  it("runs against a preempted Scheduler (harness check)", async () => {
    // If the Scheduler loaded before the hoisted override (a shared module
    // cache, a setup file importing react-dom), nothing is preempted and every
    // canary below would pass for the wrong reason. An update made outside act
    // is the Scheduler's to run, so it must go through the delayed copy.
    let setOn!: (on: boolean) => void;
    function Toggle({ expose }: { expose: (set: (on: boolean) => void) => void }) {
      const [on, set] = useState(false);
      useEffect(() => expose(set), [expose]);
      return on ? <p>on</p> : null;
    }
    render(<Toggle expose={(set) => (setOn = set)} />);
    const before = preempted.tasks;
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasActEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      setOn(true);
      await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
    }
    expect(preempted.tasks).toBeGreaterThan(before);
  });

  it("has applied state an effect derives from the data by the time release() returns", async () => {
    const load = holdResults();
    render(<EffectDerivedWarning load={() => load.resolveWith({ overdue: true })} />);
    await load.release();
    expect(screen.getByRole("alert")).toHaveTextContent("Overdue");
  });

  it("has run the handler of a swallowed rejection by the time release() returns", async () => {
    const load = holdResults();
    render(<SwallowedFailure load={() => load.rejectWith(new Error("network down"))} />);
    await load.release();
    expect(screen.getByRole("alert")).toHaveTextContent("Read failed");
  });

  it("waits for a request the component has not made yet, then applies its outcome", async () => {
    const load = holdResults();
    render(<LoadOnClick load={() => load.resolveWith({ overdue: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await load.release();
    expect(screen.getByRole("alert")).toHaveTextContent("Overdue");
  });

  it("fails loudly when the component never requests the data", async () => {
    const load = holdResults();
    render(<p>No request here</p>);
    await expect(load.release()).rejects.toThrow("the component has not requested the mocked data");
  });
});
