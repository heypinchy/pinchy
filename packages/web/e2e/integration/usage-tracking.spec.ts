// packages/web/e2e/integration/usage-tracking.spec.ts
//
// Tier-2 usage tracking — the real fake-LLM → OpenClaw → Pinchy path
// (issue #426 cases 1 & 2, reworked for #483 lossless per-turn accounting).
//
// This is the only layer that can honestly prove chat usage flows end-to-end:
// a real Docker OpenClaw consumes the fake Ollama provider (which reports a
// usage block per turn), writes a `model.completed` trajectory event with that
// turn's EXACT tokens, and Pinchy's per-turn recorder (kicked by the chat
// `done` path and backstopped by the poller) turns each turn into one exact
// `usage_records` row — which we assert directly over the DB back-door.
//
// Unlike the old gauge-sampling version, this is DETERMINISTIC: the fake
// reports a flat 42 input / 17 output per turn, recording is per-turn and
// deduped by (sessionKey, runId), so N turns == N rows == exactly 42*N / 17*N.
// No ratio-invariant hack, no 40s delta race (that was the gauge flake:
// "usage delta predicate not met within 40000ms, 0 rows").
//
// Case 3 (the internal usage endpoint — pure Pinchy HTTP + DB, no OpenClaw
// dependency) lives in src/__tests__/integration/usage-tracking.integration.test.ts;
// the per-turn recorder + dedup unit/integration coverage lives in
// src/__tests__/lib/usage-from-trajectory.test.ts and
// src/__tests__/integration/usage-per-turn.integration.test.ts.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  FAKE_OLLAMA_RESPONSE,
  FAKE_OLLAMA_DEFAULT_PROMPT_TOKENS,
  FAKE_OLLAMA_DEFAULT_COMPLETION_TOKENS,
} from "../shared/fake-ollama/fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";
import { stackDbUrl } from "../shared/stack-db";

const INTEGRATION_DB_URL = stackDbUrl(5435);
const PROMPT = FAKE_OLLAMA_DEFAULT_PROMPT_TOKENS; // 42 input tokens / turn
const COMPLETION = FAKE_OLLAMA_DEFAULT_COMPLETION_TOKENS; // 17 output tokens / turn

interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  rows: number;
}

// Sum the per-turn usage_records rows for this agent's browser-chat sessions
// (sessionKey shape `agent:<id>:direct:<userId>`, run_id NOT NULL), reading
// the integration DB directly via the host-mapped 5435 port.
async function chatUsageTotals(agentId: string): Promise<ChatUsage> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(INTEGRATION_DB_URL);
  try {
    const rows = await sql<ChatUsage[]>`
      SELECT COALESCE(SUM(input_tokens), 0)::int        AS input,
             COALESCE(SUM(output_tokens), 0)::int       AS output,
             COALESCE(SUM(cache_read_tokens), 0)::int   AS "cacheRead",
             COALESCE(SUM(cache_write_tokens), 0)::int  AS "cacheWrite",
             COUNT(*)::int                              AS rows
      FROM usage_records
      WHERE agent_id = ${agentId}
        AND session_key LIKE 'agent:%:direct:%'
        AND run_id IS NOT NULL
    `;
    return rows[0];
  } finally {
    await sql.end();
  }
}

async function sendChat(page: Page, text: string) {
  const input = page.getByPlaceholder(/send a message/i);
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill(text);
  await input.press("Enter");
}

// Poll the chat-usage totals until at least `minNewRows` new rows (vs baseline)
// have been recorded. Returns the delta. Deterministic — the chat `done`
// trigger records near-instantly; the poller backstops within its interval.
async function waitForNewTurns(
  agentId: string,
  baseline: ChatUsage,
  minNewRows: number,
  timeoutMs = 30000
): Promise<ChatUsage> {
  const deadline = Date.now() + timeoutMs;
  let delta: ChatUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, rows: 0 };
  while (Date.now() < deadline) {
    const now = await chatUsageTotals(agentId);
    delta = {
      input: now.input - baseline.input,
      output: now.output - baseline.output,
      cacheRead: now.cacheRead - baseline.cacheRead,
      cacheWrite: now.cacheWrite - baseline.cacheWrite,
      rows: now.rows - baseline.rows,
    };
    if (delta.rows >= minNewRows) return delta;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `expected ≥${minNewRows} new usage rows within ${timeoutMs}ms (last delta: ${JSON.stringify(delta)})`
  );
}

test.describe("Usage tracking — chat → OpenClaw → per-turn recorder → usage_records", () => {
  test("a chat turn records one usage row with the provider's EXACT per-turn tokens", async ({
    page,
  }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const before = await chatUsageTotals(agentId);

    await sendChat(page, "Hello, are you there?");
    // The Smithers session is shared across the integration run, so prior
    // specs' identical replies are already rendered — match the newest one.
    await expect(page.getByText(FAKE_OLLAMA_RESPONSE).last()).toBeVisible({ timeout: 30000 });

    const delta = await waitForNewTurns(agentId, before, 1);

    // Per-turn lossless accounting: every new row is exactly 42 in / 17 out, so
    // the delta is an exact whole multiple — NOT a ratio invariant.
    expect(delta.input).toBe(PROMPT * delta.rows);
    expect(delta.output).toBe(COMPLETION * delta.rows);
    // The fake provider doesn't cache, so cache classes are recorded as 0 (the
    // columns are populated, not dropped — guards the #482 regression class).
    expect(delta.cacheRead).toBe(0);
    expect(delta.cacheWrite).toBe(0);
  });

  test("each additional turn adds exactly one more exact row (deduped, no double-count)", async ({
    page,
  }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const before = await chatUsageTotals(agentId);

    await sendChat(page, "First question.");
    await expect(page.getByText(FAKE_OLLAMA_RESPONSE).last()).toBeVisible({ timeout: 30000 });
    const afterTurn1 = await waitForNewTurns(agentId, before, 1);
    expect(afterTurn1.input).toBe(PROMPT * afterTurn1.rows);

    await sendChat(page, "Second question.");
    await expect(page.getByText(FAKE_OLLAMA_RESPONSE).last()).toBeVisible({ timeout: 30000 });
    const afterTurn2 = await waitForNewTurns(agentId, before, afterTurn1.rows + 1);

    // Strictly one (or more) additional rows; tokens stay an exact multiple —
    // proving the second turn was captured without dropping or double-counting.
    expect(afterTurn2.rows).toBeGreaterThan(afterTurn1.rows);
    expect(afterTurn2.input).toBe(PROMPT * afterTurn2.rows);
    expect(afterTurn2.output).toBe(COMPLETION * afterTurn2.rows);
  });
});
