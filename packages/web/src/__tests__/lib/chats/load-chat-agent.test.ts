/**
 * Unit tests for the chat-page preamble the #1087 sweep single-sourced out of
 * `/chat/[agentId]`, its `[chatId]` child and the read-only `telegram` mirror.
 *
 * The three page components are server components the route suites exercise
 * through their rendered output, so what they pin is "this page rendered".
 * The decisions that live here are different ones and none of them is visible
 * in that output: that a denied read answers 404 rather than 403 (a member
 * must not learn a hidden agent exists), that `canEdit` is the same predicate
 * the write routes enforce rather than a second spelling of it, and that the
 * group lookups are skipped when they cannot change the answer.
 *
 * `@/lib/agent-access` stays REAL on purpose — the visibility facts these
 * cases rest on are the point, and mocking `assertAgentAccess` would turn
 * every access assertion below into a restatement of the mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFoundMock() }));

const whereMock = vi.fn();
vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ where: (...args: unknown[]) => whereMock(...args) }) }) },
}));

vi.mock("@/lib/require-auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/enterprise", () => ({ getLicenseState: vi.fn().mockResolvedValue("paid") }));
vi.mock("@/lib/avatar", () => ({
  getAgentAvatarSvg: vi.fn(
    (agent: { avatarSeed: string | null; name: string }) =>
      `data:image/svg+xml;utf8,${agent.avatarSeed ?? agent.name}`
  ),
}));

import { requireAuth } from "@/lib/require-auth";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { getLicenseState } from "@/lib/enterprise";
import { loadChatAgentName, loadChatPageAgent } from "@/lib/chats/load-chat-agent";

const agentRow = (overrides: Record<string, unknown> = {}) => ({
  id: "agent-1",
  name: "Smithers",
  ownerId: null,
  isPersonal: false,
  visibility: "all",
  avatarSeed: "seed-1",
  ...overrides,
});

/** The single `.where(...)` every load in this module ends with. */
function dbReturns(rows: unknown[]) {
  whereMock.mockResolvedValue(rows);
}

function signedInAs(id: string, role: string) {
  vi.mocked(requireAuth).mockResolvedValue({ user: { id, role } } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserGroupIds).mockResolvedValue([]);
  vi.mocked(getAgentGroupIds).mockResolvedValue([]);
  vi.mocked(getLicenseState).mockResolvedValue("paid");
});

describe("loadChatAgentName", () => {
  it("returns the agent's name for the tab title", async () => {
    dbReturns([{ name: "Smithers" }]);
    await expect(loadChatAgentName("agent-1")).resolves.toBe("Smithers");
  });

  it("returns undefined for an unknown agent instead of 404-ing", async () => {
    // generateMetadata has no way to answer 404; the callers fall back to a
    // generic title. A notFound() here would take the page down with it.
    dbReturns([]);
    await expect(loadChatAgentName("ghost")).resolves.toBeUndefined();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("does not require a session — the name is not the secret, the chat is", async () => {
    dbReturns([{ name: "Smithers" }]);
    await loadChatAgentName("agent-1");
    expect(requireAuth).not.toHaveBeenCalled();
  });
});

describe("loadChatPageAgent", () => {
  it("answers 404 when no agent matches the id", async () => {
    signedInAs("user-1", "member");
    dbReturns([]);
    await expect(loadChatPageAgent("ghost")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("answers 404 — not 403 — when the read gate denies access", async () => {
    // A member opening someone else's personal agent must not learn it exists.
    signedInAs("other-user", "member");
    dbReturns([agentRow({ isPersonal: true, ownerId: "owner-user" })]);
    await expect(loadChatPageAgent("agent-1")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("returns the agent and its avatar for a permitted read", async () => {
    signedInAs("user-1", "member");
    dbReturns([agentRow()]);

    const { agent, userId, userRole, avatarUrl } = await loadChatPageAgent("agent-1");

    expect(agent.id).toBe("agent-1");
    expect(userId).toBe("user-1");
    expect(userRole).toBe("member");
    expect(avatarUrl).toBe("data:image/svg+xml;utf8,seed-1");
  });

  it("grants canEdit to the owner of a personal agent", async () => {
    signedInAs("user-1", "member");
    dbReturns([agentRow({ isPersonal: true, ownerId: "user-1" })]);
    await expect(loadChatPageAgent("agent-1")).resolves.toMatchObject({ canEdit: true });
  });

  it("grants canEdit to an admin on a shared agent", async () => {
    signedInAs("admin-user", "admin");
    dbReturns([agentRow()]);
    await expect(loadChatPageAgent("agent-1")).resolves.toMatchObject({ canEdit: true });
  });

  it("withholds canEdit from a member on a shared agent they can read", async () => {
    // The UI must not offer an edit the write routes refuse.
    signedInAs("user-1", "member");
    dbReturns([agentRow()]);
    await expect(loadChatPageAgent("agent-1")).resolves.toMatchObject({ canEdit: false });
  });

  it("lets a member into a restricted agent they share a group with", async () => {
    signedInAs("user-1", "member");
    dbReturns([agentRow({ visibility: "restricted" })]);
    vi.mocked(getUserGroupIds).mockResolvedValue(["group-a"]);
    vi.mocked(getAgentGroupIds).mockResolvedValue(["group-a"]);

    await expect(loadChatPageAgent("agent-1")).resolves.toMatchObject({ canEdit: false });
  });

  it("keeps a member out of a restricted agent they share no group with", async () => {
    signedInAs("user-1", "member");
    dbReturns([agentRow({ visibility: "restricted" })]);
    vi.mocked(getUserGroupIds).mockResolvedValue(["group-a"]);
    vi.mocked(getAgentGroupIds).mockResolvedValue(["group-b"]);

    await expect(loadChatPageAgent("agent-1")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("skips both group lookups when they cannot change the answer", async () => {
    // The common case is one query. This is the reason the preamble reads the
    // way it does, and nothing else in the suite would notice it regressing.
    signedInAs("user-1", "member");
    dbReturns([agentRow({ visibility: "all" })]);

    await loadChatPageAgent("agent-1");

    expect(getUserGroupIds).not.toHaveBeenCalled();
    expect(getAgentGroupIds).not.toHaveBeenCalled();
  });
});
