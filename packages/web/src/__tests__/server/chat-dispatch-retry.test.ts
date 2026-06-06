// Focused tests for the chat-dispatch retry wrapper used to mask
// OpenClaw's `config.get` vs `agent` RPC dispatch race (#310 / PR #442
// flake on the Odoo and Telegram dispatch probes — CI runs 26505503327,
// 26511658136; ollama-local setup-wizard flake — PR #448).
//
// The wrapper retries `openclawClient.chat()` with bounded exponential
// backoff while the FIRST chunk is an `unknown agent id` error. These tests
// pin the contract: only that error and only on the first chunk triggers a
// retry; the retry loop is bounded by a wall-clock budget; and a retried
// call is transparent to the caller.

import { describe, it, expect, vi } from "vitest";
import type { ChatChunk, ChatOptions } from "openclaw-node";
import {
  chatWithDispatchRaceRetry,
  DISPATCH_RACE_PATTERN,
  MODEL_DISPATCH_RACE_PATTERN,
} from "@/server/chat-dispatch-retry";

function makeStream(chunks: ChatChunk[]) {
  return async function* () {
    for (const c of chunks) {
      yield c;
    }
  };
}

function raceError(id = "596489fc-45c7-4113-8a82-b5f8d28861d7"): ChatChunk[] {
  return [{ type: "error", text: `invalid agent params: unknown agent id "${id}"`, runId: "r0" }];
}

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

/**
 * Fake clock: `delay(ms)` advances `now` by `ms` synchronously (resolving
 * immediately) so backoff/budget logic is exercised deterministically without
 * real timers.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    delay: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

describe("chatWithDispatchRaceRetry", () => {
  it("yields chunks unchanged when the stream produces no dispatch-race error", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", text: "Hi", runId: "r1" },
      { type: "done", text: "", runId: "r1" },
    ];
    const chat = vi.fn(makeStream(chunks));

    const got = await collect(
      chatWithDispatchRaceRetry("hello", { agentId: "a-1" } as ChatOptions, {
        chat: chat as unknown as (m: string, o?: ChatOptions) => AsyncGenerator<ChatChunk>,
      })
    );

    expect(got).toEqual(chunks);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("retries the transient first-chunk race error until the agent dispatches, swallowing it", async () => {
    const successful: ChatChunk[] = [
      { type: "text", text: "Hello!", runId: "r1" },
      { type: "done", text: "", runId: "r1" },
    ];
    // Three transient failures, then success — proves we retry MORE than once
    // (the old single-retry contract could not survive a multi-second reload).
    const chat = vi
      .fn()
      .mockImplementationOnce(makeStream(raceError()))
      .mockImplementationOnce(makeStream(raceError()))
      .mockImplementationOnce(makeStream(raceError()))
      .mockImplementationOnce(makeStream(successful));

    const clock = fakeClock();
    const onDispatchRaceObserved = vi.fn();

    const got = await collect(
      chatWithDispatchRaceRetry(
        "hello",
        { agentId: "596489fc-45c7-4113-8a82-b5f8d28861d7" } as ChatOptions,
        { chat: chat as never, delay: clock.delay, now: clock.now, onDispatchRaceObserved },
        { baseDelayMs: 500, maxDelayMs: 5000, maxTotalMs: 90000 }
      )
    );

    expect(got).toEqual(successful);
    expect(chat).toHaveBeenCalledTimes(4);
    // Audited ONCE per raced dispatch (not once per retry) so a long storm
    // doesn't flood the audit log.
    expect(onDispatchRaceObserved).toHaveBeenCalledTimes(1);
    expect(onDispatchRaceObserved.mock.calls[0][0].providerError).toMatch(/unknown agent id/i);
  });

  it("uses exponential backoff capped at maxDelayMs", async () => {
    // Fail enough times to exceed the cap, then succeed.
    const chat = vi
      .fn()
      .mockImplementationOnce(makeStream(raceError()))
      .mockImplementationOnce(makeStream(raceError()))
      .mockImplementationOnce(makeStream(raceError()))
      .mockImplementationOnce(makeStream(raceError()))
      .mockImplementationOnce(makeStream([{ type: "done", text: "", runId: "r1" }]));

    const clock = fakeClock();

    await collect(
      chatWithDispatchRaceRetry(
        "hello",
        { agentId: "a" } as ChatOptions,
        { chat: chat as never, delay: clock.delay, now: clock.now },
        { baseDelayMs: 500, maxDelayMs: 2000, maxTotalMs: 90000 }
      )
    );

    // 500, 1000, 2000, 2000 (capped) — exponential then clamped.
    expect(clock.delay.mock.calls.map((c) => c[0])).toEqual([500, 1000, 2000, 2000]);
  });

  it("surfaces the race error once the wall-clock budget is exhausted (bounded, never infinite)", async () => {
    // Always fails — the loop must terminate at the budget and yield the error.
    const chat = vi.fn(makeStream(raceError("a")));
    const clock = fakeClock();

    const got = await collect(
      chatWithDispatchRaceRetry(
        "hello",
        { agentId: "a" } as ChatOptions,
        { chat: chat as never, delay: clock.delay, now: clock.now },
        { baseDelayMs: 500, maxDelayMs: 5000, maxTotalMs: 3000 }
      )
    );

    // The final error IS yielded so the caller surfaces "Smithers couldn't respond".
    expect(got).toHaveLength(1);
    expect(got[0].type).toBe("error");
    expect(DISPATCH_RACE_PATTERN.test(got[0].text)).toBe(true);
    // Never slept past the budget.
    expect(clock.now()).toBeLessThanOrEqual(3000);
  });

  it("does not retry at all when maxTotalMs is 0 (single attempt, surface error)", async () => {
    const chat = vi.fn(makeStream(raceError("a")));
    const clock = fakeClock();

    const got = await collect(
      chatWithDispatchRaceRetry(
        "hello",
        { agentId: "a" } as ChatOptions,
        { chat: chat as never, delay: clock.delay, now: clock.now },
        { maxTotalMs: 0 }
      )
    );

    expect(got).toHaveLength(1);
    expect(got[0].type).toBe("error");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(clock.delay).not.toHaveBeenCalled();
  });

  it("does NOT retry on an error chunk that doesn't match the dispatch-race pattern", async () => {
    const otherError: ChatChunk[] = [
      {
        type: "error",
        text: "FailoverError: provider/model ended with an incomplete terminal response",
        runId: "r-err",
      },
    ];
    const chat = vi.fn(makeStream(otherError));

    const got = await collect(
      chatWithDispatchRaceRetry("hello", { agentId: "a" } as ChatOptions, { chat: chat as never })
    );

    expect(got).toEqual(otherError);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when the FIRST chunk is fine and a later chunk errors with the dispatch pattern", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", text: "partial...", runId: "r1" },
      { type: "error", text: 'unknown agent id "weird"', runId: "r1" },
    ];
    const chat = vi.fn(makeStream(chunks));

    const got = await collect(
      chatWithDispatchRaceRetry("hello", { agentId: "weird" } as ChatOptions, {
        chat: chat as never,
      })
    );

    expect(got).toEqual(chunks);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("passes message and options through to the underlying chat() on every attempt", async () => {
    const chat = vi
      .fn()
      .mockImplementationOnce(makeStream(raceError("x")))
      .mockImplementationOnce(makeStream([{ type: "done", text: "", runId: "r1" }]));

    const opts: ChatOptions = { agentId: "x", sessionKey: "agent:x:direct:u1" };
    const clock = fakeClock();

    await collect(
      chatWithDispatchRaceRetry("hello", opts, {
        chat: chat as never,
        delay: clock.delay,
        now: clock.now,
      })
    );

    expect(chat).toHaveBeenNthCalledWith(1, "hello", opts);
    expect(chat).toHaveBeenNthCalledWith(2, "hello", opts);
  });

  describe("runtime-readiness gate (awaitAgentReady)", () => {
    it("polls runtime readiness instead of blind backoff, re-dispatching as soon as the agent is ready", async () => {
      const successful: ChatChunk[] = [{ type: "done", text: "", runId: "r1" }];
      const chat = vi
        .fn()
        .mockImplementationOnce(makeStream(raceError()))
        .mockImplementationOnce(makeStream(raceError()))
        .mockImplementationOnce(makeStream(successful));

      const clock = fakeClock();
      // The gate confirms readiness each time (the agent is present in the
      // runtime agents.list). It models the deterministic poll: no need for the
      // wrapper's blind backoff.
      const awaitAgentReady = vi.fn(async () => true);

      const got = await collect(
        chatWithDispatchRaceRetry(
          "hello",
          { agentId: "a" } as ChatOptions,
          { chat: chat as never, delay: clock.delay, now: clock.now, awaitAgentReady },
          { baseDelayMs: 500, maxDelayMs: 5000, maxTotalMs: 90000 }
        )
      );

      expect(got).toEqual(successful);
      expect(chat).toHaveBeenCalledTimes(3);
      // Gate consulted once per race; blind backoff NOT used.
      expect(awaitAgentReady).toHaveBeenCalledTimes(2);
      expect(clock.delay).not.toHaveBeenCalled();
    });

    it("passes the REMAINING wall-clock budget to the readiness gate", async () => {
      const chat = vi
        .fn()
        .mockImplementationOnce(makeStream(raceError()))
        .mockImplementationOnce(makeStream([{ type: "done", text: "", runId: "r1" }]));

      const clock = fakeClock();
      const awaitAgentReady = vi.fn(async () => true);

      await collect(
        chatWithDispatchRaceRetry(
          "hello",
          { agentId: "a" } as ChatOptions,
          { chat: chat as never, delay: clock.delay, now: clock.now, awaitAgentReady },
          { maxTotalMs: 90000 }
        )
      );

      // First (and only) race fires at t=0, so the full budget is available.
      expect(awaitAgentReady).toHaveBeenCalledWith(90000);
    });

    it("falls back to capped blind backoff when the gate reports not-ready (unobservable / timeout)", async () => {
      const chat = vi
        .fn()
        .mockImplementationOnce(makeStream(raceError()))
        .mockImplementationOnce(makeStream([{ type: "done", text: "", runId: "r1" }]));

      const clock = fakeClock();
      // Gate cannot confirm readiness (e.g. older Gateway without agents.list →
      // helper returns false immediately). Wrapper must still make progress via
      // its blind backoff so the bounded retry is preserved.
      const awaitAgentReady = vi.fn(async () => false);

      await collect(
        chatWithDispatchRaceRetry(
          "hello",
          { agentId: "a" } as ChatOptions,
          { chat: chat as never, delay: clock.delay, now: clock.now, awaitAgentReady },
          { baseDelayMs: 500, maxDelayMs: 5000, maxTotalMs: 90000 }
        )
      );

      expect(awaitAgentReady).toHaveBeenCalledTimes(1);
      // Blind backoff applied exactly once (the first attempt's 500 ms) before
      // the successful re-dispatch.
      expect(clock.delay.mock.calls.map((c) => c[0])).toEqual([500]);
    });

    it("stays bounded by the budget even when the gate keeps consuming time without readiness", async () => {
      const chat = vi.fn(makeStream(raceError("a")));
      const clock = fakeClock();
      // Gate burns the whole window it is given and never confirms readiness,
      // mirroring an agent that genuinely never applies (a Pinchy-side bad id).
      const awaitAgentReady = vi.fn(async (budgetMs: number) => {
        clock.delay(budgetMs); // advance the clock as a real poll would
        return false;
      });

      const got = await collect(
        chatWithDispatchRaceRetry(
          "hello",
          { agentId: "a" } as ChatOptions,
          { chat: chat as never, delay: clock.delay, now: clock.now, awaitAgentReady },
          { baseDelayMs: 500, maxDelayMs: 5000, maxTotalMs: 3000 }
        )
      );

      // Terminates and surfaces the race error rather than looping forever.
      expect(got).toHaveLength(1);
      expect(got[0].type).toBe("error");
      expect(DISPATCH_RACE_PATTERN.test(got[0].text)).toBe(true);
      expect(clock.now()).toBeLessThanOrEqual(3000);
    });
  });

  // The cold-start config-apply storm can land the AGENT (`agents.list`) before
  // its model's PROVIDER (`models`): OpenClaw accepts the dispatch (agent id is
  // known) but the run immediately errors `FailoverError: Unknown model:
  // <provider>/<model>` because the provider block isn't applied yet. Observed
  // directly on the 2026.6.1 setup-wizard Google spec: agent applied 07:18:04,
  // `models` applied 07:19:06, first chat dispatched 07:18:26 → "Unknown model".
  // This is the SAME transient race as "unknown agent id", one config layer up,
  // so the wrapper must retry it too — but via bounded backoff, NOT the
  // agents.list gate (the agent is already present, so the gate would return
  // true and hot-loop).
  describe("model dispatch race (cold-start provider/models apply lag)", () => {
    function modelRaceError(ref = "google/gemini-2.5-pro"): ChatChunk[] {
      return [{ type: "error", text: `Unknown model: ${ref}`, runId: "r0" }];
    }

    it("retries the transient first-chunk 'Unknown model' race until the provider applies, swallowing it", async () => {
      const successful: ChatChunk[] = [
        { type: "text", text: "Sure, happy to help!", runId: "r1" },
        { type: "done", text: "", runId: "r1" },
      ];
      const chat = vi
        .fn()
        .mockImplementationOnce(makeStream(modelRaceError()))
        .mockImplementationOnce(makeStream(modelRaceError()))
        .mockImplementationOnce(makeStream(modelRaceError()))
        .mockImplementationOnce(makeStream(successful));

      const clock = fakeClock();
      const onDispatchRaceObserved = vi.fn();

      const got = await collect(
        chatWithDispatchRaceRetry(
          "hello",
          { agentId: "596489fc-45c7-4113-8a82-b5f8d28861d7" } as ChatOptions,
          { chat: chat as never, delay: clock.delay, now: clock.now, onDispatchRaceObserved },
          { baseDelayMs: 500, maxDelayMs: 5000, maxTotalMs: 150000 }
        )
      );

      expect(got).toEqual(successful);
      expect(chat).toHaveBeenCalledTimes(4);
      // Bounded backoff governs the model race (no agents.list gate available
      // for provider/models readiness): 500, 1000, 2000.
      expect(clock.delay.mock.calls.map((c) => c[0])).toEqual([500, 1000, 2000]);
      // Audited ONCE per raced dispatch, with the model-error text.
      expect(onDispatchRaceObserved).toHaveBeenCalledTimes(1);
      expect(onDispatchRaceObserved.mock.calls[0][0].providerError).toMatch(/unknown model/i);
    });

    it("retries when the model error follows the userMessagePersisted ack (the real OC chunk order)", async () => {
      // Client-originated messages carry a clientMessageId, so OpenClaw ACKs the
      // accepted dispatch with a leading `userMessagePersisted` chunk and only
      // THEN fails resolving the model → the race error is the SECOND chunk. The
      // ack must pass through (so the browser's ack-timeout clears) AND the
      // error must still trigger a retry.
      const ack: ChatChunk = {
        type: "userMessagePersisted",
        text: "",
        runId: "r0",
      } as unknown as ChatChunk;
      const failedAttempt: ChatChunk[] = [ack, ...modelRaceError()];
      const successfulAttempt: ChatChunk[] = [
        ack,
        { type: "text", text: "Sure, happy to help!", runId: "r1" },
        { type: "done", text: "", runId: "r1" },
      ];
      const chat = vi
        .fn()
        .mockImplementationOnce(makeStream(failedAttempt))
        .mockImplementationOnce(makeStream(successfulAttempt));

      const clock = fakeClock();

      const got = await collect(
        chatWithDispatchRaceRetry(
          "hello",
          { agentId: "a", clientMessageId: "c-1" } as ChatOptions,
          { chat: chat as never, delay: clock.delay, now: clock.now },
          { baseDelayMs: 500, maxDelayMs: 5000, maxTotalMs: 150000 }
        )
      );

      // The failed attempt's ack passed through (ack-timeout safety); the model
      // error was swallowed and retried; the successful attempt streamed.
      expect(chat).toHaveBeenCalledTimes(2);
      expect(got.map((c) => c.type)).toEqual([
        "userMessagePersisted",
        "userMessagePersisted",
        "text",
        "done",
      ]);
      // The "Unknown model" error never reached the caller.
      expect(got.some((c) => c.type === "error")).toBe(false);
    });

    it("uses bounded backoff for the model race and does NOT consult the agents.list gate", async () => {
      // The agent IS already present in the runtime (that's why OC accepted the
      // dispatch before failing on the model), so gating on agents.list would
      // return true and immediate-continue into a hot loop. The model race must
      // therefore bypass the gate and rely on backoff.
      const chat = vi
        .fn()
        .mockImplementationOnce(makeStream(modelRaceError()))
        .mockImplementationOnce(makeStream([{ type: "done", text: "", runId: "r1" }]));

      const clock = fakeClock();
      const awaitAgentReady = vi.fn(async () => true);

      await collect(
        chatWithDispatchRaceRetry(
          "hello",
          { agentId: "a" } as ChatOptions,
          { chat: chat as never, delay: clock.delay, now: clock.now, awaitAgentReady },
          { baseDelayMs: 500, maxDelayMs: 5000, maxTotalMs: 150000 }
        )
      );

      // Gate NOT consulted for the model race; backoff used instead.
      expect(awaitAgentReady).not.toHaveBeenCalled();
      expect(clock.delay.mock.calls.map((c) => c[0])).toEqual([500]);
    });

    it("surfaces the 'Unknown model' error once the wall-clock budget is exhausted (bounded)", async () => {
      const chat = vi.fn(makeStream(modelRaceError()));
      const clock = fakeClock();

      const got = await collect(
        chatWithDispatchRaceRetry(
          "hello",
          { agentId: "a" } as ChatOptions,
          { chat: chat as never, delay: clock.delay, now: clock.now },
          { baseDelayMs: 500, maxDelayMs: 5000, maxTotalMs: 3000 }
        )
      );

      expect(got).toHaveLength(1);
      expect(got[0].type).toBe("error");
      expect(MODEL_DISPATCH_RACE_PATTERN.test(got[0].text)).toBe(true);
      expect(clock.now()).toBeLessThanOrEqual(3000);
    });
  });

  it("MODEL_DISPATCH_RACE_PATTERN matches the OC FailoverError shape, not unrelated model errors", () => {
    expect(MODEL_DISPATCH_RACE_PATTERN.test("Unknown model: google/gemini-2.5-pro")).toBe(true);
    expect(MODEL_DISPATCH_RACE_PATTERN.test("FailoverError: Unknown model: openai/gpt-5.5")).toBe(
      true
    );
    // A streaming/terminal failure that merely mentions "model" must NOT match.
    expect(
      MODEL_DISPATCH_RACE_PATTERN.test(
        "FailoverError: provider/model ended with an incomplete terminal response"
      )
    ).toBe(false);
    expect(MODEL_DISPATCH_RACE_PATTERN.test('unknown agent id "abc"')).toBe(false);
  });

  it("DISPATCH_RACE_PATTERN matches the exact OC 2026.5.x error message shape", () => {
    expect(DISPATCH_RACE_PATTERN.test('invalid agent params: unknown agent id "abc-123"')).toBe(
      true
    );
    expect(DISPATCH_RACE_PATTERN.test("Unknown Agent ID provided")).toBe(true);
    expect(DISPATCH_RACE_PATTERN.test("unrelated transient: rate_limit")).toBe(false);
    expect(DISPATCH_RACE_PATTERN.test("agent unknown but different shape")).toBe(false);
  });
});
