/**
 * End-to-end usage tracking verification (Tier 2 from the design doc).
 *
 * This suite is intended to pipe real traffic through a fake LLM → OpenClaw
 * → Pinchy and verify the numbers that land in `usage_records` match the
 * fake server's declared `usage` block. It would be the only layer of the
 * test pyramid that can prove the entire pipeline (chat event path + poller
 * delta path) stays in sync with OpenClaw's cumulative counters.
 *
 * The implementation is tracked in #426. Until then the suite only holds
 * the fake-LLM scaffolding so anyone picking up the work has a starting
 * point; no test cases live here yet — `it.todo` placeholders previously
 * sat here unowned and silently green, which is the kind of soft skip we
 * don't want lying around.
 *
 * Runs only when `INTEGRATION_TEST=1` is set, because it would need:
 *   - a running OpenClaw gateway (container or native)
 *   - a reachable PostgreSQL with Pinchy's migrations applied
 *   - port 9999 free on the host
 */

import { describe, beforeAll, afterAll } from "vitest";
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

  // No test cases yet — see #426 for the implementation plan.
});
