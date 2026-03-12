import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import {
  assertAgentAccess,
  assertAgentWriteAccess,
  getAgentWithAccess,
  effectiveVisibility,
} from "@/lib/agent-access";

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return {
    ...actual,
    activeAgents: actual.activeAgents,
  };
});

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(true),
}));

import { db } from "@/db";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { isEnterprise } from "@/lib/enterprise";

function mockSelectChain(resolvedValue: unknown) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(resolvedValue),
    }),
  } as never);
}

describe("assertAgentAccess", () => {
  it("allows admin access to any agent", () => {
    const agent = { id: "a1", ownerId: "other-user", isPersonal: false };
    expect(() => assertAgentAccess(agent, "admin-user", "admin")).not.toThrow();
  });

  it("allows any user to access shared (non-personal) agents", () => {
    const agent = { id: "a1", ownerId: null, isPersonal: false };
    expect(() => assertAgentAccess(agent, "any-user", "member")).not.toThrow();
  });

  it("allows owner to access their personal agent", () => {
    const agent = { id: "a1", ownerId: "user-1", isPersonal: true };
    expect(() => assertAgentAccess(agent, "user-1", "member")).not.toThrow();
  });

  it("denies non-owner access to personal agent", () => {
    const agent = { id: "a1", ownerId: "user-1", isPersonal: true };
    expect(() => assertAgentAccess(agent, "other-user", "member")).toThrow("Access denied");
  });

  it("allows admin access to personal agent of another user", () => {
    const agent = { id: "a1", ownerId: "user-1", isPersonal: true };
    expect(() => assertAgentAccess(agent, "admin-user", "admin")).not.toThrow();
  });
});

describe("assertAgentWriteAccess", () => {
  it("allows admin to modify any agent", () => {
    const agent = { id: "a1", ownerId: null, isPersonal: false };
    expect(() => assertAgentWriteAccess(agent, "admin-user", "admin")).not.toThrow();
  });

  it("allows admin to modify personal agent of another user", () => {
    const agent = { id: "a1", ownerId: "user-1", isPersonal: true };
    expect(() => assertAgentWriteAccess(agent, "admin-user", "admin")).not.toThrow();
  });

  it("allows owner to modify their personal agent", () => {
    const agent = { id: "a1", ownerId: "user-1", isPersonal: true };
    expect(() => assertAgentWriteAccess(agent, "user-1", "member")).not.toThrow();
  });

  it("denies non-admin user from modifying shared agent", () => {
    const agent = { id: "a1", ownerId: null, isPersonal: false };
    expect(() => assertAgentWriteAccess(agent, "user-1", "member")).toThrow("Access denied");
  });

  it("denies non-owner from modifying personal agent", () => {
    const agent = { id: "a1", ownerId: "user-1", isPersonal: true };
    expect(() => assertAgentWriteAccess(agent, "other-user", "member")).toThrow("Access denied");
  });
});

describe("assertAgentAccess with visibility", () => {
  it("allows admin access regardless of visibility", () => {
    const agent = { id: "a1", ownerId: "other", isPersonal: false, visibility: "restricted" };
    expect(() => assertAgentAccess(agent, "admin-user", "admin")).not.toThrow();
  });

  it("denies member access to restricted agents with no matching groups", () => {
    const agent = { id: "a1", ownerId: "other", isPersonal: false, visibility: "restricted" };
    expect(() => assertAgentAccess(agent, "user-1", "member", [], [])).toThrow("Access denied");
  });

  it("allows member access to 'all' visibility agents", () => {
    const agent = { id: "a1", ownerId: "other", isPersonal: false, visibility: "all" };
    expect(() => assertAgentAccess(agent, "user-1", "member", [], [])).not.toThrow();
  });

  it("allows member access to 'restricted' agent when in matching group", () => {
    const agent = { id: "a1", ownerId: "other", isPersonal: false, visibility: "restricted" };
    expect(() =>
      assertAgentAccess(agent, "user-1", "member", ["g1", "g2"], ["g2", "g3"])
    ).not.toThrow();
  });

  it("denies member access to 'restricted' agent when NOT in matching group", () => {
    const agent = { id: "a1", ownerId: "other", isPersonal: false, visibility: "restricted" };
    expect(() => assertAgentAccess(agent, "user-1", "member", ["g1"], ["g2"])).toThrow(
      "Access denied"
    );
  });

  it("personal agent access is unchanged — owner can access", () => {
    const agent = { id: "a1", ownerId: "user-1", isPersonal: true, visibility: "restricted" };
    expect(() => assertAgentAccess(agent, "user-1", "member", [], [])).not.toThrow();
  });

  it("personal agent access is unchanged — non-owner denied", () => {
    const agent = { id: "a1", ownerId: "other", isPersonal: true, visibility: "restricted" };
    expect(() => assertAgentAccess(agent, "user-1", "member", [], [])).toThrow("Access denied");
  });

  it("defaults to 'all' visibility when undefined (backward compat)", () => {
    const agent = { id: "a1", ownerId: "other", isPersonal: false };
    expect(() => assertAgentAccess(agent, "user-1", "member", [], [])).not.toThrow();
  });
});

describe("getAgentWithAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when agent not found", async () => {
    mockSelectChain([]);

    const result = await getAgentWithAccess("nonexistent-id", "user-1", "member");

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(404);
  });

  it("returns 403 when user has no access", async () => {
    mockSelectChain([{ id: "a1", ownerId: "other-user", isPersonal: true }]);

    const result = await getAgentWithAccess("a1", "user-1", "member");

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns agent when access is granted", async () => {
    const sharedAgent = { id: "a1", ownerId: null, isPersonal: false };
    mockSelectChain([sharedAgent]);

    const result = await getAgentWithAccess("a1", "user-1", "member");

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual(sharedAgent);
  });

  it("returns agent when member is in matching group for 'restricted' visibility", async () => {
    const groupsAgent = { id: "a1", ownerId: null, isPersonal: false, visibility: "restricted" };
    mockSelectChain([groupsAgent]);
    vi.mocked(getUserGroupIds).mockResolvedValueOnce(["g1", "g2"]);
    vi.mocked(getAgentGroupIds).mockResolvedValueOnce(["g2", "g3"]);

    const result = await getAgentWithAccess("a1", "user-1", "member");

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual(groupsAgent);
  });

  it("returns 403 when member is NOT in matching group for 'restricted' visibility", async () => {
    const groupsAgent = { id: "a1", ownerId: null, isPersonal: false, visibility: "restricted" };
    mockSelectChain([groupsAgent]);
    vi.mocked(getUserGroupIds).mockResolvedValueOnce(["g1"]);
    vi.mocked(getAgentGroupIds).mockResolvedValueOnce(["g2"]);

    const result = await getAgentWithAccess("a1", "user-1", "member");

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns 403 for member accessing restricted agent with no groups", async () => {
    const adminOnlyAgent = { id: "a1", ownerId: null, isPersonal: false, visibility: "restricted" };
    mockSelectChain([adminOnlyAgent]);

    const result = await getAgentWithAccess("a1", "user-1", "member");

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("admin bypasses group checks for 'restricted' visibility", async () => {
    const groupsAgent = { id: "a1", ownerId: null, isPersonal: false, visibility: "restricted" };
    mockSelectChain([groupsAgent]);

    const result = await getAgentWithAccess("a1", "admin-user", "admin");

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual(groupsAgent);
    expect(getUserGroupIds).not.toHaveBeenCalled();
    expect(getAgentGroupIds).not.toHaveBeenCalled();
  });

  it("returns 404 for soft-deleted agent (not in active_agents view)", async () => {
    // The activeAgents view returns no results for soft-deleted agents
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const result = await getAgentWithAccess("deleted-agent", "user-1", "member");
    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    expect(res.status).toBe(404);
  });

  it("treats restricted as all when enterprise is false", async () => {
    vi.mocked(isEnterprise).mockResolvedValueOnce(false);
    const agent = { id: "a1", ownerId: null, isPersonal: false, visibility: "restricted" };
    mockSelectChain([agent]);

    const result = await getAgentWithAccess("a1", "user-1", "member");

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual(agent);
  });

  it("skips group loading when enterprise is false", async () => {
    vi.mocked(isEnterprise).mockResolvedValueOnce(false);
    const agent = { id: "a1", ownerId: null, isPersonal: false, visibility: "restricted" };
    mockSelectChain([agent]);

    await getAgentWithAccess("a1", "user-1", "member");

    expect(getUserGroupIds).not.toHaveBeenCalled();
    expect(getAgentGroupIds).not.toHaveBeenCalled();
  });
});

describe("effectiveVisibility", () => {
  it("returns 'all' when not enterprise and visibility is 'restricted'", () => {
    expect(effectiveVisibility("restricted", false)).toBe("all");
  });

  it("returns 'restricted' when enterprise and visibility is 'restricted'", () => {
    expect(effectiveVisibility("restricted", true)).toBe("restricted");
  });

  it("returns 'all' when visibility is 'all' regardless of enterprise", () => {
    expect(effectiveVisibility("all", false)).toBe("all");
    expect(effectiveVisibility("all", true)).toBe("all");
  });

  it("defaults to 'all' when visibility undefined", () => {
    expect(effectiveVisibility(undefined, true)).toBe("all");
    expect(effectiveVisibility(undefined, false)).toBe("all");
  });
});

describe("assertAgentAccess with enterprise=false", () => {
  it("treats restricted as all when enterprise is false", () => {
    const agent = { id: "a1", ownerId: null, isPersonal: false, visibility: "restricted" };
    expect(() => assertAgentAccess(agent, "user-1", "member", [], [], false)).not.toThrow();
  });

  it("still restricts when enterprise is true", () => {
    const agent = { id: "a1", ownerId: null, isPersonal: false, visibility: "restricted" };
    expect(() => assertAgentAccess(agent, "user-1", "member", [], [], true)).toThrow(
      "Access denied"
    );
  });

  it("defaults enterprise to true (backward compat)", () => {
    const agent = { id: "a1", ownerId: null, isPersonal: false, visibility: "restricted" };
    expect(() => assertAgentAccess(agent, "user-1", "member", [], [])).toThrow("Access denied");
  });
});
