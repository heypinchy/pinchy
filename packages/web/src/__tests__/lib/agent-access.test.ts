import { describe, it, expect, vi } from "vitest";
import { NextResponse } from "next/server";
import { assertAgentAccess, assertAgentWriteAccess, getAgentWithAccess } from "@/lib/agent-access";

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

import { db } from "@/db";

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
    expect(() => assertAgentAccess(agent, "any-user", "user")).not.toThrow();
  });

  it("allows owner to access their personal agent", () => {
    const agent = { id: "a1", ownerId: "user-1", isPersonal: true };
    expect(() => assertAgentAccess(agent, "user-1", "user")).not.toThrow();
  });

  it("denies non-owner access to personal agent", () => {
    const agent = { id: "a1", ownerId: "user-1", isPersonal: true };
    expect(() => assertAgentAccess(agent, "other-user", "user")).toThrow("Access denied");
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
    expect(() => assertAgentWriteAccess(agent, "user-1", "user")).not.toThrow();
  });

  it("denies non-admin user from modifying shared agent", () => {
    const agent = { id: "a1", ownerId: null, isPersonal: false };
    expect(() => assertAgentWriteAccess(agent, "user-1", "user")).toThrow("Access denied");
  });

  it("denies non-owner from modifying personal agent", () => {
    const agent = { id: "a1", ownerId: "user-1", isPersonal: true };
    expect(() => assertAgentWriteAccess(agent, "other-user", "user")).toThrow("Access denied");
  });
});

describe("getAgentWithAccess", () => {
  it("returns 404 when agent not found", async () => {
    mockSelectChain([]);

    const result = await getAgentWithAccess("nonexistent-id", "user-1", "user");

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(404);
  });

  it("returns 403 when user has no access", async () => {
    mockSelectChain([{ id: "a1", ownerId: "other-user", isPersonal: true }]);

    const result = await getAgentWithAccess("a1", "user-1", "user");

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns agent when access is granted", async () => {
    const sharedAgent = { id: "a1", ownerId: null, isPersonal: false };
    mockSelectChain([sharedAgent]);

    const result = await getAgentWithAccess("a1", "user-1", "user");

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual(sharedAgent);
  });

  it("returns 404 for soft-deleted agent (not in active_agents view)", async () => {
    // The activeAgents view returns no results for soft-deleted agents
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const result = await getAgentWithAccess("deleted-agent", "user-1", "user");
    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    expect(res.status).toBe(404);
  });
});
