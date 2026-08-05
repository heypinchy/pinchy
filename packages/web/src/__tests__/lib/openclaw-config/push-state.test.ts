// @vitest-environment jsdom
// Unit tests for the config-push pending-state tracker.
//
// Why this exists: `pushConfigInBackground` is fire-and-forget, and under
// OC 5.3's config.apply rate-limit (~3 calls / 45 s) a push coroutine can be
// parked for 33–53 s waiting out the window. During that gap the config change
// (e.g. a freshly-granted per-agent plugin config) is NOT in OC's runtime, but
// nothing observable says so — `/api/health/openclaw` reports connected=true
// throughout, so E2E stability gates pass and the test dispatches a chat whose
// run snapshots its tool list WITHOUT the pending change (the email
// dispatch-probe flake: "I can't use the tool email_list … it isn't available").
//
// The tracker makes "pushes still in flight" observable. It must live on
// globalThis because Next.js API routes (which serve /api/health/openclaw) and
// the custom server (which also triggers regenerates) can load SEPARATE module
// instances — same reason as server/openclaw-client.ts.

import { describe, it, expect, beforeEach } from "vitest";
import {
  trackConfigPushStarted,
  trackConfigPushSettled,
  getPendingConfigPushCount,
  nextConfigPushGeneration,
  getCurrentConfigPushGeneration,
  _resetConfigPushState,
} from "@/lib/openclaw-config/push-state";

describe("config push pending-state tracker", () => {
  beforeEach(() => {
    _resetConfigPushState();
    // The generation is a monotonic cancellation token and there is no reset
    // for it, on purpose (see push-state.ts). The tests below that need a
    // known starting value seed the globalThis object directly — which is what
    // a contract test for this cell should be doing in any case.
    (globalThis as Record<string, unknown>).__pinchyConfigPushState = {
      pending: 0,
      generation: 0,
    };
  });

  it("starts at zero pending", () => {
    expect(getPendingConfigPushCount()).toBe(0);
  });

  it("counts started pushes and settles them back to zero", () => {
    trackConfigPushStarted();
    expect(getPendingConfigPushCount()).toBe(1);
    trackConfigPushStarted();
    expect(getPendingConfigPushCount()).toBe(2);
    trackConfigPushSettled();
    expect(getPendingConfigPushCount()).toBe(1);
    trackConfigPushSettled();
    expect(getPendingConfigPushCount()).toBe(0);
  });

  it("floors at zero on a spurious extra settle (never goes negative)", () => {
    trackConfigPushSettled();
    expect(getPendingConfigPushCount()).toBe(0);
  });

  it("is backed by globalThis so separate module instances share one counter", () => {
    // The Next route bundle and the custom-server (tsx) bundle each get their
    // own module instance of push-state. A plain module-level variable would
    // give the health route a counter the server's pushes never touch. Pin the
    // contract: the state lives under a well-known globalThis key.
    trackConfigPushStarted();
    const state = (globalThis as Record<string, unknown>).__pinchyConfigPushState as {
      pending: number;
    };
    expect(state).toBeDefined();
    expect(state.pending).toBe(1);
    // And the reverse direction: a foreign module instance mutating the global
    // is visible through our getter.
    state.pending = 3;
    expect(getPendingConfigPushCount()).toBe(3);
  });

  it("shares the generation counter through the same globalThis key", () => {
    // Same contract for the push-generation counter, and it carries more
    // weight: `pushConfigInBackground` cancels an older push by comparing its
    // own generation against this one, so a per-instance counter means a
    // route-triggered push cannot supersede a server-triggered one — both
    // reach config.apply, which is the restart storm #193 is about.
    expect(nextConfigPushGeneration()).toBe(1);
    const state = (globalThis as Record<string, unknown>).__pinchyConfigPushState as {
      generation: number;
    };
    expect(state.generation).toBe(1);
    // A push claimed from a foreign module instance is visible here.
    state.generation = 7;
    expect(getCurrentConfigPushGeneration()).toBe(7);
    expect(nextConfigPushGeneration()).toBe(8);
  });

  it("normalizes a state object written before a field existed", () => {
    // globalThis outlives a module reload — that is the whole reason the state
    // lives here rather than in a module variable. So a dev server that was
    // already running when `generation` was added to this shape holds the
    // PREVIOUS version's object, and `??=` leaves an existing object alone.
    //
    // `generation` then reads as undefined, `++undefined` is NaN, and
    // `NaN !== NaN` is true — so every push takes the superseded branch at the
    // top of its very first retry iteration and returns. No config change
    // reaches config.apply, none reaches the file fallback either, for the
    // life of the process, with only a `gen=NaN` line in the log to say so.
    // Normalize the FIELDS, not just the object.
    (globalThis as Record<string, unknown>).__pinchyConfigPushState = { pending: 2 };

    expect(nextConfigPushGeneration()).toBe(1);
    expect(getCurrentConfigPushGeneration()).toBe(1);
    // A generation must be comparable to itself — the whole guard is `!==`.
    const claimed = nextConfigPushGeneration();
    expect(claimed === getCurrentConfigPushGeneration()).toBe(true);
    // …and the pre-existing field is carried over, not reset.
    expect(getPendingConfigPushCount()).toBe(2);
  });

  it("normalizes a state object that is missing the pending count", () => {
    // The mirror image, for whichever field a future shape adds next:
    // `Math.max(0, undefined - 1)` is NaN too, and a NaN pending count makes
    // `/api/health/openclaw` report `configPushesPending: null` while the E2E
    // stability gates wait for a 0 that can never arrive.
    (globalThis as Record<string, unknown>).__pinchyConfigPushState = { generation: 4 };

    expect(getPendingConfigPushCount()).toBe(0);
    trackConfigPushStarted();
    trackConfigPushSettled();
    expect(getPendingConfigPushCount()).toBe(0);
    expect(getCurrentConfigPushGeneration()).toBe(4);
  });
});
