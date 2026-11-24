// Real-DB integration test for DELETE /api/agents/[agentId]/channels/telegram.
//
// The unit test in agent-telegram-channel.test.ts mocks `@/db` entirely, so it
// only proves "db.delete was called" — not that the right rows actually
// disappear. This test hits a real PostgreSQL (provisioned by global-setup.ts,
// emptied between tests by the integration reset) to verify the Gap 3 (#476) hardening
// for real:
//
//   - When the last Telegram bot in the instance is disconnected, ALL
//     channel_links rows with channel = "telegram" are deleted — across every
//     user, not just the agent being disconnected — and the existing
//     channel.deleted audit row records how many links were cleared via
//     detail.channelLinksCleared.
//   - When another agent's Telegram bot remains configured, channel_links are
//     left untouched and channelLinksCleared is 0.
//
// What stays mocked, and why:
//   - @/lib/auth (getSession) / next/headers — no real browser session exists
//     in a test process; withAuth reads the session via headers().
//   - @/lib/openclaw-config (updateTelegramChannelConfig) — writes OpenClaw's
//     on-disk config and flips restart-state; irrelevant to the DB invariant
//     under test and already covered by openclaw-config's own tests.
//   - @/lib/telegram-allow-store (clearAllowStoreForAccount,
//     recalculateTelegramAllowStores) — file-system allow-list side effects,
//     not DB state.
//
// Everything else (settings, channel_links, audit_log) runs against the real
// database.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockUpdateTelegramChannelConfig = vi.fn();
const mockRegenerateOpenClawConfig = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/openclaw-config", () => ({
  updateTelegramChannelConfig: (...args: unknown[]) => mockUpdateTelegramChannelConfig(...args),
  regenerateOpenClawConfig: (...args: unknown[]) => mockRegenerateOpenClawConfig(...args),
}));

// The two calls out to Telegram's API. Everything else in @/lib/telegram —
// including which stored bot tokens still count — runs for real.
vi.mock("@/lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram")>();
  return {
    ...actual,
    validateTelegramBotToken: vi.fn(async (token: string) => ({
      valid: true,
      botId: Number(token.split(":")[0]),
      botUsername: `${token.split(":")[0]}_bot`,
    })),
    probeTelegramPollingConflict: vi.fn().mockResolvedValue({ conflict: false }),
  };
});

const mockClearAllowStoreForAccount = vi.fn();
const mockRecalculateTelegramAllowStores = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/telegram-allow-store", () => ({
  clearAllowStoreForAccount: (...args: unknown[]) => mockClearAllowStoreForAccount(...args),
  recalculateTelegramAllowStores: (...args: unknown[]) =>
    mockRecalculateTelegramAllowStores(...args),
}));

// ── Real DB imports (loaded AFTER mocks are declared) ──────────────────────

import { db } from "@/db";
import { users, agents, channelLinks, settings, auditLog } from "@/db/schema";
import { setSetting } from "@/lib/settings";
import { DELETE, POST } from "@/app/api/agents/[agentId]/channels/telegram/route";

// ── Fixtures / helpers ───────────────────────────────────────────────────

async function seedUser(overrides?: Partial<typeof users.$inferInsert>) {
  const [row] = await db
    .insert(users)
    .values({
      name: "Test User",
      email: `user-${crypto.randomUUID()}@example.com`,
      emailVerified: true,
      role: "member",
      ...overrides,
    })
    .returning();
  return row;
}

async function seedPersonalAgent(ownerId: string, overrides?: Partial<typeof agents.$inferInsert>) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model: "anthropic/claude-haiku-4-5-20251001",
      greetingMessage: "Hello!",
      isPersonal: true,
      visibility: "restricted",
      ownerId,
      ...overrides,
    })
    .returning();
  return row;
}

async function seedTelegramBot(agentId: string, botIdPrefix: string) {
  await setSetting(`telegram_bot_token:${agentId}`, `${botIdPrefix}:secret-token`, true);
  await setSetting(`telegram_bot_username:${agentId}`, `${botIdPrefix}_bot`, false);
}

async function seedChannelLink(userId: string, channelUserId: string) {
  const [row] = await db
    .insert(channelLinks)
    .values({ userId, channel: "telegram", channelUserId })
    .returning();
  return row;
}

function makeRequest() {
  return new NextRequest("http://localhost/api/agents/agent-1/channels/telegram", {
    method: "DELETE",
  });
}

function makePostRequest(botToken: string) {
  return new NextRequest("http://localhost/api/agents/agent-1/channels/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botToken }),
  });
}

function makeParams(agentId: string) {
  return { params: Promise.resolve({ agentId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/agents/[agentId]/channels/telegram (real DB)", () => {
  it("Case A — last bot removed: wipes ALL telegram channel_links org-wide and records the count on the audit row", async () => {
    const owner = await seedUser({ role: "member" });
    const agent = await seedPersonalAgent(owner.id);
    await seedTelegramBot(agent.id, "111111");

    // channel_links from several different users — proving the wipe is
    // org-wide, not scoped to the disconnecting agent/user.
    const otherUser1 = await seedUser();
    const otherUser2 = await seedUser();
    await seedChannelLink(owner.id, "tg-owner");
    await seedChannelLink(otherUser1.id, "tg-other-1");
    await seedChannelLink(otherUser2.id, "tg-other-2");

    mockGetSession.mockResolvedValue({
      user: { id: owner.id, email: owner.email, role: "member" },
    });

    const resp = await DELETE(makeRequest(), makeParams(agent.id));
    expect(resp.status).toBe(200);

    // All telegram channel_links are gone — a later re-registered bot cannot
    // auto-grant access to stale pairings without re-pairing.
    const remainingLinks = await db
      .select()
      .from(channelLinks)
      .where(eq(channelLinks.channel, "telegram"));
    expect(remainingLinks).toHaveLength(0);

    // The bot-token setting is gone too.
    const remainingSettings = await db
      .select()
      .from(settings)
      .where(eq(settings.key, `telegram_bot_token:${agent.id}`));
    expect(remainingSettings).toHaveLength(0);

    // The channel.deleted audit row is attributable: it records exactly how
    // many links the org-wide sweep cleared.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "channel.deleted"));
    expect(auditRows).toHaveLength(1);
    // appendAuditLog substitutes the user's auditPseudonym for actorId (GDPR
    // crypto-erasure) — assert against that, not the raw owner.id.
    expect(auditRows[0].actorId).toBe(owner.auditPseudonym);
    const detail = auditRows[0].detail as Record<string, unknown>;
    expect(detail.channelLinksCleared).toBe(3);
    expect(detail.channel).toBe("telegram");
  });

  it("Case B — another bot remains: channel_links are untouched and channelLinksCleared is 0", async () => {
    const owner1 = await seedUser({ role: "member" });
    const owner2 = await seedUser({ role: "member" });
    const agent1 = await seedPersonalAgent(owner1.id, { name: "Smithers 1" });
    const agent2 = await seedPersonalAgent(owner2.id, { name: "Smithers 2" });
    await seedTelegramBot(agent1.id, "111111");
    await seedTelegramBot(agent2.id, "222222");

    const linkedUser = await seedUser();
    await seedChannelLink(linkedUser.id, "tg-linked-user");

    mockGetSession.mockResolvedValue({
      user: { id: owner1.id, email: owner1.email, role: "member" },
    });

    // Disconnect only agent1's bot — agent2's bot remains, so the sweep must
    // not fire.
    const resp = await DELETE(makeRequest(), makeParams(agent1.id));
    expect(resp.status).toBe(200);

    const remainingLinks = await db
      .select()
      .from(channelLinks)
      .where(eq(channelLinks.channel, "telegram"));
    expect(remainingLinks).toHaveLength(1);
    expect(remainingLinks[0].userId).toBe(linkedUser.id);

    // agent1's own token setting is gone; agent2's remains untouched.
    const agent1Settings = await db
      .select()
      .from(settings)
      .where(eq(settings.key, `telegram_bot_token:${agent1.id}`));
    expect(agent1Settings).toHaveLength(0);
    const agent2Settings = await db
      .select()
      .from(settings)
      .where(eq(settings.key, `telegram_bot_token:${agent2.id}`));
    expect(agent2Settings).toHaveLength(1);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "channel.deleted"));
    expect(auditRows).toHaveLength(1);
    const detail = auditRows[0].detail as Record<string, unknown>;
    expect(detail.channelLinksCleared).toBe(0);
  });

  // A token left behind by an agent that was soft-deleted before deleting an
  // agent also removed its Telegram settings. That agent's bot runs nowhere:
  // the config build skips deleted agents.
  it("Case C — a deleted agent's leftover token does not count as a remaining bot", async () => {
    const formerOwner = await seedUser({ role: "member" });
    const deletedAgent = await seedPersonalAgent(formerOwner.id, {
      name: "Former Smithers",
      deletedAt: new Date(),
    });
    await seedTelegramBot(deletedAgent.id, "999999");

    const owner = await seedUser({ role: "member" });
    const agent = await seedPersonalAgent(owner.id);
    await seedTelegramBot(agent.id, "111111");
    await seedChannelLink(owner.id, "tg-owner");

    mockGetSession.mockResolvedValue({
      user: { id: owner.id, email: owner.email, role: "member" },
    });

    const resp = await DELETE(makeRequest(), makeParams(agent.id));
    expect(resp.status).toBe(200);

    const remainingLinks = await db
      .select()
      .from(channelLinks)
      .where(eq(channelLinks.channel, "telegram"));
    expect(remainingLinks).toHaveLength(0);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "channel.deleted"));
    expect((auditRows[0].detail as Record<string, unknown>).channelLinksCleared).toBe(1);
  });
});

describe("POST /api/agents/[agentId]/channels/telegram (real DB)", () => {
  it("connects a bot whose token is only left behind by a deleted agent", async () => {
    // The usual case: a deactivated user's Smithers ran the main bot, and the
    // admin now connects that same bot to their own Smithers.
    const formerOwner = await seedUser({ role: "member" });
    const deletedAgent = await seedPersonalAgent(formerOwner.id, {
      name: "Former Smithers",
      deletedAt: new Date(),
    });
    await seedTelegramBot(deletedAgent.id, "999999");

    const admin = await seedUser({ role: "admin" });
    const agent = await seedPersonalAgent(admin.id);

    mockGetSession.mockResolvedValue({
      user: { id: admin.id, email: admin.email, role: "admin" },
    });

    const resp = await POST(makePostRequest("999999:new-secret"), makeParams(agent.id));
    expect(resp.status).toBe(200);

    const stored = await db
      .select()
      .from(settings)
      .where(eq(settings.key, `telegram_bot_token:${agent.id}`));
    expect(stored).toHaveLength(1);
  });

  it("still refuses a bot a live agent already uses", async () => {
    const otherOwner = await seedUser({ role: "member" });
    const otherAgent = await seedPersonalAgent(otherOwner.id, { name: "Other Smithers" });
    await seedTelegramBot(otherAgent.id, "999999");

    const admin = await seedUser({ role: "admin" });
    const agent = await seedPersonalAgent(admin.id);

    mockGetSession.mockResolvedValue({
      user: { id: admin.id, email: admin.email, role: "admin" },
    });

    const resp = await POST(makePostRequest("999999:new-secret"), makeParams(agent.id));
    expect(resp.status).toBe(409);
  });
});
