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
import { chatWithDispatchRaceRetry, DISPATCH_RACE_PATTERN } from "@/server/chat-dispatch-retry";

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

  it("DISPATCH_RACE_PATTERN matches the exact OC 2026.5.x error message shape", () => {
    expect(DISPATCH_RACE_PATTERN.test('invalid agent params: unknown agent id "abc-123"')).toBe(
      true
    );
    expect(DISPATCH_RACE_PATTERN.test("Unknown Agent ID provided")).toBe(true);
    expect(DISPATCH_RACE_PATTERN.test("unrelated transient: rate_limit")).toBe(false);
    expect(DISPATCH_RACE_PATTERN.test("agent unknown but different shape")).toBe(false);
  });
});
