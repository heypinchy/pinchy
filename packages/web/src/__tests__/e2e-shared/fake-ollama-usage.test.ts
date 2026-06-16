// Unit coverage for the fake-ollama server's token-usage emission.
//
// The usage-tracking Tier-2 E2E spec (e2e/integration/usage-tracking.spec.ts)
// drives real traffic through OpenClaw and asserts the numbers that land in
// usage_records. For OpenClaw to populate its per-session token counters, the
// fake provider must report a usage block — real Ollama/OpenAI providers do,
// and OpenClaw reads it. This test pins that contract in-process (no Docker)
// so a regression in the fake server surfaces fast, before the slow E2E run.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  handleRequest,
  FAKE_OLLAMA_FILES_LS_TOOL_TRIGGER,
  FAKE_OLLAMA_SLOW_STREAM_TRIGGER,
} from "../../../e2e/shared/fake-ollama/fake-ollama-server";

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  delete process.env.FAKE_OLLAMA_PROMPT_TOKENS;
  delete process.env.FAKE_OLLAMA_COMPLETION_TOKENS;
  server = http.createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

async function postChat(path: string, body: unknown): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.text();
}

/** Pull the usage object out of whichever OpenAI SSE chunk carries it. */
function sseUsage(raw: string): Record<string, number> | undefined {
  return raw
    .split("\n\n")
    .map((line) => line.replace(/^data: /, "").trim())
    .filter((p) => p && p !== "[DONE]")
    .map((p) => (JSON.parse(p) as { usage?: Record<string, number> }).usage)
    .find((u) => u !== undefined);
}

describe("fake-ollama usage block — OpenAI /v1/chat/completions (the path OC uses)", () => {
  it("emits a usage block with the configured token counts in the SSE stream", async () => {
    process.env.FAKE_OLLAMA_PROMPT_TOKENS = "42";
    process.env.FAKE_OLLAMA_COMPLETION_TOKENS = "17";

    const raw = await postChat("/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });

    // Collect the usage object from whichever SSE chunk carries it.
    const usage = raw
      .split("\n\n")
      .map((line) => line.replace(/^data: /, "").trim())
      .filter((p) => p && p !== "[DONE]")
      .map((p) => JSON.parse(p) as { usage?: Record<string, number> })
      .map((c) => c.usage)
      .find((u) => u !== undefined);

    expect(usage).toEqual({
      prompt_tokens: 42,
      completion_tokens: 17,
      total_tokens: 59,
    });
  });

  it("reports FLAT per-turn usage regardless of user-message count (#483)", async () => {
    process.env.FAKE_OLLAMA_PROMPT_TOKENS = "42";
    process.env.FAKE_OLLAMA_COMPLETION_TOKENS = "17";

    // A second turn re-sends history (multiple user messages), but with lossless
    // per-turn accounting each turn's usage is recorded as its OWN exact row —
    // there is no cumulative gauge to inflate. The fake therefore reports a flat
    // 42:17 per turn, no userMessageCount scaling (a gauge-era concession the
    // #483 rework removed). The E2E asserts exact per-turn counts.
    const raw = await postChat("/v1/chat/completions", {
      stream: true,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    });

    const usage = raw
      .split("\n\n")
      .map((line) => line.replace(/^data: /, "").trim())
      .filter((p) => p && p !== "[DONE]")
      .map((p) => JSON.parse(p) as { usage?: Record<string, number> })
      .map((c) => c.usage)
      .find((u) => u !== undefined);

    expect(usage).toEqual({
      prompt_tokens: 42,
      completion_tokens: 17,
      total_tokens: 59,
    });
  });

  it("defaults to non-zero token counts when the env vars are unset", async () => {
    const raw = await postChat("/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });

    const usage = sseUsage(raw);

    expect(usage).toBeDefined();
    expect(usage!.prompt_tokens).toBeGreaterThan(0);
    expect(usage!.completion_tokens).toBeGreaterThan(0);
    expect(usage!.total_tokens).toBe(usage!.prompt_tokens + usage!.completion_tokens);
  });

  // Tool-call and slow-stream turns must ALSO report usage. When they don't,
  // OpenClaw self-estimates the real prompt size (~18k for the Smithers
  // bootstrap) into the trajectory, which the per-turn recorder stores as a
  // ~18k usage_records row — the source of the usage-tracking.spec.ts flake
  // (one row != 42 in). Pin every completion shape to the configured usage.
  it("emits the usage block on tool-call turns", async () => {
    process.env.FAKE_OLLAMA_PROMPT_TOKENS = "42";
    process.env.FAKE_OLLAMA_COMPLETION_TOKENS = "17";

    const raw = await postChat("/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: FAKE_OLLAMA_FILES_LS_TOOL_TRIGGER }],
    });

    // Sanity: this really is a tool-call response, not a plain text reply.
    expect(raw).toContain("tool_calls");
    expect(sseUsage(raw)).toEqual({ prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 });
  });

  it("emits the usage block on slow-stream turns", { timeout: 20000 }, async () => {
    process.env.FAKE_OLLAMA_PROMPT_TOKENS = "42";
    process.env.FAKE_OLLAMA_COMPLETION_TOKENS = "17";

    const raw = await postChat("/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: FAKE_OLLAMA_SLOW_STREAM_TRIGGER }],
    });

    expect(sseUsage(raw)).toEqual({ prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 });
  });
});

describe("fake-ollama usage block — Ollama-native /api/chat", () => {
  it("reports prompt_eval_count / eval_count on the final NDJSON chunk", async () => {
    process.env.FAKE_OLLAMA_PROMPT_TOKENS = "100";
    process.env.FAKE_OLLAMA_COMPLETION_TOKENS = "25";

    const raw = await postChat("/api/chat", {
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });

    const finalChunk = raw
      .split("\n")
      .filter((l) => l.trim())
      .map(
        (l) => JSON.parse(l) as { done?: boolean; prompt_eval_count?: number; eval_count?: number }
      )
      .find((c) => c.done === true);

    expect(finalChunk).toBeDefined();
    expect(finalChunk!.prompt_eval_count).toBe(100);
    expect(finalChunk!.eval_count).toBe(25);
  });

  it("reports prompt_eval_count / eval_count on tool-call turns too", async () => {
    process.env.FAKE_OLLAMA_PROMPT_TOKENS = "100";
    process.env.FAKE_OLLAMA_COMPLETION_TOKENS = "25";

    const raw = await postChat("/api/chat", {
      stream: true,
      messages: [{ role: "user", content: FAKE_OLLAMA_FILES_LS_TOOL_TRIGGER }],
    });

    const finalChunk = raw
      .split("\n")
      .filter((l) => l.trim())
      .map(
        (l) =>
          JSON.parse(l) as {
            done?: boolean;
            prompt_eval_count?: number;
            eval_count?: number;
            message?: { tool_calls?: unknown };
          }
      )
      .find((c) => c.done === true);

    expect(finalChunk).toBeDefined();
    expect(finalChunk!.message?.tool_calls, "should be a tool-call response").toBeDefined();
    expect(finalChunk!.prompt_eval_count).toBe(100);
    expect(finalChunk!.eval_count).toBe(25);
  });
});
