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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  trackConfigPushStarted,
  trackConfigPushSettled,
  getPendingConfigPushCount,
  nextConfigPushGeneration,
  getCurrentConfigPushGeneration,
  noteRegenerateCall,
  takeRegenerateRunIsFollowUpOnly,
  recordWrittenSecrets,
  writtenSecretsShape,
  noteUndeliveredConfigChange,
  undeliveredConfigChange,
  settleUndeliveredConfigChange,
  noteFullRegenerateDelivered,
  fullRegenerateDeliveredSince,
  noteFileOnlyDelivery,
  settleFileOnlyDelivery,
  scheduleFileOnlyFollowUp,
  FILE_ONLY_FOLLOW_UP_DELAY_MS,
  MAX_FILE_ONLY_FOLLOW_UPS,
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
    trackConfigPushStarted(1);
    expect(getPendingConfigPushCount()).toBe(1);
    trackConfigPushStarted(2);
    expect(getPendingConfigPushCount()).toBe(2);
    trackConfigPushSettled(1);
    expect(getPendingConfigPushCount()).toBe(1);
    trackConfigPushSettled(2);
    expect(getPendingConfigPushCount()).toBe(0);
  });

  it("floors at zero on a spurious extra settle (never goes negative)", () => {
    trackConfigPushSettled(1);
    expect(getPendingConfigPushCount()).toBe(0);
  });

  it("is backed by globalThis so separate module instances share one counter", () => {
    // The Next route bundle and the custom-server (tsx) bundle each get their
    // own module instance of push-state. A plain module-level variable would
    // give the health route a counter the server's pushes never touch. Pin the
    // contract: the state lives under a well-known globalThis key.
    trackConfigPushStarted(1);
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
    trackConfigPushStarted(4);
    trackConfigPushSettled(4);
    expect(getPendingConfigPushCount()).toBe(0);
    expect(getCurrentConfigPushGeneration()).toBe(4);
  });
});

// regenerateOpenClawConfig is serialized: calls made while a run is in flight
// share the next run (regenerate-queue.ts). A stranded provider deletion's
// follow-up regenerate must not queue a follow-up of its own (no loop) — but a
// real change that shares a run with it keeps its right to one.
describe("which regenerate run counts as a shrink follow-up", () => {
  beforeEach(() => {
    _resetConfigPushState();
  });

  it("is a follow-up only when every call it serves is one", () => {
    noteRegenerateCall({ shrinkFollowUp: true });
    expect(takeRegenerateRunIsFollowUpOnly()).toBe(true);

    noteRegenerateCall({ shrinkFollowUp: true });
    noteRegenerateCall({ shrinkFollowUp: false });
    noteRegenerateCall({ shrinkFollowUp: true });
    expect(takeRegenerateRunIsFollowUpOnly()).toBe(false);
  });

  it("starts every run from scratch, and a run no call recorded is no follow-up", () => {
    noteRegenerateCall({ shrinkFollowUp: false });
    expect(takeRegenerateRunIsFollowUpOnly()).toBe(false);
    noteRegenerateCall({ shrinkFollowUp: true });
    expect(takeRegenerateRunIsFollowUpOnly()).toBe(true);
    expect(takeRegenerateRunIsFollowUpOnly()).toBe(false);
  });
});

// The push's file fallback asks whether OpenClaw would resolve a payload's
// SecretRefs against the secrets.json Pinchy last wrote — a file Pinchy cannot
// read back in production. So the regenerate records what it wrote, process-
// wide (the push can run in another module instance), as a shape: which
// pointers resolve, never a value.
describe("the recorded secrets shape", () => {
  beforeEach(() => _resetConfigPushState());

  it("keeps which pointers resolve, and no secret value", () => {
    expect(writtenSecretsShape()).toBeUndefined();
    recordWrittenSecrets({
      gateway: { token: "gw-secret" },
      providers: { anthropic: { apiKey: "sk-ant-secret" } },
    });
    expect(writtenSecretsShape()).toEqual({
      gateway: { token: "" },
      providers: { anthropic: { apiKey: "" } },
    });
    expect(JSON.stringify(globalThis.__pinchyConfigPushState)).not.toMatch(/secret/);
  });
});

// A config change a push could not deliver while OpenClaw was unreachable is
// owed to OpenClaw's next connect (regenerateOnConnect). Only a full
// regenerate that STARTED after the push gave up has read the state that push
// carried, so only such a one settles the debt when its config reaches
// OpenClaw — the same start-order rule cancelShrinkResume follows.
describe("a config change Pinchy could not deliver", () => {
  beforeEach(() => _resetConfigPushState());

  it("is owed until a regenerate that started after it lands", () => {
    expect(undeliveredConfigChange()).toBe(false);
    noteUndeliveredConfigChange(5);
    expect(undeliveredConfigChange()).toBe(true);

    settleUndeliveredConfigChange(4);
    settleUndeliveredConfigChange(5);
    expect(undeliveredConfigChange(), "a regenerate that started before it").toBe(true);

    settleUndeliveredConfigChange(6);
    expect(undeliveredConfigChange()).toBe(false);
  });

  it("stands for the newest change that gave up", () => {
    noteUndeliveredConfigChange(7);
    noteUndeliveredConfigChange(3);
    settleUndeliveredConfigChange(6);
    expect(undeliveredConfigChange()).toBe(true);
    settleUndeliveredConfigChange(8);
    expect(undeliveredConfigChange()).toBe(false);
  });

  it("is settled by a delivered regenerate, which a push that started before it no longer owes", () => {
    noteUndeliveredConfigChange(5);
    noteFullRegenerateDelivered(7);
    expect(undeliveredConfigChange()).toBe(false);
    // A push that started before the delivered regenerate and gives up only
    // now: that regenerate read the state it carried.
    expect(fullRegenerateDeliveredSince(6)).toBe(true);
    // One that started after it carries something that regenerate never saw.
    expect(fullRegenerateDeliveredSince(7)).toBe(false);
    expect(fullRegenerateDeliveredSince(8)).toBe(false);
    // An older regenerate delivering later does not move the line back.
    noteFullRegenerateDelivered(3);
    expect(fullRegenerateDeliveredSince(6)).toBe(true);
  });

  it("is shared by every module instance in the process", async () => {
    // The push that gives up can run in a route bundle; the connected handler
    // that pays the debt runs in the custom server's instance.
    noteUndeliveredConfigChange(2);
    vi.resetModules();
    const other = await import("@/lib/openclaw-config/push-state");
    expect(other.undeliveredConfigChange()).toBe(true);
    other.settleUndeliveredConfigChange(3);
    expect(undeliveredConfigChange()).toBe(false);
  });
});

// A file-only delivery with no reconnect coming — the rate-limit fallback while
// OpenClaw stays connected — has nothing else to deliver it: the follow-up
// regenerate is what does (noteFileOnlyDelivery in push-state.ts).
describe("the follow-up regenerate for a file-only delivery", () => {
  beforeEach(() => {
    _resetConfigPushState();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("regenerates one rate-limit window after the fallback", () => {
    noteFileOnlyDelivery();
    const regenerate = vi.fn();
    scheduleFileOnlyFollowUp(regenerate);

    vi.advanceTimersByTime(FILE_ONLY_FOLLOW_UP_DELAY_MS - 1);
    expect(regenerate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("keeps at most one pending, however many fallbacks schedule one", () => {
    noteFileOnlyDelivery();
    const regenerate = vi.fn();
    scheduleFileOnlyFollowUp(regenerate);
    scheduleFileOnlyFollowUp(regenerate);

    vi.advanceTimersByTime(FILE_ONLY_FOLLOW_UP_DELAY_MS * 2);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("is cancelled once an apply lands", () => {
    noteFileOnlyDelivery();
    const regenerate = vi.fn();
    scheduleFileOnlyFollowUp(regenerate);
    settleFileOnlyDelivery();

    vi.advanceTimersByTime(FILE_ONLY_FOLLOW_UP_DELAY_MS * 2);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("waits while the newest push is still in flight, which settles it itself", () => {
    noteFileOnlyDelivery();
    const generation = nextConfigPushGeneration();
    trackConfigPushStarted(generation);
    const regenerate = vi.fn();
    scheduleFileOnlyFollowUp(regenerate);

    vi.advanceTimersByTime(FILE_ONLY_FOLLOW_UP_DELAY_MS * 3);
    expect(regenerate).not.toHaveBeenCalled();

    trackConfigPushSettled(generation);
    vi.advanceTimersByTime(FILE_ONLY_FOLLOW_UP_DELAY_MS);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("stops after a bounded number of follow-ups per pending delivery", () => {
    // Each follow-up that is rate-limited again falls back and schedules the
    // next; the chain must end even if OpenClaw never accepts an apply.
    noteFileOnlyDelivery();
    const regenerate = vi.fn(() => scheduleFileOnlyFollowUp(regenerate));
    scheduleFileOnlyFollowUp(regenerate);

    vi.advanceTimersByTime(FILE_ONLY_FOLLOW_UP_DELAY_MS * (MAX_FILE_ONLY_FOLLOW_UPS + 5));
    expect(regenerate).toHaveBeenCalledTimes(MAX_FILE_ONLY_FOLLOW_UPS);

    // A landed apply ends the episode; the next fallback gets a fresh budget.
    settleFileOnlyDelivery();
    noteFileOnlyDelivery();
    scheduleFileOnlyFollowUp(vi.fn());
    const next = vi.fn();
    scheduleFileOnlyFollowUp(next);
    vi.advanceTimersByTime(FILE_ONLY_FOLLOW_UP_DELAY_MS);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
