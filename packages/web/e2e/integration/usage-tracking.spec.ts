// packages/web/e2e/integration/usage-tracking.spec.ts
//
// Tier-2 usage tracking — the real fake-LLM → OpenClaw → Pinchy path
// (issue #426, cases 1 & 2).
//
// This is the only layer that can honestly prove the poller delta path stays
// in sync with OpenClaw's per-session token counters: `openclaw-node@0.11.0`
// types `sessions.list()` as `Promise<Record<string, unknown>>`, so a faked
// client in a unit test would only validate Pinchy's own assumption about the
// wire format against itself. Here a real Docker OpenClaw consumes the fake
// Ollama provider (which now reports a usage block) and the running Pinchy
// poller turns its cumulative counters into `usage_records` rows, which we
// assert against directly over the DB back-door.
//
// Case 3 (the internal usage endpoint — pure Pinchy HTTP + DB, no OpenClaw
// dependency) lives in src/__tests__/integration/usage-tracking.integration.test.ts
// where it runs in the lighter `pnpm test:db` CI job.
//
// The poll interval is forced to 10s for this stack via
// PINCHY_USAGE_POLL_INTERVAL_MS in docker-compose.integration.yml, so deltas
// land within the test's 40s delta-wait window instead of after the 60s
// production default. (It's kept at 10s rather than lower to minimise extra
// sessions.list() load on the shared OpenClaw — see the compose comment.)
//
// Why a ratio invariant instead of exact token counts: the Smithers chat
// session (`agent:<id>:direct:<adminUserId>`) is shared across the whole
// integration run, so its counters already carry history from earlier specs,
// and OpenClaw's exact accumulate-vs-replace semantics for cumulative counters
// are an implementation detail. The fake reports a fixed 42:17 input:output
// ratio (scaled per turn), so the robust, semantics-independent assertion is
// that every recorded delta preserves that ratio and that multi-turn traffic
// strictly grows the recorded total. That proves the declared provider usage
// flows end-to-end into usage_records without depending on session freshness.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  FAKE_OLLAMA_RESPONSE,
  FAKE_OLLAMA_DEFAULT_PROMPT_TOKENS,
  FAKE_OLLAMA_DEFAULT_COMPLETION_TOKENS,
} from "../shared/fake-ollama/fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

const INTEGRATION_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5435/pinchy";
const PROMPT = FAKE_OLLAMA_DEFAULT_PROMPT_TOKENS; // 42
const COMPLETION = FAKE_OLLAMA_DEFAULT_COMPLETION_TOKENS; // 17

interface ChatUsage {
  input: number;
  output: number;
  rows: number;
}

// Sum the usage_records rows for this agent's browser-chat sessions
// (sessionKey shape `agent:<id>:direct:<userId>`), excluding system/plugin
// rows. Reads the integration DB directly via the host-mapped 5435 port.
async function chatUsageTotals(agentId: string): Promise<ChatUsage> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(INTEGRATION_DB_URL);
  try {
    const rows = await sql<{ input: number; output: number; rows: number }[]>`
      SELECT COALESCE(SUM(input_tokens), 0)::int  AS input,
             COALESCE(SUM(output_tokens), 0)::int AS output,
             COUNT(*)::int                        AS rows
      FROM usage_records
      WHERE agent_id = ${agentId}
        AND session_key LIKE 'agent:%:direct:%'
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

// Poll the chat-usage totals until `predicate(delta)` holds, where delta is
// measured against `baseline`. Returns the satisfying delta.
async function waitForUsageDelta(
  agentId: string,
  baseline: ChatUsage,
  predicate: (delta: { input: number; output: number; rows: number }) => boolean,
  timeoutMs = 40000
): Promise<{ input: number; output: number; rows: number }> {
  const deadline = Date.now() + timeoutMs;
  let delta = { input: 0, output: 0, rows: 0 };
  while (Date.now() < deadline) {
    const now = await chatUsageTotals(agentId);
    delta = {
      input: now.input - baseline.input,
      output: now.output - baseline.output,
      rows: now.rows - baseline.rows,
    };
    if (predicate(delta)) return delta;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `usage delta predicate not met within ${timeoutMs}ms (last delta: ${JSON.stringify(delta)})`
  );
}

test.describe("Usage tracking — chat → OpenClaw → poller → usage_records", () => {
  test("a chat turn records token usage whose input:output ratio matches the provider", async ({
    page,
  }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const before = await chatUsageTotals(agentId);

    await sendChat(page, "Hello, are you there?");
    // The Smithers session is shared across the integration run, so prior
    // specs' identical replies are already rendered — match the newest one to
    // avoid a strict-mode multiple-match.
    await expect(page.getByText(FAKE_OLLAMA_RESPONSE).last()).toBeVisible({ timeout: 30000 });

    // The poller (every 10s) records the delta from this turn. A turn always
    // produces a strictly positive delta on both axes (the fake scales both
    // counts by the turn's user-message count).
    const delta = await waitForUsageDelta(agentId, before, (d) => d.input > 0 && d.output > 0);

    // The recorded numbers came straight from the provider's usage block via
    // OpenClaw's session counters: their input:output ratio must equal the
    // fake's declared 42:17, regardless of how many turns the delta merged or
    // whether OpenClaw accumulates or replaces its counters.
    expect(delta.input * COMPLETION).toBe(delta.output * PROMPT);
    // The delta is a whole number of turns' worth of the declared base.
    expect(delta.input % PROMPT).toBe(0);
    expect(delta.output % COMPLETION).toBe(0);
  });

  test("multiple turns in the same session accumulate a growing recorded total", async ({
    page,
  }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const before = await chatUsageTotals(agentId);

    // Turn 1
    await sendChat(page, "First question.");
    await expect(page.getByText(FAKE_OLLAMA_RESPONSE).last()).toBeVisible({ timeout: 30000 });
    const afterTurn1 = await waitForUsageDelta(agentId, before, (d) => d.input > 0 && d.output > 0);

    // Turn 2 — same session, so OpenClaw's cumulative counter grows and the
    // poller records a further delta. The total recorded for this session must
    // strictly exceed the single-turn total, proving the multi-turn delta path
    // captures additional turns without dropping or double-counting them.
    await sendChat(page, "Second question.");
    const afterTurn2 = await waitForUsageDelta(
      agentId,
      before,
      (d) => d.input > afterTurn1.input && d.output > afterTurn1.output,
      40000
    );

    expect(afterTurn2.input).toBeGreaterThan(afterTurn1.input);
    expect(afterTurn2.output).toBeGreaterThan(afterTurn1.output);
    // The cumulative delta still preserves the provider's declared ratio.
    expect(afterTurn2.input * COMPLETION).toBe(afterTurn2.output * PROMPT);
  });
});
