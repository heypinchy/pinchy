/**
 * Blocking budgets stop Telegram turns (#36, runtime gate).
 *
 * A Telegram message goes from the bot straight into OpenClaw — Pinchy's
 * browser-chat door never sees it. The only thing that can stop it is
 * pinchy-audit's `before_agent_run` gate, which asks
 * `POST /api/internal/budgets/check` before the model reads the prompt. This
 * spec proves the whole chain against the real runtime:
 *
 *   inbound Telegram update → OpenClaw run → before_agent_run (pinchy-audit)
 *   → Pinchy budget check → block → refusal text delivered to the sender
 *   → `chat.policy_refused` audit row naming the channel.
 *
 * It also proves the config half nothing else can: OpenClaw skips this hook for
 * a non-bundled plugin unless Pinchy writes
 * `plugins.entries.pinchy-audit.hooks.allowConversationAccess=true`. Without
 * that line every unit test stays green and this spec never sees the refusal.
 *
 * The budget and the month's spend are seeded in SQL: budgets are an
 * enterprise feature and this stack runs without a licence, and the gate does
 * not ask about the licence — exactly as the browser door does not.
 *
 * Needs no model: a block happens before inference, so this runs in CI where
 * the suite's @llm tests are skipped. The reply it waits for is the block text,
 * which only the gate produces.
 */

import { test, expect } from "@playwright/test";
import {
  login,
  getAgentId,
  connectBot,
  linkTelegram,
  sendTelegramAndAwaitReply,
  sendTelegramMessage,
  getBotResponses,
  unlinkTelegram,
  waitForPinchy,
  waitForMockTelegram,
  waitForOpenClawConnected,
  waitForTelegramPolling,
  setAgentPersonalOwnedByAdmin,
  seedSetup,
  pinchyGet,
  type AuditEntry,
} from "./helpers";
import { stackDbUrl } from "../shared/stack-db";

// Smithers' bot, as in the rest of the suite, so this spec never rotates it.
const BOT_TOKEN = "123456:ABC-test-token-for-e2e";
// A peer no other spec in this suite links.
const TG_PEER_ID = "444333222";
const TG_USERNAME = "budget_e2e_peer";
// Marks the usage rows this spec seeds, so cleanup removes exactly those.
const SEED_SESSION_KEY = "e2e:budget-block";
// The budget this spec seeds. A leftover from a crashed run is recognised by
// this exact shape; any other budget on the agent is not ours and is kept.
const SEED_LIMIT_USD = "1.00";

const BLOCK_TEXT = "has used its monthly budget";

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL || stackDbUrl(5434));
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** This spec's refusal rows for the agent since `since`, as the logged-in admin. */
async function refusalsSince(agentId: string, since: string): Promise<AuditEntry[]> {
  const res = await pinchyGet(
    `/api/audit?eventType=chat.policy_refused&limit=25&from=${encodeURIComponent(since)}`
  );
  if (!res.ok) throw new Error(`audit query failed: ${res.status}`);
  const { entries = [] } = (await res.json()) as { entries?: AuditEntry[] };
  return entries.filter(
    (e) => e.resource === `agent:${agentId}` && e.detail?.reason === "budget_exhausted"
  );
}

/** Poll for this spec's refusal row. */
async function pollRefusal(agentId: string, since: string, timeout = 60_000): Promise<AuditEntry> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [match] = await refusalsSince(agentId, since);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No chat.policy_refused (budget_exhausted) for agent ${agentId} since ${since}`);
}

const PEER_MESSAGE = {
  token: BOT_TOKEN,
  chatId: TG_PEER_ID,
  text: "What does our travel policy say?",
  userId: TG_PEER_ID,
  username: TG_USERNAME,
  firstName: "BudgetE2E",
};

/** Bot replies to the peer since `since` that `accept` takes, waiting up to `timeoutMs`. */
async function waitForReply(
  since: string,
  timeoutMs: number,
  accept: (text: string) => boolean = () => true
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  // Looks at least once, so a zero timeout is a plain check.
  for (;;) {
    const replies = await getBotResponses(TG_PEER_ID, since);
    const match = replies.find((r) => typeof r.text === "string" && accept(r.text));
    if (match) return match.text;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Send the peer's message until some reply since the first send contains
 * `needle`. A reply carries nothing that ties it to the message it answers, so
 * the search covers every reply, and each re-send waits for a reply first: a
 * message sent while a turn is running is steered into it, and OpenClaw holds
 * a steered message that a blocked turn never commits for up to 120 s.
 * Every wait is bounded by the deadline that remains.
 */
async function sendUntilReplyMatches(needle: string, { deadlineMs }: { deadlineMs: number }) {
  const deadline = Date.now() + deadlineMs;
  const firstSend = new Date().toISOString();
  while (Date.now() < deadline) {
    const sentAt = new Date().toISOString();
    await sendTelegramMessage(PEER_MESSAGE);
    await waitForReply(sentAt, Math.max(0, deadline - Date.now()));
    const hit = await waitForReply(firstSend, 0, (t) => t.includes(needle));
    if (hit) return hit;
  }
  const hit = await waitForReply(firstSend, 0, (t) => t.includes(needle));
  if (hit) return hit;
  const seen = (await getBotResponses(TG_PEER_ID, firstSend)).map((r) => r.text);
  throw new Error(
    `No reply containing "${needle}" within ${deadlineMs}ms; replies: ${JSON.stringify(seen)}`
  );
}

/** Seed a used-up blocking budget; returns its id so cleanup removes only it. */
async function exhaustBlockingBudget(agentId: string): Promise<string> {
  return withDb(async (sql) => {
    const [budget] = await sql<{ id: string }[]>`
      INSERT INTO cost_budgets (agent_id, monthly_limit_usd, on_exceeded)
      VALUES (${agentId}, ${SEED_LIMIT_USD}, 'block')
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (!budget) {
      throw new Error(`Agent ${agentId} already has a budget; this spec will not overwrite it`);
    }
    await sql`
      INSERT INTO usage_records
        (user_id, agent_id, agent_name, session_key, model, input_tokens, output_tokens, estimated_cost_usd)
      VALUES
        ('e2e-budget', ${agentId}, 'Smithers', ${SEED_SESSION_KEY}, 'e2e/model', 1, 1, 5.000000)
    `;
    return budget.id;
  });
}

/** Remove this spec's seed: its usage rows, and its budget (by id, or by its exact shape). */
async function removeBudgetSeed(agentId: string, budgetId?: string): Promise<void> {
  await withDb(async (sql) => {
    await sql`DELETE FROM usage_records WHERE session_key = ${SEED_SESSION_KEY}`;
    if (budgetId) {
      await sql`DELETE FROM cost_budgets WHERE id = ${budgetId}`;
    } else {
      await sql`
        DELETE FROM cost_budgets
        WHERE agent_id = ${agentId} AND monthly_limit_usd = ${SEED_LIMIT_USD} AND on_exceeded = 'block'
      `;
    }
  });
}

test.describe.serial("Blocking budget — Telegram", () => {
  let agentId: string;
  let budgetId: string | undefined;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000);
    await waitForPinchy();
    await waitForMockTelegram();
    await seedSetup();
    await waitForOpenClawConnected(120000);
    await login();
    agentId = await getAgentId();
    // The main bot must sit on a personal agent; a previous spec may have left
    // Smithers shared. Idempotent.
    await setAgentPersonalOwnedByAdmin(agentId);
    await connectBot(agentId, BOT_TOKEN);
    await waitForTelegramPolling();
    // Never start over a budget a crashed earlier run left behind.
    await removeBudgetSeed(agentId);
  });

  test.afterAll(async () => {
    // Every later spec in this stack talks to Smithers, and links its own peer.
    if (agentId) await removeBudgetSeed(agentId, budgetId);
    await unlinkTelegram().catch(() => {});
  });

  test("a used-up blocking budget stops a linked user's Telegram turn and says why", async ({}, testInfo) => {
    // Pairing (≤180 s) + the block (≤300 s) + the audit row (≤60 s), with room.
    testInfo.setTimeout(600000);

    // Seed first: the pairing message runs no agent, so no pass can be cached
    // for this spec's turns, and the first linked message is normally refused
    // outright. A pass cached by an earlier spec's turn is what the re-send
    // loop below still covers.
    const since = new Date(Date.now() - 1000).toISOString();
    budgetId = await exhaustBlockingBudget(agentId);

    // Link the peer. A message injected while the channel restarts after
    // connectBot can be lost, so re-send until the pairing reply lands.
    const pairResp = await sendTelegramAndAwaitReply({
      token: BOT_TOKEN,
      chatId: TG_PEER_ID,
      text: "Pair me please",
      userId: TG_PEER_ID,
      username: TG_USERNAME,
      firstName: "BudgetE2E",
    });
    const codeMatch = pairResp.match(/Pairing code:(?:\s|<[^>]+>|`)*([A-Za-z0-9][A-Za-z0-9_-]*)/i);
    expect(codeMatch, `expected a pairing code, got: ${pairResp.slice(0, 200)}`).toBeTruthy();
    expect((await linkTelegram(codeMatch![1].trim())).status).toBe(200);

    const reply = await sendUntilReplyMatches(BLOCK_TEXT, { deadlineMs: 300_000 });

    // OpenClaw wraps the gate's message: "Your message could not be sent: …".
    expect(reply).toContain(BLOCK_TEXT);
    expect(reply).toContain("could not be sent");
    expect(reply).not.toMatch(/Pairing code/i);

    const row = await pollRefusal(agentId, since);
    expect(row.outcome).toBe("failure");
    expect(row.detail.channel).toBe("telegram");
  });

  test("raising the budget reopens the agent on the next Telegram message", async ({}, testInfo) => {
    testInfo.setTimeout(300000);
    await removeBudgetSeed(agentId, budgetId);
    budgetId = undefined;

    // A block is never cached while Pinchy answers, so the very next turn is
    // asked afresh and reaches the model, whose E2E error reply proves a turn
    // ran. Two signals, both positive: a reply after the send that is not the
    // refusal, and no refusal row written for it. A late reply left over from
    // the previous test can satisfy the first; only a refused send writes the
    // second, and the gate writes it before the refusal is even sent.
    const sentAt = new Date().toISOString();
    await sendTelegramMessage({ ...PEER_MESSAGE, text: "And now?" });
    const answer = await waitForReply(sentAt, 150_000, (t) => !t.includes(BLOCK_TEXT));
    expect(answer, "the unblocked turn should answer").toBeDefined();
    expect(await refusalsSince(agentId, sentAt)).toEqual([]);
  });
});
