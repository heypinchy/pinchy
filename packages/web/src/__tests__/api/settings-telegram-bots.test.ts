import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockGetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  },
}));

import { GET } from "@/app/api/settings/telegram/bots/route";
import { db } from "@/db";

const adminSession = {
  user: { id: "user-1", email: "admin@test.com", role: "admin" },
};

const memberSession = {
  user: { id: "user-2", email: "member@test.com", role: "member" },
};

describe("GET /api/settings/telegram/bots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockGetSetting.mockResolvedValue(null);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("returns empty array when no agents have bots", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValueOnce([
      { id: "a1", name: "Smithers", isPersonal: false, visibility: "all" },
    ] as any);
    mockGetSetting.mockResolvedValue(null);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.bots).toEqual([]);
  });

  it("returns bots for agents with configured telegram", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValueOnce([
      { id: "a1", name: "Smithers", isPersonal: false, visibility: "all" },
      { id: "a2", name: "Support", isPersonal: false, visibility: "all" },
    ] as any);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_username:a1") return "acme_smithers_bot";
      return null;
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.bots).toEqual([
      { agentId: "a1", agentName: "Smithers", botUsername: "acme_smithers_bot" },
    ]);
  });

  it("excludes personal agents of other users for members", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    vi.mocked(db.query.agents.findMany).mockResolvedValueOnce([
      { id: "a1", name: "Smithers", isPersonal: false, visibility: "all" },
      { id: "a2", name: "My Bot", isPersonal: true, ownerId: "user-1" },
    ] as any);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_username:a1") return "acme_smithers_bot";
      if (key === "telegram_bot_username:a2") return "my_bot";
      return null;
    });

    const response = await GET();
    const data = await response.json();

    expect(data.bots).toEqual([
      { agentId: "a1", agentName: "Smithers", botUsername: "acme_smithers_bot" },
    ]);
  });

  it("includes personal agents of the current user", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    vi.mocked(db.query.agents.findMany).mockResolvedValueOnce([
      { id: "a2", name: "My Bot", isPersonal: true, ownerId: "user-2" },
    ] as any);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_username:a2") return "my_bot";
      return null;
    });

    const response = await GET();
    const data = await response.json();

    expect(data.bots).toEqual([{ agentId: "a2", agentName: "My Bot", botUsername: "my_bot" }]);
  });
});
