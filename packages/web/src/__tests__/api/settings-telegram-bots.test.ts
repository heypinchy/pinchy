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

const mockGetOrgPairingSmithers = vi.fn();
vi.mock("@/lib/pairing-candidates", () => ({
  getOrgPairingSmithers: (...args: unknown[]) => mockGetOrgPairingSmithers(...args),
  PAIRING_PUBLIC_AGENT_ID: "pinchy-pairing-bot",
  PAIRING_PUBLIC_AGENT_NAME: "Smithers",
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
    mockGetOrgPairingSmithers.mockResolvedValue([]);
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

    await GET();

    expect(mockGetVisibleAgents).toHaveBeenCalledWith("user-2", "member");
  });

  it("does not return a restricted shared agent's bot to a member without group access", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
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
    expect(data.bots.some((b: { botUsername: string }) => b.botUsername === "hr_bot")).toBe(false);
  });

  it("does not return another user's personal agent's bot to a member (real id/name not leaked)", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
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
    // Member's own Smithers visible
    expect(
      data.bots.some((b: { botUsername: string }) => b.botUsername === "self_smithers_bot")
    ).toBe(true);
    // Admin's real agentId/agentName must never appear in the response
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("a-admin");
    expect(serialized).not.toContain("OtherUserAgent");
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

  it("includes anonymized org Smithers bot for members without their own pair-able bot", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    // Member has no visible agent with a Telegram bot
    mockGetVisibleAgents.mockResolvedValueOnce([
      { id: "member-smithers", name: "Smithers", isPersonal: true, ownerId: "user-2" },
    ]);
    // Org Smithers (admin's) provides the org-wide pairing bot, anonymized
    mockGetOrgPairingSmithers.mockResolvedValueOnce([
      {
        realId: "admin-smithers-real-uuid",
        publicId: "pinchy-pairing-bot",
        publicName: "Smithers",
        isPersonal: true,
      },
    ]);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_username:admin-smithers-real-uuid") return "acme_smithers_bot";
      return null;
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.bots).toHaveLength(1);
    expect(data.bots[0].agentId).toBe("pinchy-pairing-bot");
    expect(data.bots[0].agentName).toBe("Smithers");
    expect(data.bots[0].botUsername).toBe("acme_smithers_bot");
    expect(data.bots[0].isPersonal).toBe(true);
    // Real admin agent UUID never appears
    expect(JSON.stringify(data)).not.toContain("admin-smithers-real-uuid");
  });

  it("passes visible agent ids to getOrgPairingSmithers to dedupe", async () => {
    mockGetVisibleAgents.mockResolvedValueOnce([
      { id: "a1", name: "Smithers", isPersonal: true, ownerId: "user-1" },
      { id: "a2", name: "Support", isPersonal: false, visibility: "all" },
    ]);

    await GET();

    expect(mockGetOrgPairingSmithers).toHaveBeenCalledWith(new Set(["a1", "a2"]));
  });

  it("fetches bot usernames in parallel (single Promise.all, not sequential)", async () => {
    mockGetVisibleAgents.mockResolvedValueOnce([
      { id: "a1", name: "A", isPersonal: false, visibility: "all" },
      { id: "a2", name: "B", isPersonal: false, visibility: "all" },
      { id: "a3", name: "C", isPersonal: false, visibility: "all" },
    ]);

    const callOrder: string[] = [];
    mockGetSetting.mockImplementation(async (key: string) => {
      callOrder.push(`start:${key}`);
      await new Promise((r) => setTimeout(r, 5));
      callOrder.push(`end:${key}`);
      return null;
    });

    await GET();

    // All three should start before any ends — proves parallel execution
    const firstThree = callOrder.slice(0, 3);
    expect(firstThree.every((c) => c.startsWith("start:"))).toBe(true);
  });
});
