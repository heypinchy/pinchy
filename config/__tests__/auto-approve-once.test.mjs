import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseLatestRequestId,
  approveLatestOnce,
} from "../auto-approve-once.mjs";

/**
 * Fake `openclaw devices` gateway that reproduces the production requestId
 * churn: while a device-pairing request is pending, Pinchy keeps reconnecting
 * (exponential backoff) and every reconnect makes OpenClaw mint a *fresh*
 * pairing requestId, superseding the previous one. So the id discovered by
 * `--latest` can already be stale by the time `approve <id>` runs, and the
 * gateway then rejects it with "unknown requestId".
 *
 * `churn` = how many of the first approve attempts race a concurrent reconnect
 * (rotate the pending id and reject the approve). After the churn budget is
 * spent the pending id stabilises and the matching approve succeeds.
 */
function makeFakeGateway({ initialId = "req-1", churn = 0 } = {}) {
  const state = {
    currentId: initialId,
    churnRemaining: churn,
    counter: 1,
    approveCalls: [],
    approvedId: null,
  };
  const exec = (args) => {
    if (args.includes("--latest")) {
      if (state.currentId === null) {
        return { code: 1, stdout: JSON.stringify({}), stderr: "" };
      }
      return {
        code: 1,
        stdout: JSON.stringify({
          selected: { requestId: state.currentId },
          approveCommand: `openclaw devices approve ${state.currentId}`,
        }),
        stderr: "",
      };
    }
    // Explicit approve: `["devices", "approve", <id>, "--json"]`.
    const id = args[2];
    state.approveCalls.push(id);
    if (state.churnRemaining > 0) {
      // A concurrent Pinchy reconnect replaced the pending request after we
      // discovered it but before this approve landed.
      state.churnRemaining -= 1;
      state.counter += 1;
      state.currentId = `req-${state.counter}`;
      return { code: 1, stdout: "", stderr: "unknown requestId" };
    }
    if (id === state.currentId) {
      state.approvedId = id;
      return {
        code: 0,
        stdout: JSON.stringify({
          requestId: id,
          device: { deviceId: "dev-1" },
        }),
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "unknown requestId" };
  };
  return { state, exec };
}

test("parseLatestRequestId reads selected.requestId from --json output", () => {
  assert.equal(
    parseLatestRequestId(JSON.stringify({ selected: { requestId: "req-9" } })),
    "req-9",
  );
});

test("parseLatestRequestId returns null when nothing is pending", () => {
  assert.equal(parseLatestRequestId(JSON.stringify({})), null);
  assert.equal(
    parseLatestRequestId("No pending device pairing requests to approve"),
    null,
  );
  assert.equal(parseLatestRequestId(""), null);
  assert.equal(parseLatestRequestId(undefined), null);
});

test("parseLatestRequestId falls back to the explicit approve-command hint", () => {
  assert.equal(
    parseLatestRequestId(
      "Approve this exact request with: openclaw devices approve req-abc==",
    ),
    "req-abc==",
  );
});

test("parseLatestRequestId recovers the id from approveCommand when selected is absent", () => {
  // Defensive: if a future --json shape omits selected.requestId but still
  // carries the approveCommand hint, the regex fallback must still find the id.
  assert.equal(
    parseLatestRequestId(
      JSON.stringify({ approveCommand: "openclaw devices approve req-xyz" }),
    ),
    "req-xyz",
  );
});

test("approveLatestOnce converges on the live request despite requestId churn", () => {
  const { state, exec } = makeFakeGateway({ initialId: "req-1", churn: 2 });
  const result = approveLatestOnce({ exec, log: () => {}, maxAttempts: 6 });
  assert.equal(result.outcome, "approved");
  assert.equal(result.requestId, state.approvedId);
  // 1 initial attempt + 2 re-discoveries after the churned rejections.
  assert.equal(state.approveCalls.length, 3);
});

test("approveLatestOnce without a retry budget fails under churn (reproduces the flake)", () => {
  const { exec } = makeFakeGateway({ initialId: "req-1", churn: 2 });
  const result = approveLatestOnce({ exec, log: () => {}, maxAttempts: 1 });
  assert.equal(result.outcome, "exhausted");
});

test("approveLatestOnce reports no-pending when the queue is empty", () => {
  const exec = (args) => {
    if (args.includes("--latest"))
      return { code: 1, stdout: JSON.stringify({}), stderr: "" };
    throw new Error("approve must not run when nothing is pending");
  };
  const result = approveLatestOnce({ exec, log: () => {}, maxAttempts: 6 });
  assert.equal(result.outcome, "no-pending");
});

test("approveLatestOnce stops early when Pinchy has already connected", () => {
  let latestCalls = 0;
  const exec = (args) => {
    if (args.includes("--latest")) {
      latestCalls += 1;
      return {
        code: 1,
        stdout: JSON.stringify({ selected: { requestId: "req-1" } }),
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "unknown requestId" };
  };
  const result = approveLatestOnce({
    exec,
    log: () => {},
    isDone: () => true,
    maxAttempts: 6,
  });
  assert.equal(result.outcome, "done");
  assert.equal(latestCalls, 0);
});
