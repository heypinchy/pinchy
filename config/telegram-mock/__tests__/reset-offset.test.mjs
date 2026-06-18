import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// server.js is CommonJS and exports a testable core. Importing it does NOT
// boot the HTTPS/control servers (guarded by `require.main === module`), so
// no ports are bound — this runs hermetically under `node --test`.
const require = createRequire(import.meta.url);
const { resetState, injectMessage, handleGetUpdates } = require("../server.js");

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
