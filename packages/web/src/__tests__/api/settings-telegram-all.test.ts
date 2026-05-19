import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/api-auth", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockUpdateTelegramChannelConfig = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({
  updateTelegramChannelConfig: (...args: unknown[]) => mockUpdateTelegramChannelConfig(...args),
}));

const mockClearAllAllowStores = vi.fn();
vi.mock("@/lib/telegram-allow-store", () => ({
  clearAllAllowStores: (...args: unknown[]) => mockClearAllAllowStores(...args),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
vi.mock("@/db", () => ({
  db: {
    delete: vi.fn().mockReturnValue({
      where: (...args: unknown[]) => mockDeleteWhere(...args),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock("@/lib/settings", () => ({
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    eq: vi.fn(),
    like: vi.fn(),
  };
});

import { DELETE } from "@/app/api/settings/telegram/all/route";
import { appendAuditLog } from "@/lib/audit";
import { deleteSetting } from "@/lib/settings";
import { NextResponse } from "next/server";

const adminSession = {
  user: { id: "user-1", email: "admin@test.com", role: "admin" },
};

describe("DELETE /api/settings/telegram/all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminSession);
  });

  it("returns 401 for non-admin", async () => {
    mockRequireAdmin.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await DELETE();
    expect(response.status).toBe(401);
  });

  it("deletes all telegram channel links", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);

    // channelLinks where channel=telegram deleted
    expect(mockDeleteWhere).toHaveBeenCalled();
  });

  it("deletes bot token settings for all agents", async () => {
    // Mock agents with telegram bots
    const { db } = await import("@/db");
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { key: "telegram_bot_token:agent-1", value: "tok1" },
          { key: "telegram_bot_token:agent-2", value: "tok2" },
        ]),
      }),
    } as never);

    const response = await DELETE();
    expect(response.status).toBe(200);

    expect(deleteSetting).toHaveBeenCalledWith("telegram_bot_token:agent-1");
    expect(deleteSetting).toHaveBeenCalledWith("telegram_bot_username:agent-1");
    expect(deleteSetting).toHaveBeenCalledWith("telegram_bot_token:agent-2");
    expect(deleteSetting).toHaveBeenCalledWith("telegram_bot_username:agent-2");
  });

  it("regenerates OpenClaw config", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);

    expect(mockUpdateTelegramChannelConfig).toHaveBeenCalled();
  });

  it("logs audit event", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "channel.deleted",
        detail: expect.objectContaining({
          channel: "telegram",
          scope: "all",
        }),
      })
    );
  });
});
