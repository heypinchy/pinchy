import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// server.js is CommonJS and exports a testable core. Importing it does NOT
// boot the HTTPS/control servers (guarded by `require.main === module`), so
// no ports are bound — this runs hermetically under `node --test`.
const require = createRequire(import.meta.url);
const {
  resetState,
  injectMessage,
  handleGetUpdates,
  getHealthSnapshot,
  ACTIVE_GRACE_MS,
} = require("../server.js");

const TOKEN = "123456:ABC-test-token-for-e2e";
const CHAT_ID = "999888777";

function inject(text) {
  return injectMessage({
    token: TOKEN,
    chatId: CHAT_ID,
    text,
    userId: CHAT_ID,
    username: "e2e_tester",
    firstName: "E2E",
    lastName: "Tester",
  });
}

// Regression guard for the Telegram E2E flakiness: every spec's beforeAll calls
// /control/reset. OpenClaw's already-running long-poll keeps its acknowledged
// getUpdates offset across that reset and never re-calls getMe. If reset rewound
// update_id to a low value, the next injected message would carry an id BELOW
// that stale offset, handleGetUpdates would filter it out, and the bot would
// never reply (waitForBotResponse times out at 150s). update_id must stay
// monotonic across resets so a stale poller still receives fresh messages.
test("update_id stays monotonic across reset so a stale poller offset still receives new messages", async () => {
  resetState();

  // Simulate prior traffic; OpenClaw would now poll with offset = last + 1.
  inject("first");
  inject("second");
  const lastBeforeReset = inject("third");
  const stalePollerOffset = lastBeforeReset + 1;

  // A test's beforeAll wipes per-test state mid-stack.
  resetState();

  // The next inbound message after the reset.
  const idAfterReset = inject("after reset");

  assert.ok(
    idAfterReset >= stalePollerOffset,
    `update_id must not rewind across reset: got ${idAfterReset}, ` +
      `stale poller offset is ${stalePollerOffset}`
  );

  // Behavioural check against the real symptom: a poller holding the stale
  // offset must still be handed the freshly injected update. timeout:"0" keeps
  // the buggy (empty) path from blocking on the 30s long-poll.
  const res = await handleGetUpdates(TOKEN, {
    offset: String(stalePollerOffset),
    timeout: "0",
  });
  const deliveredIds = (res.result || []).map((u) => u.update_id);

  assert.ok(
    deliveredIds.includes(idAfterReset),
    `stale poller (offset ${stalePollerOffset}) should receive update ` +
      `${idAfterReset}, got ${JSON.stringify(deliveredIds)}`
  );
});

// ── activePollingTokens (Issue #476 Gap 1 oracle) ───────────────────────
//
// `pollingTokens` only ever grows (cleared by /control/reset) — it answers
// "has this bot EVER polled", not "is this bot polling RIGHT NOW". That makes
// it useless as an oracle for "the poller stopped after disconnect": once a
// token is in the set it stays there forever, even if OpenClaw's channel
// worker for that bot has been torn down. `activePollingTokens` answers the
// live question instead: a token is active while it has a getUpdates request
// in flight, or settled one within a SHORT grace window (ACTIVE_GRACE_MS).
// Tracking the in-flight connection — rather than only a freshness timestamp —
// is what lets a disconnect test observe the stop within seconds: an open
// long-poll keeps the token active no matter how long it runs, and once the
// poll is aborted (client disconnect) the token drops out within the grace.
test("activePollingTokens includes a token that just settled a poll", async () => {
  resetState();

  await handleGetUpdates(TOKEN, { offset: "0", timeout: "0" });

  const health = getHealthSnapshot();
  assert.ok(
    health.activePollingTokens.includes(TOKEN),
    `expected ${TOKEN} in activePollingTokens, got ${JSON.stringify(health.activePollingTokens)}`
  );
  // Back-compat: pollingTokens (ever-polled) must still include it too.
  assert.ok(health.pollingTokens.includes(TOKEN));
});

test("activePollingTokens drops a settled token once the grace window elapses", async () => {
  resetState();

  await handleGetUpdates(TOKEN, { offset: "0", timeout: "0" });
  assert.ok(getHealthSnapshot().activePollingTokens.includes(TOKEN));

  // No poll in flight and the grace window has elapsed without a new poll.
  const health = getHealthSnapshot(Date.now() + ACTIVE_GRACE_MS + 1);
  assert.ok(
    !health.activePollingTokens.includes(TOKEN),
    `expected ${TOKEN} to have dropped out of activePollingTokens after the grace window, ` +
      `got ${JSON.stringify(health.activePollingTokens)}`
  );
  // pollingTokens (ever-polled, back-compat) is NOT time-based and must still
  // include it — other specs rely on this field never shrinking except on reset.
  assert.ok(health.pollingTokens.includes(TOKEN));
});

// The core of the #476 Gap 1 fix: an OPEN long-poll must keep the token active
// no matter how much wall-clock passes (so a healthy 30s long-poller is never
// mistaken for stopped), yet once the poll is aborted the token must drop out
// within the SHORT grace — NOT only after a full long-poll timeout. A pure
// freshness window can't express both at once: a window long enough to survive
// a 30s long-poll is necessarily longer than the ~1s stop the disconnect test
// needs to see.
test("an in-flight long-poll keeps a token active indefinitely; aborting it drops the token within the grace window", async () => {
  resetState();

  // Model OpenClaw's live poller: an open getUpdates connection we don't await.
  const ac = new AbortController();
  const inflight = handleGetUpdates(
    TOKEN,
    { offset: "0", timeout: "30" },
    { signal: ac.signal }
  );

  // Even far beyond the grace window, an open poll reads as active.
  const whilePolling = getHealthSnapshot(Date.now() + 100 * ACTIVE_GRACE_MS);
  assert.ok(
    whilePolling.activePollingTokens.includes(TOKEN),
    `an in-flight long-poll must keep ${TOKEN} active regardless of elapsed time, ` +
      `got ${JSON.stringify(whilePolling.activePollingTokens)}`
  );

  // Client disconnects (OpenClaw tears the worker down) → the poll settles.
  ac.abort();
  await inflight;

  // Immediately after: still within grace, so still active.
  assert.ok(getHealthSnapshot().activePollingTokens.includes(TOKEN));
  // Past the grace window: dropped — the stop is observable within
  // ACTIVE_GRACE_MS, well under the disconnect spec's 15s window.
  const afterGrace = getHealthSnapshot(Date.now() + ACTIVE_GRACE_MS + 1);
  assert.ok(
    !afterGrace.activePollingTokens.includes(TOKEN),
    `after abort + grace, ${TOKEN} must drop out of activePollingTokens, ` +
      `got ${JSON.stringify(afterGrace.activePollingTokens)}`
  );
});

test("/control/reset clears in-flight/last-poll state so activePollingTokens is empty", async () => {
  resetState();
  await handleGetUpdates(TOKEN, { offset: "0", timeout: "0" });
  assert.ok(getHealthSnapshot().activePollingTokens.includes(TOKEN));

  resetState();

  const health = getHealthSnapshot();
  assert.deepEqual(health.activePollingTokens, []);
  assert.deepEqual(health.pollingTokens, []);
});
