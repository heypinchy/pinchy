// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { handleRequest } from "../../../e2e/shared/fake-ollama/fake-ollama-server";

// Regression guard for the OpenClaw 2026.5.28 budget-triggered compaction
// overflow that turned the "Integration Tests (OpenClaw + Fake Ollama)" suite
// red when bumping the runtime from 2026.5.20.
//
// Chain: Pinchy reads each Ollama model's real context window from /api/show
// `model_info.<arch>.context_length` (provider-models.ts extractOllamaContextLength)
// and emits it as the model's `contextWindow` into openclaw.json. When the
// fake server omits `model_info`, build.ts falls back to
// OLLAMA_LOCAL_DEFAULT_CONTEXT_WINDOW (32_768). The Smithers integration
// session accumulates ~32k tokens across the dispatch-probe suite; once it
// crosses a 32k window, OpenClaw 2026.5.28's cli_budget / overflow compaction
// fires, the fake LLM cannot produce a real summary, and the agent run fails
// with UNAVAILABLE — so the tool never dispatches and the audit assertion
// times out. Real llama3.2 carries a 131072-token window, so advertising it
// keeps the context window from ever being the bottleneck in these short
// single-turn probes.
describe("fake-ollama /api/show advertises a realistic context window", () => {
  let server: http.Server;
  let baseUrl: string;

  // Bind an ephemeral port (0) and run handleRequest directly, exactly like the
  // sibling fake-ollama unit tests (fake-ollama-usage, fake-ollama-liveness).
  // This in-process test only needs to exercise the /api/show branch, so it must
  // NOT depend on the shared fixed FAKE_OLLAMA_PORT (11435) the way the old
  // startFakeOllama() singleton did. Under the parallel `pnpm test` run any
  // concurrent holder of 11435 (a sibling test run, a leftover fake-ollama
  // process, a local dev stack) turned a clean assertion into an EADDRINUSE that
  // — because startFakeOllama() registers no `error` handler — hung beforeAll for
  // the full hook timeout and surfaced as an unhandled error, failing the file.
  // An OS-assigned ephemeral port cannot collide, so the test is deterministic.
  beforeAll(async () => {
    server = http.createServer(handleRequest);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it("reports a real llama context_length so OpenClaw never triggers overflow compaction during probe tests", async () => {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "llama3.2" }),
    });
    expect(res.ok).toBe(true);

    const data = (await res.json()) as { model_info?: Record<string, unknown> };
    const contextLengthEntry = Object.entries(data.model_info ?? {}).find(([key]) =>
      key.endsWith(".context_length")
    );

    expect(
      contextLengthEntry,
      "/api/show model_info must expose a *.context_length key"
    ).toBeTruthy();

    const contextLength = contextLengthEntry![1];
    expect(typeof contextLength).toBe("number");
    // 32_768 is build.ts's OLLAMA_LOCAL_DEFAULT_CONTEXT_WINDOW fallback — the
    // value that triggered the 2026.5.28 overflow. Require a real, large
    // window well above it.
    expect(contextLength as number).toBeGreaterThanOrEqual(128_000);
  });
});
