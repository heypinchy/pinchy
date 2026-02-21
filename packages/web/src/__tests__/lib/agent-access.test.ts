import { describe, it, expect, vi } from "vitest";
import { NextResponse } from "next/server";
import { assertAgentAccess, getAgentWithAccess } from "@/lib/agent-access";

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findFirst: vi.fn(),
      },
    },
  },
}));

import { db } from "@/db";

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

describe("getAgentWithAccess", () => {
  const mockFindFirst = db.query.agents.findFirst as ReturnType<typeof vi.fn>;

  it("returns 404 when agent not found", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const result = await getAgentWithAccess("nonexistent-id", "user-1", "user");

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(404);
  });

  it("returns 403 when user has no access", async () => {
    mockFindFirst.mockResolvedValue({
      id: "a1",
      ownerId: "other-user",
      isPersonal: true,
    });

    const result = await getAgentWithAccess("a1", "user-1", "user");

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns agent when access is granted", async () => {
    const sharedAgent = { id: "a1", ownerId: null, isPersonal: false };
    mockFindFirst.mockResolvedValue(sharedAgent);

    const result = await getAgentWithAccess("a1", "user-1", "user");

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual(sharedAgent);
  });
});
