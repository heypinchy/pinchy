// Unit tests for the chat page shell (#508 dedup sweep, issue #1087): the
// auth/agent-load/visibility preamble and the generateMetadata title resolver
// that chat/[agentId]/page.tsx, chat/[agentId]/[chatId]/page.tsx, and
// chat/[agentId]/telegram/page.tsx now share instead of each carrying its own
// copy. The page-level tests (chat-page.test.tsx et al.) already cover the
// wiring end to end; this pins the shared functions directly, including the
// generateMetadata title formatting that had no dedicated test before.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockNotFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});

vi.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
}));

const dbSelectMock = {
  where: vi.fn(),
  from: vi.fn(),
};

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: (...args: unknown[]) => dbSelectMock.from(...args),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  activeAgents: { id: "id", name: "name" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

vi.mock("@/lib/require-auth", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/agent-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-access")>();
  return {
    ...actual,
    assertAgentAccess: vi.fn(),
  };
});

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/enterprise", () => ({
  getLicenseState: vi.fn().mockResolvedValue("paid"),
}));

vi.mock("@/lib/avatar", () => ({
  getAgentAvatarSvg: vi.fn(
    (agent: { avatarSeed: string | null; name: string }) =>
      `data:image/svg+xml;utf8,mock-${agent.avatarSeed ?? agent.name}`
  ),
}));

import { requireAuth } from "@/lib/require-auth";
import { assertAgentAccess } from "@/lib/agent-access";
import { loadChatPageAgent, loadChatPageTitle } from "@/lib/chat-page-shell";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockAssertAgentAccess = assertAgentAccess as ReturnType<typeof vi.fn>;

describe("loadChatPageTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.from.mockReturnValue({ where: dbSelectMock.where });
  });

  it("formats the title from the agent's name when found", async () => {
    dbSelectMock.where.mockResolvedValue([{ name: "Smithers" }]);
    const title = await loadChatPageTitle("agent-1", (name) => name ?? "Chat");
    expect(title).toBe("Smithers");
  });

  it("falls back when no agent matches the id", async () => {
    dbSelectMock.where.mockResolvedValue([]);
    const title = await loadChatPageTitle("missing", (name) => name ?? "Chat");
    expect(title).toBe("Chat");
  });

  it("lets the caller vary the found/fallback shape (telegram's suffix)", async () => {
    dbSelectMock.where.mockResolvedValue([{ name: "Smithers" }]);
    const found = await loadChatPageTitle("agent-1", (name) =>
      name ? `${name} on Telegram` : "Telegram chat"
    );
    expect(found).toBe("Smithers on Telegram");

    dbSelectMock.where.mockResolvedValue([]);
    const missing = await loadChatPageTitle("missing", (name) =>
      name ? `${name} on Telegram` : "Telegram chat"
    );
    expect(missing).toBe("Telegram chat");
  });

  it("does not call notFound — generateMetadata must not 404 the page", async () => {
    dbSelectMock.where.mockResolvedValue([]);
    await loadChatPageTitle("missing", (name) => name ?? "Chat");
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});

describe("loadChatPageAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.from.mockReturnValue({ where: dbSelectMock.where });
  });

  it("calls notFound when the agent does not exist", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    dbSelectMock.where.mockResolvedValue([]);

    await expect(loadChatPageAgent("missing")).rejects.toThrow("NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });

  it("calls notFound when assertAgentAccess denies access", async () => {
    const personalAgent = {
      id: "agent-1",
      name: "Personal Agent",
      ownerId: "owner-user",
      isPersonal: true,
    };
    mockRequireAuth.mockResolvedValue({ user: { id: "other-user", role: "member" } });
    dbSelectMock.where.mockResolvedValue([personalAgent]);
    mockAssertAgentAccess.mockImplementation(() => {
      throw new Error("Access denied");
    });

    await expect(loadChatPageAgent("agent-1")).rejects.toThrow("NOT_FOUND");
    expect(mockAssertAgentAccess).toHaveBeenCalledWith(
      personalAgent,
      "other-user",
      "member",
      [],
      [],
      "paid"
    );
  });

  it("returns agent, avatarUrl, and canEdit:true for the owner of their own personal agent", async () => {
    const personalAgent = {
      id: "agent-1",
      name: "Smithers",
      ownerId: "user-1",
      isPersonal: true,
      avatarSeed: "seed-x",
    };
    mockRequireAuth.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    dbSelectMock.where.mockResolvedValue([personalAgent]);
    mockAssertAgentAccess.mockImplementation(() => {});

    const result = await loadChatPageAgent("agent-1");

    expect(result.agent).toBe(personalAgent);
    expect(result.avatarUrl).toBe("data:image/svg+xml;utf8,mock-seed-x");
    expect(result.canEdit).toBe(true);
  });

  it("returns canEdit:false for a member viewing a shared agent", async () => {
    const sharedAgent = { id: "agent-2", name: "Shared Agent", ownerId: null, isPersonal: false };
    mockRequireAuth.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    dbSelectMock.where.mockResolvedValue([sharedAgent]);
    mockAssertAgentAccess.mockImplementation(() => {});

    const result = await loadChatPageAgent("agent-2");

    expect(result.canEdit).toBe(false);
  });

  it("returns canEdit:true for an admin regardless of ownership", async () => {
    const personalAgent = {
      id: "agent-3",
      name: "Someone's Agent",
      ownerId: "other-user",
      isPersonal: true,
    };
    mockRequireAuth.mockResolvedValue({ user: { id: "admin-user", role: "admin" } });
    dbSelectMock.where.mockResolvedValue([personalAgent]);
    mockAssertAgentAccess.mockImplementation(() => {});

    const result = await loadChatPageAgent("agent-3");

    expect(result.canEdit).toBe(true);
  });
});
