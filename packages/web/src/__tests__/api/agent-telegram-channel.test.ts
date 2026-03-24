import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/api-auth", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockValidateTelegramBotToken = vi.fn();
vi.mock("@/lib/telegram", () => ({
  validateTelegramBotToken: (...args: unknown[]) => mockValidateTelegramBotToken(...args),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const mockConfigGet = vi.fn().mockResolvedValue({ hash: "abc123" });
const mockConfigPatch = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => ({
    config: {
      get: (...args: unknown[]) => mockConfigGet(...args),
      patch: (...args: unknown[]) => mockConfigPatch(...args),
    },
  }),
}));

// regenerateOpenClawConfig should NOT be called from routes
const mockRegenerateOpenClawConfig = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: (...args: unknown[]) => mockRegenerateOpenClawConfig(...args),
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
import { NextResponse } from "next/server";

const adminSession = {
  user: { id: "user-1", email: "admin@test.com", role: "admin" },
};

const mockParams = Promise.resolve({ agentId: "agent-1" });
const mockAgent = { id: "agent-1", name: "Test Agent" };

function makeRequest(body?: object) {
  return new Request("http://localhost/api/agents/agent-1/channels/telegram", {
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

    const response = await GET(new Request("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ configured: false });
  });

  it("returns configured: true with hint when token exists", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce("123456:ABC-some-token-xY9z");

    const response = await GET(new Request("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ configured: true, hint: "xY9z" });
  });

  it("returns 401 when not authenticated", async () => {
    mockRequireAdmin.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await GET(new Request("http://localhost"), {
      params: mockParams,
    });

    expect(response.status).toBe(401);
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
    expect(mockConfigPatch).toHaveBeenCalled();
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();
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
    expect(data.error).toBe("Bot token is required");
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
});

describe("DELETE /api/agents/[agentId]/channels/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminSession);
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(mockAgent as any);
  });

  it("removes token, patches config, logs audit event", async () => {
    const response = await DELETE(new Request("http://localhost"), {
      params: mockParams,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ success: true });

    expect(deleteSetting).toHaveBeenCalledWith("telegram_bot_token:agent-1");
    expect(deleteSetting).toHaveBeenCalledWith("telegram_bot_username:agent-1");
    expect(mockConfigPatch).toHaveBeenCalled();
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();
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

  it("returns 404 for non-existent agent", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValueOnce(undefined as any);

    const response = await DELETE(new Request("http://localhost"), {
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

    const response = await DELETE(new Request("http://localhost"), {
      params: mockParams,
    });

    expect(response.status).toBe(401);
  });
});
