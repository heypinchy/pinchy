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

const mockGetVisibleAgents = vi.fn();
vi.mock("@/lib/visible-agents", () => ({
  getVisibleAgents: (...args: unknown[]) => mockGetVisibleAgents(...args),
}));

import { GET } from "@/app/api/settings/telegram/bots/route";

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
    mockGetVisibleAgents.mockResolvedValue([]);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("returns empty array when no agents have bots", async () => {
    mockGetVisibleAgents.mockResolvedValueOnce([
      { id: "a1", name: "Smithers", isPersonal: false, visibility: "all" },
    ]);
    mockGetSetting.mockResolvedValue(null);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.bots).toEqual([]);
  });

  it("returns bots for agents with configured telegram", async () => {
    mockGetVisibleAgents.mockResolvedValueOnce([
      { id: "a1", name: "Smithers", isPersonal: false, visibility: "all" },
      { id: "a2", name: "Support", isPersonal: false, visibility: "all" },
    ]);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_username:a1") return "acme_smithers_bot";
      return null;
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.bots).toEqual([
      { agentId: "a1", agentName: "Smithers", botUsername: "acme_smithers_bot", isPersonal: false },
    ]);
  });

  it("returns personal (Smithers) bots first for pairing priority", async () => {
    mockGetVisibleAgents.mockResolvedValueOnce([
      { id: "a1", name: "Silvia", isPersonal: false, visibility: "all" },
      { id: "a2", name: "Smithers", isPersonal: true, ownerId: "user-1" },
    ]);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_username:a1") return "silvia_bot";
      if (key === "telegram_bot_username:a2") return "smithers_bot";
      return null;
    });

    const response = await GET();
    const data = await response.json();

    expect(data.bots[0].botUsername).toBe("smithers_bot");
    expect(data.bots[0].isPersonal).toBe(true);
  });

  it("calls getVisibleAgents with the session user id and role for filtering", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    mockGetVisibleAgents.mockResolvedValueOnce([]);

    await GET();

    expect(mockGetVisibleAgents).toHaveBeenCalledWith("user-2", "member");
  });

  it("does not return a restricted shared agent's bot to a member without group access", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    // getVisibleAgents already filters by RBAC: the restricted agent (a2) is excluded.
    mockGetVisibleAgents.mockResolvedValueOnce([
      { id: "a1", name: "Smithers", isPersonal: false, visibility: "all" },
    ]);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_username:a1") return "acme_smithers_bot";
      if (key === "telegram_bot_username:a2") return "hr_bot";
      return null;
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.bots).toHaveLength(1);
    expect(data.bots[0].botUsername).toBe("acme_smithers_bot");
    expect(data.bots).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ botUsername: "hr_bot" })])
    );
  });

  it("does not return another user's personal agent's bot to a member", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    // Member sees only their own personal agent — admin's personal Smithers (a-admin) is filtered out by getVisibleAgents.
    mockGetVisibleAgents.mockResolvedValueOnce([
      { id: "a-self", name: "Smithers", isPersonal: true, ownerId: "user-2" },
    ]);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_username:a-self") return "self_smithers_bot";
      if (key === "telegram_bot_username:a-admin") return "admin_smithers_bot";
      return null;
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.bots).toHaveLength(1);
    expect(data.bots[0].botUsername).toBe("self_smithers_bot");
    expect(data.bots).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ botUsername: "admin_smithers_bot" })])
    );
  });

  it("returns all bots to an admin", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockGetVisibleAgents.mockResolvedValueOnce([
      { id: "a1", name: "Smithers", isPersonal: true, ownerId: "user-1" },
      { id: "a2", name: "Support", isPersonal: false, visibility: "all" },
      { id: "a3", name: "HR", isPersonal: false, visibility: "restricted" },
    ]);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_username:a1") return "smithers_bot";
      if (key === "telegram_bot_username:a2") return "support_bot";
      if (key === "telegram_bot_username:a3") return "hr_bot";
      return null;
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.bots).toHaveLength(3);
    expect(data.bots.map((b: { botUsername: string }) => b.botUsername).sort()).toEqual([
      "hr_bot",
      "smithers_bot",
      "support_bot",
    ]);
  });
});
