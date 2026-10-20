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
 * that line every unit test stays green and this spec gets no reply.
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
// Marks the rows this spec seeds, so cleanup removes exactly those.
const SEED_SESSION_KEY = "e2e:budget-block";

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

/** Poll the audit log (as the logged-in admin) for this spec's refusal row. */
async function pollRefusal(agentId: string, since: string, timeout = 60_000): Promise<AuditEntry> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const res = await pinchyGet(
      `/api/audit?eventType=chat.policy_refused&limit=25&from=${encodeURIComponent(since)}`
    );
    if (res.ok) {
      const { entries = [] } = (await res.json()) as { entries?: AuditEntry[] };
      const match = entries.find(
        (e) => e.resource === `agent:${agentId}` && e.detail?.reason === "budget_exhausted"
      );
      if (match) return match;
    }
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

/** Every bot reply to the peer since `since`, waiting up to `timeoutMs` for the first. */
async function waitForReplies(since: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const replies = (await getBotResponses(TG_PEER_ID, since)).filter(
      (r) => typeof r.text === "string"
    );
    if (replies.length > 0) return replies;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
}

/**
 * Wait until the peer's chat has gone quiet: no new bot reply for `quietMs`.
 * A reply carries nothing that ties it to the message it answers, and one turn
 * can send more than one message (the E2E model's error reply does). Sending
 * only into a quiet chat is what makes "the first reply after my send" mean
 * "the answer to my send" — and keeps the previous test's late replies out of
 * the next one.
 */
async function waitForQuietChat(quietMs = 5_000, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let count = (await getBotResponses(TG_PEER_ID)).length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = (await getBotResponses(TG_PEER_ID)).length;
    if (now !== count) {
      count = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
  throw new Error(`Chat ${TG_PEER_ID} never went quiet within ${timeoutMs}ms`);
}

/** Send once into a quiet chat and return the first reply's text ("" if none came). */
async function sendAndReadAnswer(text: string, timeoutMs = 150_000): Promise<string> {
  await waitForQuietChat();
  const sentAt = new Date().toISOString();
  await sendTelegramMessage({ ...PEER_MESSAGE, text });
  const [first] = await waitForReplies(sentAt, timeoutMs);
  return first?.text ?? "";
}

/**
 * Send the peer's message until the answer contains `needle`. Each send waits
 * for the previous turn to finish answering (see the steering note at the call
 * site), so the turns never overlap.
 */
async function sendUntilReplyMatches(needle: string, { deadlineMs }: { deadlineMs: number }) {
  const deadline = Date.now() + deadlineMs;
  const seen: string[] = [];
  while (Date.now() < deadline) {
    const answer = await sendAndReadAnswer(PEER_MESSAGE.text);
    if (answer.includes(needle)) return answer;
    seen.push(answer);
  }
  throw new Error(
    `No reply containing "${needle}" before the deadline; answers: ${JSON.stringify(seen)}`
  );
}

async function exhaustBlockingBudget(agentId: string): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      INSERT INTO cost_budgets (agent_id, monthly_limit_usd, on_exceeded)
      VALUES (${agentId}, 1.00, 'block')
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO usage_records
        (user_id, agent_id, agent_name, session_key, model, input_tokens, output_tokens, estimated_cost_usd)
      VALUES
        ('e2e-budget', ${agentId}, 'Smithers', ${SEED_SESSION_KEY}, 'e2e/model', 1, 1, 5.000000)
    `;
  });
}

async function removeBudgetSeed(agentId: string): Promise<void> {
  await withDb(async (sql) => {
    await sql`DELETE FROM usage_records WHERE session_key = ${SEED_SESSION_KEY}`;
    await sql`DELETE FROM cost_budgets WHERE agent_id = ${agentId}`;
  });
}

test.describe.serial("Blocking budget — Telegram", () => {
  let agentId: string;

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
    // Every later spec in this stack talks to Smithers.
    if (agentId) await removeBudgetSeed(agentId);
  });

  test("a used-up blocking budget stops a linked user's Telegram turn and says why", async ({}, testInfo) => {
    testInfo.setTimeout(480000);

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

    const since = new Date(Date.now() - 1000).toISOString();
    await exhaustBlockingBudget(agentId);

    // The gate reuses a pass for 15 s, so a first message can still go
    // through; it then gets the E2E model's error reply instead. Send again
    // only once the previous turn has answered: a message sent while a turn
    // is running is steered into it, and OpenClaw waits up to 120 s for a
    // steered message that a blocked turn will never commit. The exit
    // condition is the assertion itself.
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
    await removeBudgetSeed(agentId);

    // A block is never cached while Pinchy answers, so the very next turn is
    // asked afresh and reaches the model. The E2E model answers with an error
    // reply, and that reply arriving at all is the proof a turn ran.
    const answer = await sendAndReadAnswer("And now?", 90_000);
    expect(answer, "the unblocked turn should answer").not.toBe("");
    expect(answer).not.toContain(BLOCK_TEXT);
  });
});
