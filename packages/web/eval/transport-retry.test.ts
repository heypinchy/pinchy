/**
 * Riding out an offline stretch instead of booking it as a result (#869).
 *
 * The laptop this sweep runs on travels, so losing the uplink for a few
 * minutes is an operating condition, not an incident. The existing `withRetry`
 * in the sweep covers only per-model setup (pin + dispatchable); the run
 * itself — dispatch, audit read, and the Ollama Cloud judge call — had no
 * retry at all. One tunnel cost 15 of 48 runs, and two model cells came out
 * unreadable: nothing in the scorecard could say whether they scored zero or
 * never got asked.
 *
 * Two properties carry the whole thing, and both are the point rather than
 * polish:
 *
 *   - It retries ONLY transport faults. A wrong answer retried four times is
 *     four wrong answers filed under a note blaming the network.
 *   - The delays grow. A fixed 8s four times over rides out a hiccup and
 *     nothing else; the gap between a hiccup and a tunnel is exactly where
 *     this sweep kept dying.
 */

import { describe, expect, it, vi } from "vitest";

import { withTransportRetry } from "./transport-retry";

function fetchFailure(): TypeError {
  const err = new TypeError("fetch failed");
  (err as TypeError & { cause?: unknown }).cause = Object.assign(
    new Error("getaddrinfo EAI_AGAIN ollama.com"),
    { code: "EAI_AGAIN" }
  );
  return err;
}

/** Collects the delays instead of waiting them out. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

describe("withTransportRetry", () => {
  it("returns the value without sleeping when the first attempt works", async () => {
    const { sleep, slept } = recordingSleep();
    const fn = vi.fn().mockResolvedValue("answer");

    await expect(withTransportRetry(fn, { what: "dispatch", sleep })).resolves.toBe("answer");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("retries a dropped uplink and returns the later success", async () => {
    const { sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValueOnce(fetchFailure()).mockResolvedValue("answer");

    await expect(withTransportRetry(fn, { what: "judge", sleep })).resolves.toBe("answer");

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a failure that is the measurement", async () => {
    // The load-bearing half. A grader disagreement, a missing assistant
    // message, a schema violation — all of them are the result, and retrying
    // them buys nothing while making a real defect look intermittent.
    const { sleep, slept } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new Error("no assistant text found in the trajectory"));

    await expect(withTransportRetry(fn, { what: "dispatch", sleep })).rejects.toThrow(
      "no assistant text"
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("waits longer after each failure, so a tunnel is survivable and not just a hiccup", async () => {
    const { sleep, slept } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(fetchFailure());

    await expect(withTransportRetry(fn, { what: "judge", sleep })).rejects.toThrow("fetch failed");

    // Strictly growing, and enough total budget to cross a real dead zone
    // rather than four attempts inside the same bad minute.
    expect(slept.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < slept.length; i++) expect(slept[i]).toBeGreaterThan(slept[i - 1]);
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("rethrows the final failure so the caller still records an invalid trial", async () => {
    const { sleep } = recordingSleep();
    const err = fetchFailure();
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withTransportRetry(fn, { what: "judge", sleep })).rejects.toBe(err);
  });

  it("reports each retry with the endpoint the failure names", async () => {
    // A sweep runs unattended for half an hour. If it silently waits out five
    // minutes, the operator cannot tell it from a hang — and the endpoint is
    // what says whether to restart the stack or find better wifi.
    const { sleep } = recordingSleep();
    const log = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(fetchFailure()).mockResolvedValue("ok");

    await withTransportRetry(fn, { what: "judge call", sleep, log });

    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0] as [string];
    expect(line).toContain("judge call");
    expect(line).toContain("ollama.com");
    expect(line).toContain("EAI_AGAIN");
  });

  it("gives each attempt a fresh try, passing the attempt number through", async () => {
    // The KB sweep mints a new chatId per attempt: a half-dispatched chat
    // must not be resumed, or the retry grades a conversation the model
    // already half-answered before the network dropped.
    const { sleep } = recordingSleep();
    const seen: number[] = [];
    const fn = vi.fn().mockImplementation((attempt: number) => {
      seen.push(attempt);
      return seen.length < 3 ? Promise.reject(fetchFailure()) : Promise.resolve("ok");
    });

    await withTransportRetry(fn, { what: "dispatch", sleep });

    expect(seen).toEqual([1, 2, 3]);
  });
});
