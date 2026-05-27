// Focused tests for the chat-dispatch retry wrapper used to mask
// OpenClaw's `config.get` vs `agent` RPC dispatch race (#310 / PR #442
// flake on the Odoo and Telegram dispatch probes — CI runs 26505503327,
// 26511658136).
//
// The wrapper retries `openclawClient.chat()` exactly once when the
// FIRST chunk is an `unknown agent id` error. These tests pin the
// contract: nothing else triggers a retry, and a retried call is
// transparent to the caller.

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

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
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

  it("retries exactly once and swallows the transient first-chunk error when it matches the dispatch-race pattern", async () => {
    const transient: ChatChunk[] = [
      {
        type: "error",
        text: 'invalid agent params: unknown agent id "596489fc-45c7-4113-8a82-b5f8d28861d7"',
        runId: "r0",
      },
    ];
    const successful: ChatChunk[] = [
      { type: "text", text: "Hello!", runId: "r1" },
      { type: "done", text: "", runId: "r1" },
    ];

    const chat = vi
      .fn()
      .mockImplementationOnce(makeStream(transient))
      .mockImplementationOnce(makeStream(successful));

    const delay = vi.fn().mockResolvedValue(undefined);
    const onDispatchRaceObserved = vi.fn();

    const got = await collect(
      chatWithDispatchRaceRetry(
        "hello",
        { agentId: "596489fc-45c7-4113-8a82-b5f8d28861d7" } as ChatOptions,
        { chat: chat as never, delay, onDispatchRaceObserved },
        500
      )
    );

    // The transient error must NOT have been yielded to the consumer.
    expect(got).toEqual(successful);
    // Exactly two chat() calls: original + one retry.
    expect(chat).toHaveBeenCalledTimes(2);
    // Delay invoked with the configured value.
    expect(delay).toHaveBeenCalledWith(500);
    // Audit observation fired exactly once with the transient error text.
    expect(onDispatchRaceObserved).toHaveBeenCalledTimes(1);
    expect(onDispatchRaceObserved.mock.calls[0][0].providerError).toMatch(/unknown agent id/i);
    expect(onDispatchRaceObserved.mock.calls[0][0].attempt).toBe(0);
  });

  it("forwards the error and does NOT retry when the second attempt also hits the dispatch-race error", async () => {
    const transient = (id: string): ChatChunk[] => [
      {
        type: "error",
        text: `invalid agent params: unknown agent id "${id}"`,
        runId: "r-err",
      },
    ];

    const chat = vi
      .fn()
      .mockImplementationOnce(makeStream(transient("a")))
      .mockImplementationOnce(makeStream(transient("a")));

    const got = await collect(
      chatWithDispatchRaceRetry(
        "hello",
        { agentId: "a" } as ChatOptions,
        { chat: chat as never, delay: vi.fn().mockResolvedValue(undefined) },
        0
      )
    );

    // The second attempt's error IS yielded so the caller can surface it.
    expect(got).toHaveLength(1);
    expect(got[0].type).toBe("error");
    expect(chat).toHaveBeenCalledTimes(2);
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
      chatWithDispatchRaceRetry(
        "hello",
        { agentId: "a" } as ChatOptions,
        { chat: chat as never },
        0
      )
    );

    expect(got).toEqual(otherError);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when the FIRST chunk is fine and a later chunk errors with the dispatch pattern", async () => {
    // This is a synthetic case to lock the "only first-chunk triggers
    // retry" contract: a mid-stream `unknown agent id` would indicate
    // something genuinely broken (OC re-running agent lookup mid-turn?)
    // rather than the startup race we're targeting.
    const chunks: ChatChunk[] = [
      { type: "text", text: "partial...", runId: "r1" },
      {
        type: "error",
        text: 'unknown agent id "weird"',
        runId: "r1",
      },
    ];
    const chat = vi.fn(makeStream(chunks));

    const got = await collect(
      chatWithDispatchRaceRetry(
        "hello",
        { agentId: "weird" } as ChatOptions,
        { chat: chat as never, delay: vi.fn().mockResolvedValue(undefined) },
        0
      )
    );

    expect(got).toEqual(chunks);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("passes message and options through to the underlying chat() on both attempts", async () => {
    const transient: ChatChunk[] = [{ type: "error", text: 'unknown agent id "x"', runId: "r0" }];
    const ok: ChatChunk[] = [{ type: "done", text: "", runId: "r1" }];
    const chat = vi
      .fn()
      .mockImplementationOnce(makeStream(transient))
      .mockImplementationOnce(makeStream(ok));

    const opts: ChatOptions = {
      agentId: "x",
      sessionKey: "agent:x:direct:u1",
    };

    await collect(
      chatWithDispatchRaceRetry("hello", opts, { chat: chat as never, delay: vi.fn() }, 0)
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
