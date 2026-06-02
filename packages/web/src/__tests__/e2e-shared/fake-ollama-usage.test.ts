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
import { handleRequest } from "../../../e2e/shared/fake-ollama/fake-ollama-server";

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

  it("scales both token counts with the user-message count so multi-turn usage grows", async () => {
    process.env.FAKE_OLLAMA_PROMPT_TOKENS = "42";
    process.env.FAKE_OLLAMA_COMPLETION_TOKENS = "17";

    // Two user messages (a second turn re-sending history) → both axes double,
    // preserving the 42:17 ratio. The growth guarantees a positive poller
    // delta even on a session that already carries history.
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
      prompt_tokens: 84,
      completion_tokens: 34,
      total_tokens: 118,
    });
  });

  it("defaults to non-zero token counts when the env vars are unset", async () => {
    const raw = await postChat("/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });

    const usage = raw
      .split("\n\n")
      .map((line) => line.replace(/^data: /, "").trim())
      .filter((p) => p && p !== "[DONE]")
      .map((p) => JSON.parse(p) as { usage?: Record<string, number> })
      .map((c) => c.usage)
      .find((u) => u !== undefined);

    expect(usage).toBeDefined();
    expect(usage!.prompt_tokens).toBeGreaterThan(0);
    expect(usage!.completion_tokens).toBeGreaterThan(0);
    expect(usage!.total_tokens).toBe(usage!.prompt_tokens + usage!.completion_tokens);
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
});
