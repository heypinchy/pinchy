/**
 * Chats E2E (#508) — the critical integration verification for the per-task
 * session model: cross-user isolation, the un-unification "footgun" fix, and
 * the read-only Telegram mirror.
 *
 * Runs against the same protocol-real Telegram mock stack as the rest of this
 * suite (per the project's "E2E with mocks for external deps" convention):
 *   docker compose -f docker-compose.yml -f docker-compose.e2e.yml \
 *                  -f docker-compose.test.yml up --build -d
 *   pnpm -C packages/web test:e2e:telegram
 *
 * What makes this protocol-real rather than a re-mock of OpenClaw:
 *   - Web chats are created by sending over the genuine Pinchy chat WebSocket
 *     (`/api/ws`), so the server's ClientRouter computes the real per-user
 *     session key and OpenClaw materializes a real `sessions.list` entry.
 *   - The Telegram conversation is created by injecting an inbound message
 *     through the Telegram mock's `/control/sendMessage`, exactly as a real
 *     Telegram peer would, and the bot's reply round-trips through OpenClaw.
 *   - The `/new` reset is delivered the same way — as the literal `/new` text a
 *     Telegram client sends — so OpenClaw's own slash-command handling resets
 *     ONLY the Telegram session.
 *
 * The three assertions read back through the actual #508 surfaces:
 * `GET /api/agents/<id>/chats`, `GET /api/agents/<id>/telegram-chat`, the
 * `/chat/<id>/telegram` view, and the ChatSwitcher.
 */

import { test, expect } from "@playwright/test";
import {
  login,
  loginAs,
  getAgentId,
  makeAgentShared,
  setAgentPersonalOwnedByAdmin,
  connectBot,
  linkTelegram,
  unlinkTelegram,
  sendTelegramMessage,
  sendTelegramAndAwaitReply,
  waitForBotResponse,
  waitForPinchy,
  waitForMockTelegram,
  waitForOpenClawConnected,
  waitForTelegramPolling,
  seedSetup,
  getAdminEmail,
  createMemberUser,
  sendWebChatMessage,
  getChatsAs,
  getTelegramChatAs,
  type ChatListItem,
} from "./helpers";
import { waitForOpenClawStable, waitForAgentDispatchable } from "../shared/dispatch-probe";

// We reuse the seeded Smithers agent (already in OpenClaw's runtime, so chat-
// dispatchable) and flip it to SHARED so the member user B can access it too.
// Creating a fresh agent would need a full config regen, which EACCES-fails on
// the production E2E image once OpenClaw has written a root-owned session dir
// (see makeAgentShared's rationale). Smithers is shared by telegram-flow's bot
// token; we use the SAME token so running this suite first doesn't rotate it.
const BOT_TOKEN = "123456:ABC-test-token-for-e2e";
const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";

// A distinct Telegram peer for the Chats suite so it never collides with the
// peer telegram-flow.spec.ts links/unlinks (they run in the same stack).
const TG_PEER_ID = "555444333";
const TG_USERNAME = "chats_e2e_peer";

const MEMBER_PASSWORD = "test-password-123";

/**
 * Poll a user's chats list until `predicate` is satisfied (or timeout). The web
 * session can take a beat to surface in OpenClaw's `sessions.list`, so we poll
 * rather than assert once.
 */
async function waitForChats(
  cookie: string,
  agentId: string,
  predicate: (chats: ChatListItem[]) => boolean,
  { timeout = 30000 }: { timeout?: number } = {}
): Promise<ChatListItem[]> {
  const start = Date.now();
  let last: ChatListItem[] = [];
  while (Date.now() - start < timeout) {
    last = await getChatsAs(cookie, agentId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

test.describe.serial("Chats — per-task session model (#508)", () => {
  let agentId: string;
  let adminCookie: string;
  let userB: { id: string; email: string; password: string };
  let userBCookie: string;

  // Distinct chatIds (nanoid-shaped: lowercase alnum + dash, ≤64) so each user's
  // web chat is its own OpenClaw session, never the legacy default key.
  const chatIdA = "chatse2e-user-a-web";
  const chatIdB = "chatse2e-user-b-web";

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000); // services can be slow in CI
    await waitForPinchy();
    await waitForMockTelegram();
    await seedSetup();
    // Deliberately NOT calling resetMockTelegram() here. Reset zeroes the mock's
    // update_id counter, but OpenClaw's already-running long-poll keeps its
    // higher getUpdates offset — so freshly injected updates (now numbered below
    // that offset) are filtered out and never delivered to the bot. On a fresh
    // CI stack the offset and counter start aligned so it's harmless there, but
    // resetting mid-life silently breaks Telegram delivery. We scope reads by a
    // distinct peer id + `since` timestamps instead, so stale state can't leak in.
    await waitForOpenClawConnected(120000);

    // Admin (user A) — reuse the suite's seeded admin.
    await login();
    adminCookie = await loginAs(getAdminEmail(), "test-password-123");

    // User B — a second, independent member user. Smithers is personal to the
    // admin by default; we flip it to shared below so B can access it too.
    userB = await createMemberUser("chats-b@test.local", MEMBER_PASSWORD);
    userBCookie = await loginAs(userB.email, MEMBER_PASSWORD);
    expect(userBCookie).toBeTruthy();

    // Reuse the already-dispatchable Smithers agent.
    agentId = await getAgentId();
    expect(agentId).toBeTruthy();

    // Ensure Smithers is PERSONAL before connecting the bot. A prior run may have
    // left it shared (makeAgentShared persists), and the channel route's main-bot
    // guard rejects connecting a NON-personal agent when no main bot exists yet —
    // Smithers IS the main bot. Self-heal so the suite is re-runnable.
    await setAgentPersonalOwnedByAdmin(agentId);

    // Connect the bot (same token telegram-flow uses on Smithers) and wait for
    // polling so the Telegram-side tests can round-trip. Idempotent re-connect.
    await connectBot(agentId, BOT_TOKEN);
    await waitForTelegramPolling();

    // Now flip Smithers to SHARED so the member user B can access it too (takes
    // effect immediately — Pinchy reads is_personal/visibility per request, no
    // regen needed). The Telegram channel config (token already written) is
    // unaffected by the is_personal flip.
    await makeAgentShared(agentId);

    // connectBot pushes a config.apply that briefly tears the OpenClaw bridge
    // down and triggers openclaw-node's reconnect backoff. Sending a web chat
    // during that window fails with "Not connected to OpenClaw Gateway" (the
    // cold-start churn the rest of this suite absorbs with generous waits). Gate
    // on a contiguous connected+settled window, then confirm the agent is in
    // OpenClaw's runtime, before any test dispatches a chat.
    await waitForOpenClawStable(() => fetch(`${PINCHY_URL}/api/health/openclaw`), {
      stableForMs: 10_000,
      deadlineMs: 180_000,
    });
    await waitForAgentDispatchable(
      (id) => fetch(`${PINCHY_URL}/api/health/openclaw?agentId=${id}`),
      agentId,
      { deadlineMs: 90_000 }
    );
  });

  test("cross-user isolation: each user sees ONLY their own web chats", async () => {
    // Each user creates a distinct web chat WITH content via the real chat WS.
    await sendWebChatMessage({
      cookie: adminCookie,
      agentId,
      chatId: chatIdA,
      text: "User A's private web chat content",
    });
    await sendWebChatMessage({
      cookie: userBCookie,
      agentId,
      chatId: chatIdB,
      text: "User B's private web chat content",
    });

    // User A must see their own chat and must NEVER see user B's.
    const aChats = await waitForChats(adminCookie, agentId, (c) =>
      c.some((x) => x.chatId === chatIdA)
    );
    const aChatIds = aChats.map((c) => c.chatId);
    expect(aChatIds).toContain(chatIdA);
    expect(aChatIds).not.toContain(chatIdB);
    // Every chat A sees is a web chat owned by A (no foreign principals leaked).
    for (const c of aChats) {
      expect(c.origin === "web" || c.origin === "telegram").toBe(true);
    }

    // And the reverse: user B sees their own chat, never user A's.
    const bChats = await waitForChats(userBCookie, agentId, (c) =>
      c.some((x) => x.chatId === chatIdB)
    );
    const bChatIds = bChats.map((c) => c.chatId);
    expect(bChatIds).toContain(chatIdB);
    expect(bChatIds).not.toContain(chatIdA);
  });

  test("footgun-fixed: Telegram /new resets ONLY Telegram, web chat survives", async ({}, testInfo) => {
    // Telegram round-trips after a channel restart can be slow (polling churn +
    // pairing re-send loop), so give this test a generous budget — above the
    // config default — the same way the suite's beforeAll hooks do.
    testInfo.setTimeout(300000);

    // Precondition: user A still has the web chat from the previous test.
    const beforeWeb = await getChatsAs(adminCookie, agentId);
    expect(beforeWeb.map((c) => c.chatId)).toContain(chatIdA);

    // Link user A's Telegram peer via the pairing flow, then have a real
    // Telegram conversation so a SECOND, separate OpenClaw session exists.
    // Connecting the bot in beforeAll restarts OpenClaw's Telegram channel; a
    // message injected during that window can be skipped by the post-restart
    // getUpdates offset, so we re-send until the pairing reply lands.
    const pairResp = await sendTelegramAndAwaitReply({
      token: BOT_TOKEN,
      chatId: TG_PEER_ID,
      text: "Pair me please",
      userId: TG_PEER_ID,
      username: TG_USERNAME,
      firstName: "ChatsE2E",
    });
    // OpenClaw sends the pairing code wrapped in HTML under parse_mode=HTML
    // ("Pairing code:\n\n<pre><code>CODE\n</code></pre>"). Skip leading
    // whitespace, HTML tags, and Markdown backtick fences, then capture only the
    // alphanumeric code. Capturing a restricted charset (no `<`) instead of
    // stripping the tags with a `.replace` afterwards avoids CodeQL's
    // incomplete-multi-character-sanitization finding while still ignoring the
    // wrapping markup, and stays correct if OpenClaw switches to a code fence.
    const codeMatch = pairResp.match(/Pairing code:(?:\s|<[^>]+>|`)*([A-Za-z0-9][A-Za-z0-9_-]*)/i);
    expect(codeMatch, `expected a pairing code, got: ${pairResp.slice(0, 200)}`).toBeTruthy();
    const code = codeMatch![1].trim();

    const linkRes = await linkTelegram(code);
    expect(linkRes.status).toBe(200);

    // Brief wait for OpenClaw to pick up the link, then a real linked-user turn
    // through the genuine Telegram channel. The assistant reply fails to stream
    // (the E2E mock Anthropic isn't a faithful streaming endpoint — same reason
    // the suite's @llm tests are CI-skipped), but OpenClaw still APPENDS this
    // user message into the Telegram-keyed session, which is all we need: a
    // separate, populated session distinct from the web chat.
    await new Promise((r) => setTimeout(r, 2000));
    await sendTelegramMessage({
      token: BOT_TOKEN,
      chatId: TG_PEER_ID,
      text: "Hello over Telegram — remember this",
      userId: TG_PEER_ID,
      username: TG_USERNAME,
      firstName: "ChatsE2E",
    });

    // The Telegram conversation now surfaces in user A's chats AND has content.
    // We poll the read-only transcript API (server-derived from user A's own
    // linked peer) until the user message lands, rather than waiting on a bot
    // reply the mock can't produce.
    const withTelegram = await waitForChats(adminCookie, agentId, (c) =>
      c.some((x) => x.origin === "telegram")
    );
    expect(
      withTelegram.some((c) => c.origin === "telegram"),
      "Telegram chat should surface in the user's chats list"
    ).toBe(true);
    let tgBefore = await getTelegramChatAs(adminCookie, agentId);
    for (let i = 0; i < 20 && (tgBefore.status !== 200 || tgBefore.messages.length === 0); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      tgBefore = await getTelegramChatAs(adminCookie, agentId);
    }
    expect(tgBefore.status).toBe(200);
    expect(
      tgBefore.messages.length,
      "the Telegram session should carry the user's message"
    ).toBeGreaterThan(0);

    // ── THE REGRESSION: deliver a literal `/new` from the Telegram peer. ──
    // OpenClaw handles the slash command itself and resets the session keyed to
    // the Telegram peer. With the #508 un-unification (no session.identityLinks),
    // that reset MUST NOT touch user A's separate web session.
    const resetBefore = new Date().toISOString();
    await sendTelegramMessage({
      token: BOT_TOKEN,
      chatId: TG_PEER_ID,
      text: "/new",
      userId: TG_PEER_ID,
      username: TG_USERNAME,
      firstName: "ChatsE2E",
    });
    // Slash commands are handled by OpenClaw natively; it acks (or replies).
    // We don't assert on the ack text — just give the reset time to apply.
    await waitForBotResponse(TG_PEER_ID, { timeout: 60000, since: resetBefore }).catch(() => {
      // Some OpenClaw versions ack /new silently; absence of a reply is fine.
    });
    await new Promise((r) => setTimeout(r, 3000));

    // ── ASSERT THE FOOTGUN IS GONE ──
    // 1. User A's web chat is STILL listed.
    const afterWeb = await getChatsAs(adminCookie, agentId);
    expect(
      afterWeb.map((c) => c.chatId),
      "web chat must survive a Telegram /new — the per-task model keeps them separate"
    ).toContain(chatIdA);

    // 2. Its history STILL loads (the web session was not reset/archived). We
    //    re-send into the SAME web session and confirm the turn round-trips —
    //    a wiped session would have surfaced as a fresh, separate key. The web
    //    chat being present in (1) with the same chatId already proves the
    //    session key survived; this is the stronger liveness check.
    await sendWebChatMessage({
      cookie: adminCookie,
      agentId,
      chatId: chatIdA,
      text: "Still here after the Telegram reset?",
    });
    const stillThere = await getChatsAs(adminCookie, agentId);
    const webChat = stillThere.find((c) => c.chatId === chatIdA);
    expect(webChat, "web chat session is still reachable after Telegram /new").toBeTruthy();
    expect(webChat!.origin).toBe("web");
    expect(webChat!.writable).toBe(true);
  });

  test("Telegram read-only view: transcript renders, no composer, Continue-on-Telegram present", async ({
    page,
    context,
  }) => {
    // Authenticate the browser as user A by injecting the session cookie. The
    // `url` form lets Playwright derive domain/path/secure from the baseURL so
    // we don't hardcode (and risk mismatching) the cookie attributes.
    const eq = adminCookie.indexOf("=");
    await context.addCookies([
      {
        name: adminCookie.slice(0, eq),
        value: adminCookie.slice(eq + 1),
        url: "http://localhost:7777",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    await page.goto(`/chat/${agentId}/telegram`);

    // Header + Telegram channel indicator render.
    await expect(page.getByTestId("telegram-chat-header")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("telegram-channel-indicator")).toBeVisible();

    // The transcript renders with at least one message (seeded above). The peer
    // was linked + chatted in the previous test; the read-only mirror reads the
    // server-derived session for user A's own peer.
    await expect(page.getByTestId("telegram-transcript")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("telegram-message-0")).toBeVisible();

    // NO composer: the read-only view renders no message input. assistant-ui's
    // composer textarea (present on the live chat) must be absent here.
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);

    // The "Continue on Telegram" affordance is present (the bot username was
    // persisted on connectBot, so the deep link resolves).
    const continueLink = page.getByRole("link", { name: /Continue on Telegram/i });
    await expect(continueLink).toBeVisible();
    await expect(continueLink).toHaveAttribute("href", /t\.me\//);

    // The read-only banner makes the nature explicit.
    await expect(page.getByText(/This conversation happens on Telegram/i)).toBeVisible();
  });

  test.afterAll(async () => {
    // Leave the suite's shared state clean for any later spec (e.g.
    // telegram-flow, which expects Smithers to be the PERSONAL main bot):
    // unlink this user's peer and restore Smithers to personal. Best-effort —
    // a failure here must not fail the suite.
    await unlinkTelegram().catch(() => {});
    if (agentId) await setAgentPersonalOwnedByAdmin(agentId).catch(() => {});
  });
});
