/**
 * Helpers for Telegram E2E tests.
 *
 * Interacts with:
 * - Pinchy API (http://localhost:7777) for setup, linking, unlinking
 * - Mock Telegram Control API (http://localhost:9001) for injecting/reading messages
 * - Docker exec for reading pairing files from shared volumes
 */

import { execSync } from "child_process";
import { WebSocket } from "ws";
import { stackDbUrl } from "../shared/stack-db";

const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";
const MOCK_TELEGRAM_URL = process.env.MOCK_TELEGRAM_URL || "http://localhost:9001";

// ── Auth helpers ───────────────────────────────────────────────────────

let sessionCookie: string | null = null;

export async function login(
  email = "admin@test.local",
  password = "test-password-123"
): Promise<void> {
  const res = await fetch(`${PINCHY_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PINCHY_URL,
    },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });

  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    sessionCookie = setCookie.split(";")[0];
  }

  if (!sessionCookie) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Issue #235: state-changing requests must declare a same-origin source.
    Origin: PINCHY_URL,
  };
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }
  return headers;
}

// ── Pinchy API helpers ─────────────────────────────────────────────────

export async function pinchyGet(path: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, { headers: authHeaders() });
}

export async function pinchyPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

export async function pinchyDelete(path: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

export async function getAgentId(): Promise<string> {
  const res = await pinchyGet("/api/agents");
  const data = await res.json();
  const agent = data.find((a: { name: string }) => a.name === "Smithers");
  if (!agent) throw new Error("Smithers agent not found");
  return agent.id;
}

export async function getAgentByName(name: string): Promise<{ id: string; name: string } | null> {
  const res = await pinchyGet("/api/agents");
  const data = await res.json();
  return data.find((a: { name: string }) => a.name === name) || null;
}

export async function createAgent(name: string): Promise<{ id: string; name: string }> {
  // Create agent directly in DB — the POST /api/agents endpoint requires
  // template-specific fields (e.g. pluginConfig for knowledge-base) that
  // aren't needed for a basic agent used in multi-bot tests.
  const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO agents (id, name, model, allowed_tools, visibility, greeting_message)
    VALUES (${id}, ${name}, 'anthropic/claude-haiku-4-5-20251001', '[]'::jsonb, 'all', 'Hello! How can I help you?')
  `;
  await sql.end();
  return { id, name };
}

// ── Bot setup helpers ──────────────────────────────────────────────────

export async function connectBot(
  agentId: string,
  botToken: string
): Promise<{ botUsername: string; botId: number }> {
  const res = await pinchyPost(`/api/agents/${agentId}/channels/telegram`, { botToken });
  if (!res.ok) {
    throw new Error(`connectBot failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function disconnectBot(agentId: string): Promise<void> {
  const res = await pinchyDelete(`/api/agents/${agentId}/channels/telegram`);
  if (!res.ok) {
    throw new Error(`disconnectBot failed: ${res.status} ${await res.text()}`);
  }
}

// ── Telegram link helpers ──────────────────────────────────────────────

export async function linkTelegram(pairingCode: string): Promise<Response> {
  return pinchyPost("/api/settings/telegram", { code: pairingCode });
}

export async function unlinkTelegram(): Promise<Response> {
  return pinchyDelete("/api/settings/telegram");
}

export async function getTelegramLinkStatus(): Promise<{
  linked: boolean;
  channelUserId?: string;
}> {
  const res = await pinchyGet("/api/settings/telegram");
  return res.json();
}

// ── Mock Telegram helpers ──────────────────────────────────────────────

export async function sendTelegramMessage(opts: {
  token: string;
  chatId: string;
  text: string;
  userId?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}): Promise<void> {
  const res = await fetch(`${MOCK_TELEGRAM_URL}/control/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    throw new Error(`sendTelegramMessage failed: ${await res.text()}`);
  }
}

export async function getBotResponses(
  chatId?: string,
  since?: string
): Promise<Array<{ chatId: string; text: string; timestamp: string; token: string }>> {
  const params = new URLSearchParams();
  if (chatId) params.set("chatId", chatId);
  if (since) params.set("since", since);
  const res = await fetch(`${MOCK_TELEGRAM_URL}/control/responses?${params}`);
  const data = await res.json();
  return data.responses;
}

export async function waitForBotResponse(
  chatId: string,
  opts: { timeout?: number; since?: string } = {}
): Promise<string> {
  const { timeout = 30000, since } = opts;
  const start = Date.now();
  const sinceTs = since || new Date(start - 1000).toISOString();

  while (Date.now() - start < timeout) {
    const responses = await getBotResponses(chatId, sinceTs);
    if (responses.length > 0) {
      return responses[responses.length - 1].text;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(`No bot response for chatId ${chatId} within ${timeout}ms`);
}

/**
 * Send an inbound Telegram message and wait for the bot's reply, RE-SENDING the
 * message if no reply lands within `perAttemptMs`. Connecting a bot triggers an
 * OpenClaw channel restart (SIGUSR1); a message injected into the mock during
 * that restart window can be skipped by the post-restart `getUpdates` offset and
 * silently lost — there is no reply and nothing retries it. Re-injecting the
 * message (fresh update_id) once polling has resumed gets it delivered. This is
 * the documented Telegram-restart polling churn the whole suite contends with;
 * re-sending an idempotent inbound is safe (the bot just answers the latest).
 */
export async function sendTelegramAndAwaitReply(
  opts: {
    token: string;
    chatId: string;
    text: string;
    userId?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
  },
  waitOpts: { totalTimeout?: number; perAttemptMs?: number } = {}
): Promise<string> {
  const { totalTimeout = 180000, perAttemptMs = 45000 } = waitOpts;
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < totalTimeout) {
    const since = new Date(Date.now() - 500).toISOString();
    await sendTelegramMessage(opts);
    try {
      return await waitForBotResponse(opts.chatId, {
        timeout: Math.min(perAttemptMs, totalTimeout - (Date.now() - start)),
        since,
      });
    } catch (err) {
      lastErr = err;
      // No reply this attempt — loop re-sends (new update_id) after the bot's
      // polling has had time to resume post-restart.
    }
  }
  throw new Error(
    `sendTelegramAndAwaitReply: no reply for chatId ${opts.chatId} within ${totalTimeout}ms (${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    })`
  );
}

export async function resetMockTelegram(): Promise<void> {
  await fetch(`${MOCK_TELEGRAM_URL}/control/reset`, { method: "POST" });
}

/**
 * Toggle the mock's duplicate-poller 409 conflict for a specific bot token.
 * When enabled, getUpdates returns Telegram's "Conflict: terminated by other
 * getUpdates request" — the exact failure a second deployment polling the same
 * token triggers — driving OpenClaw's channel worker into its restart loop.
 */
export async function setMockConflict409(token: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${MOCK_TELEGRAM_URL}/control/getUpdates409`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, token }),
  });
  if (!res.ok) {
    throw new Error(`setMockConflict409 failed: ${res.status} ${await res.text()}`);
  }
}

interface AuditEntry {
  eventType: string;
  resource: string | null;
  outcome: string;
  detail: Record<string, unknown> & { account?: { id?: string } };
}

/**
 * Poll `/api/audit?eventType=<eventType>` until an entry for the given account
 * (Pinchy agent id) appears. Used by the channel-health E2E to assert the
 * watchdog audited a degraded/failed/recovered telegram channel.
 */
export async function pollAuditForChannelEvent(
  eventType: string,
  accountId: string,
  opts: { timeout?: number } = {}
): Promise<AuditEntry> {
  const { timeout = 90000 } = opts;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await pinchyGet(`/api/audit?eventType=${encodeURIComponent(eventType)}&limit=25`);
    if (res.ok) {
      const data = (await res.json()) as { entries?: AuditEntry[] };
      const match = (data.entries ?? []).find((e) => e.detail?.account?.id === accountId);
      if (match) return match;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`No ${eventType} audit for account ${accountId} within ${timeout}ms`);
}

// ── Pairing code helpers ───────────────────────────────────────────────

export function readPairingFile(): Record<string, unknown> | null {
  try {
    const output = execSync(
      "docker compose -f docker-compose.yml -f docker-compose.test.yml exec -T pinchy cat /openclaw-config/credentials/telegram-pairing.json 2>/dev/null",
      { encoding: "utf-8", cwd: process.cwd() }
    );
    return JSON.parse(output);
  } catch {
    return null;
  }
}

export function extractPairingCode(botResponseText: string): string | null {
  // OpenClaw pairing messages typically contain a code like "XXXX-XXXX" or similar
  // Try common patterns
  const patterns = [
    /code[:\s]+([A-Za-z0-9-]+)/i,
    /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/,
    /\b([a-z0-9]{6,})\b/i,
  ];
  for (const pattern of patterns) {
    const match = botResponseText.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ── DB setup helpers ───────────────────────────────────────────────────

export async function seedSetup(): Promise<void> {
  // Create admin account and provider config directly in DB.
  // Uses the same approach as existing E2E tests (03-provider.spec.ts).
  const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);

  // Check if setup already done
  const existing = await sql`SELECT id, email FROM "user" LIMIT 1`;
  if (existing.length > 0) {
    // Use existing admin credentials — store email for login
    _adminEmail = existing[0].email;
    await sql.end();
    console.log(`[setup] Using existing admin: ${_adminEmail}`);
    return;
  }

  // Create admin via Pinchy's setup API
  _adminEmail = "admin@test.local";
  _adminPassword = "test-password-123";

  const setupRes = await fetch(`${PINCHY_URL}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: PINCHY_URL },
    body: JSON.stringify({
      name: "Test Admin",
      email: _adminEmail,
      password: _adminPassword,
    }),
  });

  if (!setupRes.ok) {
    const text = await setupRes.text();
    await sql.end();
    throw new Error(`Setup failed: ${setupRes.status} ${text}`);
  }

  // Wait for setup to complete
  await new Promise((r) => setTimeout(r, 2000));

  // Seed provider config directly in DB (encrypted=false since key is fake).
  // OpenClaw 2026.3.24 runs model prewarm before starting channels — a fake
  // key causes it to hang forever, blocking Telegram startup.
  const testApiKey = process.env.TEST_ANTHROPIC_API_KEY || "sk-ant-fake-key-for-e2e-testing";
  await sql`
    INSERT INTO settings (key, value, encrypted)
    VALUES ('default_provider', 'anthropic', false)
    ON CONFLICT (key) DO UPDATE SET value = 'anthropic'
  `;
  await sql`
    INSERT INTO settings (key, value, encrypted)
    VALUES ('anthropic_api_key', ${testApiKey}, false)
    ON CONFLICT (key) DO UPDATE SET value = ${testApiKey}
  `;

  await sql.end();
  await new Promise((r) => setTimeout(r, 3000));
}

// Admin credentials — set by seedSetup, used by login
let _adminEmail = "admin@test.local";
let _adminPassword = "test-password-123";

export function setAdminCredentials(email: string, password: string): void {
  _adminEmail = email;
  _adminPassword = password;
}

export function getAdminEmail(): string {
  return _adminEmail;
}

// ── Wait helpers ───────────────────────────────────────────────────────

export async function waitForPinchy(timeout = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${PINCHY_URL}/api/setup/status`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Pinchy not ready within ${timeout}ms`);
}

export async function waitForMockTelegram(timeout = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${MOCK_TELEGRAM_URL}/control/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Mock Telegram not ready within ${timeout}ms`);
}

export async function waitForOpenClawConnected(timeout = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${PINCHY_URL}/api/health/openclaw`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === "ok") return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`OpenClaw not connected within ${timeout}ms`);
}

export async function waitForTelegramPolling(timeout = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${MOCK_TELEGRAM_URL}/control/health`);
      const data = await res.json();
      // `bots > 0` means at least one bot has been registered (called getMe).
      // For most tests this is enough — the immediate next assertion
      // (e.g. "send a message and expect a pairing response") has its own
      // generous waitForBotResponse timeout that absorbs the brief gap
      // between getMe and the first getUpdates. Multi-bot scenarios that
      // need a SPECIFIC bot to be live should use waitForBotPolling instead.
      if (data.bots > 0) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Telegram polling not started within ${timeout}ms`);
}

/**
 * Wait for a specific bot token to start polling. Use this in multi-bot
 * scenarios where a generic "any bot is polling" check would pass on the
 * first bot while a newly-connected second bot is still spinning up — that
 * race causes test #10 in the multi-bot suite to flake when OpenClaw is
 * mid-restart from the channel-reload triggered by the bot connect.
 */
export async function waitForBotPolling(token: string, timeout = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${MOCK_TELEGRAM_URL}/control/health`);
      const data = await res.json();
      if (Array.isArray(data.pollingTokens) && data.pollingTokens.includes(token)) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Bot ${token.slice(0, 6)}... did not start polling within ${timeout}ms`);
}

// ── Multi-user helpers (Chats E2E #508) ─────────────────────────────────
//
// The Chats feature's authorization boundary is "one user can only ever see
// their OWN chats with an agent". Verifying that needs at least two real,
// independently-authenticated users hitting the same shared agent — so these
// helpers create a second member user and drive the per-user-cookie API and
// the per-user web-chat WebSocket. They live here so the Telegram E2E suite
// (which already owns the seedSetup/login plumbing) can exercise them without
// a parallel auth harness.

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  /** The auth session cookie (`name=value`), set by `loginAs`. */
  cookie: string;
}

/**
 * Create a non-admin (`member`) user directly in the DB with a Better Auth-
 * compatible scrypt password hash, exactly as `lib/reset-admin.ts` does: a
 * `user` row plus a `credential` `account` row. Direct insertion (rather than
 * the public `/sign-up` endpoint) keeps the helper independent of whether open
 * registration is enabled and of the sign-up rate limiter.
 */
export async function createMemberUser(
  email: string,
  password = "test-password-123"
): Promise<{ id: string; email: string; password: string }> {
  const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
  const { default: postgres } = await import("postgres");
  const { hashPassword } = await import("better-auth/crypto");
  const sql = postgres(dbUrl);
  try {
    const existing = await sql<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${email}`;
    if (existing.length > 0) {
      return { id: existing[0].id, email, password };
    }
    const id = crypto.randomUUID();
    const hashed = await hashPassword(password);
    await sql`
      INSERT INTO "user" (id, name, email, email_verified, role)
      VALUES (${id}, ${"Member " + email}, ${email}, true, 'member')
    `;
    await sql`
      INSERT INTO account (id, user_id, account_id, provider_id, password)
      VALUES (${crypto.randomUUID()}, ${id}, ${id}, 'credential', ${hashed})
    `;
    return { id, email, password };
  } finally {
    await sql.end();
  }
}

/**
 * Make an existing agent SHARED and "all"-visibility directly in the DB, so a
 * second member user can access it. Pinchy's access check (`getAgentWithAccess`
 * / `assertAgentAccess`) reads `is_personal` + `visibility` from the agent row
 * on every request, so this takes effect immediately with NO OpenClaw config
 * regenerate — which is exactly why we use it instead of creating a new agent.
 *
 * Why not create a fresh agent: the only way to get an agent into OpenClaw's
 * `agents.list` (so it's chat-dispatchable) is a full `regenerateOpenClawConfig`
 * (a targeted channel write from connectBot does NOT). But on the production
 * E2E image (uid 999), once OpenClaw has written an agent's session dir as root,
 * a full regen EACCES-fails on `agents/<id>/agent` (writeAgentAuthProfiles
 * mkdir). Reusing the already-dispatchable seeded agent sidesteps that entirely.
 */
export async function makeAgentShared(agentId: string): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);
  try {
    await sql`
      UPDATE agents
      SET is_personal = false, visibility = 'all', owner_id = NULL
      WHERE id = ${agentId}
    `;
  } finally {
    await sql.end();
  }
}

/**
 * Restore an agent to PERSONAL, owned by the first admin. Counterpart to
 * `makeAgentShared`: the Telegram channel route's main-bot guard rejects
 * connecting a bot to a NON-personal agent when no main bot exists yet, and the
 * seeded Smithers agent IS the main bot. Since `makeAgentShared` persists, a
 * prior run can leave Smithers shared — call this FIRST so connectBot succeeds,
 * then flip to shared again. Returns the admin id used as owner.
 */
export async function setAgentPersonalOwnedByAdmin(agentId: string): Promise<string> {
  const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);
  try {
    const admins = await sql<{ id: string }[]>`SELECT id FROM "user" WHERE role = 'admin' LIMIT 1`;
    const adminId = admins[0]?.id;
    await sql`
      UPDATE agents
      SET is_personal = true, visibility = 'restricted', owner_id = ${adminId ?? null}
      WHERE id = ${agentId}
    `;
    return adminId ?? "";
  } finally {
    await sql.end();
  }
}

/**
 * Sign in as a specific user and return the session cookie. Unlike `login()`,
 * this does NOT mutate the module-global cookie used by `pinchyGet/Post/Delete`
 * — callers pass the returned cookie to the `*As` helpers so two users can be
 * driven side by side in one test.
 */
export async function loginAs(email: string, password = "test-password-123"): Promise<string> {
  const res = await fetch(`${PINCHY_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: PINCHY_URL },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie ? setCookie.split(";")[0] : null;
  if (!cookie) {
    throw new Error(`loginAs(${email}) failed: ${res.status} ${await res.text()}`);
  }
  return cookie;
}

function authHeadersFor(cookie: string): Record<string, string> {
  return { "Content-Type": "application/json", Origin: PINCHY_URL, Cookie: cookie };
}

export async function pinchyGetAs(cookie: string, path: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, { headers: authHeadersFor(cookie) });
}

export async function pinchyPostAs(cookie: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "POST",
    headers: authHeadersFor(cookie),
    body: JSON.stringify(body),
  });
}

export async function pinchyDeleteAs(cookie: string, path: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, { method: "DELETE", headers: authHeadersFor(cookie) });
}

export interface ChatListItem {
  chatId: string | null;
  sessionId: string;
  origin: "web" | "telegram";
  writable: boolean;
  title: string | null;
  lastInteractionAt: number;
}

/** GET /api/agents/<agentId>/chats as a specific user (their own chats only). */
export async function getChatsAs(cookie: string, agentId: string): Promise<ChatListItem[]> {
  const res = await pinchyGetAs(cookie, `/api/agents/${agentId}/chats`);
  if (!res.ok) {
    throw new Error(`getChatsAs failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { chats?: ChatListItem[] };
  return data.chats ?? [];
}

export interface TelegramTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

/** GET /api/agents/<agentId>/telegram-chat as a specific user. */
export async function getTelegramChatAs(
  cookie: string,
  agentId: string
): Promise<{ status: number; messages: TelegramTranscriptMessage[]; botDeepLink: string | null }> {
  const res = await pinchyGetAs(cookie, `/api/agents/${agentId}/telegram-chat`);
  if (!res.ok) {
    return { status: res.status, messages: [], botDeepLink: null };
  }
  const data = (await res.json()) as {
    messages?: TelegramTranscriptMessage[];
    botDeepLink?: string | null;
  };
  return {
    status: res.status,
    messages: data.messages ?? [],
    botDeepLink: data.botDeepLink ?? null,
  };
}

/**
 * Send ONE web-chat message over the real Pinchy chat WebSocket (`/api/ws`),
 * authenticated with the given user's session cookie, and wait until OpenClaw
 * has MATERIALIZED the session for it. This is the genuine web path: the
 * server's `ClientRouter` computes the per-(user, agent[, chatId]) session key
 * and dispatches to OpenClaw, which appends the user message into a real
 * session keyed `agent:<id>:direct:<userId>[:<chatId>]` — the same session the
 * Chats list later reads back through `sessions.list`.
 *
 * Why we resolve on session creation rather than a completed assistant turn:
 * the E2E stack's mock Anthropic is NOT a faithful streaming endpoint, so the
 * agent turn fails late with `incomplete_result` — but OpenClaw has already
 * persisted the user message into the session by then (verified: the chat shows
 * up in `sessions.list` despite the turn error). For the Chats feature we only
 * need the session to exist; the turn's content is irrelevant. This is also why
 * the suite's `@llm` tests, which DO assert on reply content, are CI-skipped.
 *
 * No browser / assistant-ui involved on purpose: the previous chat-UI E2E was
 * dropped for model-prewarm + render flakes (see agent-create-no-restart.spec.ts).
 *
 * Discriminating a real dispatch failure from a tolerable turn failure: the
 * server sends `thinking` the moment it ACCEPTS + dispatches the message (after
 * which the user turn is persisted). So `thinking`-then-anything ⇒ the session
 * exists ⇒ resolve. An error WITHOUT a preceding `thinking` means dispatch
 * itself failed (e.g. "Not connected to OpenClaw Gateway" during reconnect
 * churn) ⇒ no session ⇒ retry once.
 */
export async function sendWebChatMessage(opts: {
  cookie: string;
  agentId: string;
  text: string;
  chatId?: string;
  timeout?: number;
}): Promise<void> {
  const { cookie, agentId, text, chatId, timeout = 60000 } = opts;
  const wsUrl = `${PINCHY_URL.replace(/^http/, "ws")}/api/ws?agentId=${agentId}`;

  // Resolves `true` when the session was materialized (turn dispatched), `false`
  // when dispatch failed before reaching OpenClaw (caller retries). Rejects only
  // on a definitive protocol rejection that a retry can't fix.
  const attempt = (): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: PINCHY_URL } });
      const timer = setTimeout(() => {
        ws.close();
        // No frame at all within the window — treat as a dispatch miss so the
        // caller retries rather than hard-failing on a slow reconnect.
        resolve(false);
      }, timeout);

      let dispatched = false; // saw `thinking` ⇒ user turn persisted
      let graceTimer: ReturnType<typeof setTimeout> | null = null;

      const settle = (ok: boolean) => {
        if (graceTimer) clearTimeout(graceTimer);
        clearTimeout(timer);
        ws.close();
        resolve(ok);
      };

      ws.on("open", () => {
        ws.send(
          JSON.stringify({ type: "message", agentId, content: text, ...(chatId ? { chatId } : {}) })
        );
      });

      ws.on("message", (raw) => {
        let msg: { type?: string; message?: string; code?: string };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        // A completed turn (mock can sometimes echo) is unambiguous success.
        if (msg.type === "complete" || msg.type === "done") {
          settle(true);
          return;
        }
        // `thinking` ⇒ accepted + dispatched ⇒ the user turn is now in the
        // session. Give OpenClaw a brief grace window to finish persisting,
        // then resolve as created regardless of how the assistant turn ends.
        if (msg.type === "thinking") {
          dispatched = true;
          if (!graceTimer) graceTimer = setTimeout(() => settle(true), 3000);
          return;
        }
        if (msg.type === "text" || msg.type === "chunk") {
          settle(true);
          return;
        }
        if (msg.type === "error") {
          const code = `${msg.code ?? ""} ${msg.message ?? ""}`;
          // Definitive protocol rejections can never succeed on retry — fail fast.
          if (/INVALID_CHAT_ID|PROTOCOL_OUTDATED|Access denied|Agent not found/i.test(code)) {
            clearTimeout(timer);
            if (graceTimer) clearTimeout(graceTimer);
            ws.close();
            reject(new Error(`web chat rejected: ${code.trim() || "unknown"}`));
            return;
          }
          // An error AFTER `thinking` is a turn failure (e.g. the mock's
          // non-streaming reply → `incomplete_result`); the session already
          // exists, so this counts as created. An error BEFORE `thinking` is a
          // dispatch miss (reconnect churn) ⇒ retry.
          settle(dispatched);
        }
      });

      ws.on("error", () => {
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        // Socket-level failure before/around dispatch ⇒ let the caller retry.
        resolve(false);
      });
    });

  let created = await attempt();
  if (!created) {
    // Cold-start / reconnect churn (a config.apply from connectBot drops the
    // openclaw-node bridge). Retry once after a short backoff — the exact
    // transient the rest of the Telegram suite absorbs with generous waits.
    await new Promise((r) => setTimeout(r, 5000));
    created = await attempt();
  }
  if (!created) {
    throw new Error(
      "sendWebChatMessage: OpenClaw never accepted the message (no `thinking` frame after retry)"
    );
  }

  // Settle: OpenClaw persists the user turn into the session JSONL just after
  // dispatch; a small wait avoids reading `sessions.list` before it lands.
  await new Promise((r) => setTimeout(r, 1500));
}
