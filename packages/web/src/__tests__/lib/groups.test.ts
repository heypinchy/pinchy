import { describe, it, expect, vi } from "vitest";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return {
    ...actual,
    userGroups: actual.userGroups,
    agentGroups: actual.agentGroups,
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

describe("getUserGroupIds", () => {
  it("returns group IDs for a user", async () => {
    mockSelectChain([{ groupId: "g1" }, { groupId: "g2" }]);

    const result = await getUserGroupIds("user-1");

    expect(result).toEqual(["g1", "g2"]);
  });

  it("returns empty array when user has no groups", async () => {
    mockSelectChain([]);

    const result = await getUserGroupIds("user-1");

    expect(result).toEqual([]);
  });
});

describe("getAgentGroupIds", () => {
  it("returns group IDs for an agent", async () => {
    mockSelectChain([{ groupId: "g3" }, { groupId: "g4" }]);

    const result = await getAgentGroupIds("agent-1");

    expect(result).toEqual(["g3", "g4"]);
  });

  it("returns empty array when agent has no groups", async () => {
    mockSelectChain([]);

    const result = await getAgentGroupIds("agent-1");

    expect(result).toEqual([]);
  });
});
