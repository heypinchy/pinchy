import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/api-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-auth")>();
  return {
    ...actual,
    requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  };
});

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockValidateTelegramBotToken = vi.fn();
const mockHasMainTelegramBot = vi.fn().mockResolvedValue(true);
const mockProbeTelegramPollingConflict = vi.fn().mockResolvedValue({ conflict: false });
vi.mock("@/lib/telegram", () => ({
  validateTelegramBotToken: (...args: unknown[]) => mockValidateTelegramBotToken(...args),
  hasMainTelegramBot: (...args: unknown[]) => mockHasMainTelegramBot(...args),
  probeTelegramPollingConflict: (...args: unknown[]) => mockProbeTelegramPollingConflict(...args),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const mockUpdateTelegramChannelConfig = vi.fn();
const mockRegenerateOpenClawConfig = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/openclaw-config", () => ({
  updateTelegramChannelConfig: (...args: unknown[]) => mockUpdateTelegramChannelConfig(...args),
  regenerateOpenClawConfig: (...args: unknown[]) => mockRegenerateOpenClawConfig(...args),
}));

const mockClearAllowStoreForAccount = vi.fn();
const mockRecalculateTelegramAllowStores = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/telegram-allow-store", () => ({
  clearAllowStoreForAccount: (...args: unknown[]) => mockClearAllowStoreForAccount(...args),
  recalculateTelegramAllowStores: (...args: unknown[]) =>
    mockRecalculateTelegramAllowStores(...args),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    eq: vi.fn(),
  };
});

import { GET, POST, DELETE } from "@/app/api/agents/[agentId]/channels/telegram/route";
import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { NextRequest, NextResponse } from "next/server";

const adminSession = {
  user: { id: "user-1", email: "admin@test.com", role: "admin" },
};

const mockParams = Promise.resolve({ agentId: "agent-1" });
const mockAgent = { id: "agent-1", name: "Test Agent" };

function makeRequest(body?: object) {
  return new NextRequest("http://localhost/api/agents/agent-1/channels/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
  });
}

describe("GET /api/agents/[agentId]/channels/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminSession);
  });

  it("returns configured: false when no token exists", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ configured: false, mainBotConfigured: true });
  });

  it("returns configured: true with hint when token exists", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce("123456:ABC-some-token-xY9z");

    const response = await GET(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      configured: true,
      hint: "xY9z",
      mainBotConfigured: true,
      conflictDisabled: false,
    });
  });

  it("surfaces conflictDisabled: true when the disabled marker is set (#477 layer 2)", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-some-token-xY9z";
      if (key === "telegram_conflict_disabled:agent-1")
        return JSON.stringify({
          reason: "polling_conflict",
          lastError: "Conflict: terminated by other getUpdates request",
          disabledAt: "2026-07-08T00:00:00.000Z",
        });
      return null;
    });

    const response = await GET(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.conflictDisabled).toBe(true);
    expect(data.conflictDisabledAt).toBe("2026-07-08T00:00:00.000Z");
    expect(data.lastError).toBe("Conflict: terminated by other getUpdates request");
  });

  it("returns mainBotConfigured: true when the main bot exists", async () => {
    mockHasMainTelegramBot.mockResolvedValueOnce(true);
    vi.mocked(getSetting).mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ configured: false, mainBotConfigured: true });
  });

  it("returns mainBotConfigured: false when the main bot is missing", async () => {
    mockHasMainTelegramBot.mockResolvedValueOnce(false);
    vi.mocked(getSetting).mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ configured: false, mainBotConfigured: false });
  });

  it("still returns hint and mainBotConfigured when agent has its own bot", async () => {
    mockHasMainTelegramBot.mockResolvedValueOnce(true);
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-some-token-xY9z";
      return null;
    });

    const response = await GET(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      configured: true,
      hint: "xY9z",
      mainBotConfigured: true,
      conflictDisabled: false,
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockRequireAdmin.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await GET(new NextRequest("http://localhost"), {
      params: mockParams,
    });

    expect(response.status).toBe(401);
  });

  it("returns mainBotConfigured: true for personal agent even when global main bot is missing", async () => {
    mockHasMainTelegramBot.mockResolvedValueOnce(false);
    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      id: "agent-1",
      isPersonal: true,
    } as any);
    vi.mocked(getSetting).mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ configured: false, mainBotConfigured: true });
  });
});

describe("POST /api/agents/[agentId]/channels/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminSession);
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(mockAgent as any);
    mockValidateTelegramBotToken.mockResolvedValue({
      valid: true,
      botId: 123456,
      botUsername: "test_bot",
    });
    mockProbeTelegramPollingConflict.mockResolvedValue({ conflict: false });
  });

  it("validates and stores bot token, sends config.patch, logs audit event", async () => {
    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ botUsername: "test_bot", botId: 123456 });

    expect(mockValidateTelegramBotToken).toHaveBeenCalledWith("123456:ABC-token");
    expect(setSetting).toHaveBeenCalledWith("telegram_bot_token:agent-1", "123456:ABC-token", true);
    expect(setSetting).toHaveBeenCalledWith("telegram_bot_username:agent-1", "test_bot", false);
    expect(mockUpdateTelegramChannelConfig).toHaveBeenCalled();
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "channel.created",
        resource: "agent:agent-1",
        detail: expect.objectContaining({
          agent: { id: "agent-1", name: "Test Agent" },
          channel: "telegram",
          botUsername: "test_bot",
        }),
      })
    );
  });

  it("clears the conflict-disabled marker on a successful connect, so [Reconnect] re-enables the account (#477 layer 2)", async () => {
    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    expect(deleteSetting).toHaveBeenCalledWith("telegram_conflict_disabled:agent-1");
  });

  it("falls back to a full config regeneration when the targeted write reports the agent missing from agents.list (OpenClaw 2026.7.1 bindings validation)", async () => {
    // The on-disk agents.list can predate a just-created agent (its
    // create-regen is fire-and-forget). OpenClaw ≥2026.7.1 rejects a config
    // whose bindings reference an agent not in agents.list, so the targeted
    // patch must not be written — the route regenerates the full config
    // (agents.list + account + binding from the DB) instead.
    mockUpdateTelegramChannelConfig.mockReturnValueOnce("agent-not-in-config");

    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    expect(mockRegenerateOpenClawConfig).toHaveBeenCalledOnce();
  });

  it("does not run a full regeneration when the targeted write applied cleanly", async () => {
    mockUpdateTelegramChannelConfig.mockReturnValueOnce("applied");

    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("does not mutate channels.telegram on validation failure", async () => {
    // updateTelegramChannelConfig must NOT be called when the token check fails.
    mockValidateTelegramBotToken.mockResolvedValueOnce({
      valid: false,
      error: "Invalid token",
    });

    await POST(makeRequest({ botToken: "invalid" }), { params: mockParams });

    expect(mockUpdateTelegramChannelConfig).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid token", async () => {
    mockValidateTelegramBotToken.mockResolvedValueOnce({
      valid: false,
      error: "Invalid token",
    });

    const response = await POST(makeRequest({ botToken: "invalid-token" }), { params: mockParams });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid token");
  });

  it("returns 400 when bot token is missing", async () => {
    const response = await POST(makeRequest({}), { params: mockParams });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Validation failed");
    expect(data.details.fieldErrors.botToken).toBeDefined();
  });

  it("returns 404 for non-existent agent", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce(undefined as any);

    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Agent not found");
  });

  it("returns 401 when not authenticated", async () => {
    mockRequireAdmin.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });

    expect(response.status).toBe(401);
  });

  it("returns 409 when bot token is already used by another agent", async () => {
    // Simulate another agent already using this bot (same bot ID "123456")
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([{ key: "telegram_bot_token:agent-2", value: "encrypted" }]),
      }),
    } as never);
    // getSetting returns the existing agent's token with the same bot ID
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-2") return "123456:OTHER-secret";
      return null;
    });

    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toContain("already in use");
  });

  it("returns 409 when the polling-conflict probe detects another poller (#477 layer 1)", async () => {
    mockProbeTelegramPollingConflict.mockResolvedValueOnce({ conflict: true });

    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toBe(
      "This bot is already being polled by another deployment (for example a staging or production stack). Use a separate bot token per environment, or disconnect it there first."
    );
    expect(mockUpdateTelegramChannelConfig).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("probes for a polling conflict only after getMe validation and the duplicate-token check pass", async () => {
    await POST(makeRequest({ botToken: "123456:ABC-token" }), { params: mockParams });

    expect(mockProbeTelegramPollingConflict).toHaveBeenCalledWith("123456:ABC-token");
  });

  it("does not probe for a polling conflict when token validation fails", async () => {
    mockValidateTelegramBotToken.mockResolvedValueOnce({
      valid: false,
      error: "Invalid token",
    });

    await POST(makeRequest({ botToken: "invalid-token" }), { params: mockParams });

    expect(mockProbeTelegramPollingConflict).not.toHaveBeenCalled();
  });

  it("does not probe for a polling conflict when the token is already used by another agent", async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([{ key: "telegram_bot_token:agent-2", value: "encrypted" }]),
      }),
    } as never);
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-2") return "123456:OTHER-secret";
      return null;
    });

    await POST(makeRequest({ botToken: "123456:ABC-token" }), { params: mockParams });

    expect(mockProbeTelegramPollingConflict).not.toHaveBeenCalled();
  });

  it("does not probe for a polling conflict on a self-reconnect of the token this agent already has (#477 layer 1)", async () => {
    // The agent already has this exact token stored → OpenClaw's own worker for
    // THIS deployment is the (only) poller. Probing getUpdates here races our
    // own poller and can false-positive with a 409, wrongly rejecting a
    // legitimate re-connect as an "another deployment" conflict. So skip it.
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([{ key: "telegram_bot_token:agent-1", value: "encrypted" }]),
      }),
    } as never);
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      return null;
    });

    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    expect(mockProbeTelegramPollingConflict).not.toHaveBeenCalled();
    // The re-connect still goes through and rewrites config.
    expect(mockUpdateTelegramChannelConfig).toHaveBeenCalled();
  });

  it("calls recalculateTelegramAllowStores after connecting", async () => {
    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    expect(mockRecalculateTelegramAllowStores).toHaveBeenCalled();
  });

  it("returns 409 when main bot is not configured (and does not mutate channels.telegram)", async () => {
    // updateTelegramChannelConfig must NOT be called on the failure path —
    // any write would trigger an OC restart for nothing (see openclaw-config
    // restart-state integration tests).
    mockHasMainTelegramBot.mockResolvedValueOnce(false);

    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toBe("telegram_not_configured");
    expect(mockUpdateTelegramChannelConfig).not.toHaveBeenCalled();
  });

  it("does not call validateTelegramBotToken when main bot is missing", async () => {
    mockHasMainTelegramBot.mockResolvedValueOnce(false);

    await POST(makeRequest({ botToken: "123456:ABC-token" }), { params: mockParams });

    expect(mockValidateTelegramBotToken).not.toHaveBeenCalled();
  });

  it("does not write audit log when main bot is missing", async () => {
    mockHasMainTelegramBot.mockResolvedValueOnce(false);

    await POST(makeRequest({ botToken: "123456:ABC-token" }), { params: mockParams });

    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("allows personal agent setup even when main bot is missing (first-time bootstrap)", async () => {
    mockHasMainTelegramBot.mockResolvedValueOnce(false);
    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      ...mockAgent,
      isPersonal: true,
    } as any);

    const response = await POST(makeRequest({ botToken: "123456:ABC-token" }), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ botUsername: "test_bot", botId: 123456 });
    expect(mockValidateTelegramBotToken).toHaveBeenCalled();
  });
});

describe("DELETE /api/agents/[agentId]/channels/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminSession);
    mockGetSession.mockResolvedValue(adminSession);
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(mockAgent as any);
  });

  it("removes token, clears account store, patches config, logs audit event", async () => {
    const response = await DELETE(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ success: true });

    expect(deleteSetting).toHaveBeenCalledWith("telegram_bot_token:agent-1");
    expect(deleteSetting).toHaveBeenCalledWith("telegram_bot_username:agent-1");
    expect(deleteSetting).toHaveBeenCalledWith("telegram_conflict_disabled:agent-1");
    expect(mockClearAllowStoreForAccount).toHaveBeenCalledWith("agent-1");
    expect(mockUpdateTelegramChannelConfig).toHaveBeenCalled();
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "channel.deleted",
        resource: "agent:agent-1",
        detail: expect.objectContaining({
          agent: { id: "agent-1", name: "Test Agent" },
          channel: "telegram",
        }),
      })
    );
  });

  it("clears stale channel_links when the last Telegram bot is removed (#476 gap 3)", async () => {
    // db.select().from().where() is mocked to resolve [] → no bot remains.
    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "link-1" }, { id: "link-2" }]),
      }),
    } as any);

    const response = await DELETE(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    expect(response.status).toBe(200);
    expect(db.delete).toHaveBeenCalled();

    // The org-wide wipe count must be visible on the existing channel.deleted
    // audit row (#476 gap 3 hardening) — a normal member disconnecting their
    // own personal bot can trigger this wipe for everyone, so it must be
    // attributable via the audit trail rather than silent.
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "channel.deleted",
        detail: expect.objectContaining({
          channelLinksCleared: 2,
        }),
      })
    );
  });

  it("does not clear channel_links when other Telegram bots remain (#476 gap 3)", async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ key: "telegram_bot_token:other" }]),
      }),
    } as any);

    const response = await DELETE(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    expect(response.status).toBe(200);
    expect(db.delete).not.toHaveBeenCalled();
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "channel.deleted",
        detail: expect.objectContaining({
          channelLinksCleared: 0,
        }),
      })
    );
  });

  it("allows an admin to disconnect a personal agent's bot (#476 gap 2)", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      ...mockAgent,
      isPersonal: true,
      ownerId: "someone-else",
    } as any);

    const response = await DELETE(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    expect(response.status).toBe(200);
    expect(deleteSetting).toHaveBeenCalledWith("telegram_bot_token:agent-1");
  });

  it("allows a personal agent's owner (non-admin) to disconnect their own bot (#476 gap 2)", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      ...mockAgent,
      isPersonal: true,
      ownerId: "user-2",
    } as any);
    mockGetSession.mockResolvedValueOnce({
      user: { id: "user-2", role: "member" },
    });

    const response = await DELETE(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    expect(response.status).toBe(200);
    expect(deleteSetting).toHaveBeenCalledWith("telegram_bot_token:agent-1");
  });

  it("forbids a non-admin who is not the personal agent's owner (#476 gap 2)", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      ...mockAgent,
      isPersonal: true,
      ownerId: "user-2",
    } as any);
    mockGetSession.mockResolvedValueOnce({
      user: { id: "user-3", role: "member" },
    });

    const response = await DELETE(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    expect(response.status).toBe(403);
    expect(deleteSetting).not.toHaveBeenCalled();
  });

  it("forbids a non-admin from disconnecting a shared agent's bot (#476 gap 2)", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce({
      ...mockAgent,
      isPersonal: false,
    } as any);
    mockGetSession.mockResolvedValueOnce({
      user: { id: "user-3", role: "member" },
    });

    const response = await DELETE(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    expect(response.status).toBe(403);
    expect(deleteSetting).not.toHaveBeenCalled();
  });

  it("returns 404 for non-existent agent", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce(undefined as any);

    const response = await DELETE(new NextRequest("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Agent not found");
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await DELETE(new NextRequest("http://localhost"), {
      params: mockParams,
    });

    expect(response.status).toBe(401);
  });
});
