/**
 * End-to-end usage tracking verification (Tier 2 from the design doc).
 *
 * This suite pipes real traffic through a fake LLM → OpenClaw → Pinchy
 * and verifies the numbers that land in `usage_records` match the fake
 * server's declared `usage` block. It's the only layer of our test
 * pyramid that can prove the entire pipeline (chat event path + poller
 * delta path) stays in sync with OpenClaw's cumulative counters.
 *
 * Runs only when `INTEGRATION_TEST=1` is set, because it needs:
 *   - a running OpenClaw gateway (container or native)
 *   - a reachable PostgreSQL with Pinchy's migrations applied
 *   - port 9999 free on the host
 *
 * The skeleton below describes the steps; the full implementation is a
 * follow-up once the poller has been exercised in the dev environment.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import { startFakeLlmServer } from "./fake-llm-server";

const FAKE_LLM_PORT = 9999;
const PROMPT_TOKENS = 42;
const COMPLETION_TOKENS = 17;

describe.skipIf(!process.env.INTEGRATION_TEST)("usage tracking integration", () => {
  let fakeLlm: Server;

  beforeAll(async () => {
    fakeLlm = await startFakeLlmServer({
      port: FAKE_LLM_PORT,
      responseText: "Hello from fake LLM",
      promptTokens: PROMPT_TOKENS,
      completionTokens: COMPLETION_TOKENS,
    });
  });

  afterAll(() => {
    fakeLlm?.close();
  });

  // Full implementation is a follow-up — wired in once the poller has
  // been exercised against a real OpenClaw + DB in the dev environment.
  it.todo("records correct token totals in usage_records after a chat + one poll cycle");

  it.todo("records cumulative totals correctly across multiple chat turns in the same session");

  it.todo("captures tokens added by vision/plugin calls via the internal usage endpoint");
});
