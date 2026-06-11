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
  _resetConfigPushState,
} from "@/lib/openclaw-config/push-state";

describe("config push pending-state tracker", () => {
  beforeEach(() => {
    _resetConfigPushState();
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
});
