/**
 * Helpers for Telegram E2E tests.
 *
 * Interacts with:
 * - Pinchy API (http://localhost:7777) for setup, linking, unlinking
 * - Mock Telegram Control API (http://localhost:9001) for injecting/reading messages
 * - Docker exec for reading pairing files from shared volumes
 */

import { execSync } from "child_process";

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
  const dbUrl = process.env.DATABASE_URL || "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy";
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO agents (id, name, model, allowed_tools, visibility)
    VALUES (${id}, ${name}, 'anthropic/claude-haiku-4-5-20251001', '[]'::jsonb, 'all')
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

export async function resetMockTelegram(): Promise<void> {
  await fetch(`${MOCK_TELEGRAM_URL}/control/reset`, { method: "POST" });
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
  const dbUrl = process.env.DATABASE_URL || "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy";
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
      // Once bots > 0, OpenClaw has started polling (sent at least one getUpdates)
      if (data.bots > 0) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Telegram polling not started within ${timeout}ms`);
}
