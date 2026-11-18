import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      agents: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      users: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  },
}));

vi.mock("@/lib/workspace", () => ({
  writeWorkspaceFileInternal: vi.fn(),
}));

vi.mock("@/lib/onboarding-prompt", () => ({
  getOnboardingPrompt: vi.fn().mockReturnValue("## Onboarding\n\nTest"),
}));

import { db } from "@/db";
import { writeWorkspaceFileInternal } from "@/lib/workspace";

describe("migrateExistingSmithers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets allowedTools and writes onboarding prompt to USER.md for Smithers with null context", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "smithers-1", ownerId: "user-1", isPersonal: true, allowedTools: [] },
    ] as any);
    vi.mocked(db.query.users.findMany).mockResolvedValue([
      { id: "user-1", role: "member", context: null },
    ] as any);

    const { migrateExistingSmithers } = await import("@/lib/migrate-onboarding");
    await migrateExistingSmithers();

    expect(writeWorkspaceFileInternal).toHaveBeenCalledWith(
      "smithers-1",
      "USER.md",
      expect.any(String)
    );
    expect(db.update).toHaveBeenCalled();
  });

  it("skips Smithers where user already has context", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "smithers-2", ownerId: "user-2", isPersonal: true, allowedTools: [] },
    ] as any);
    vi.mocked(db.query.users.findMany).mockResolvedValue([
      { id: "user-2", role: "member", context: "I am a developer" },
    ] as any);

    const { migrateExistingSmithers } = await import("@/lib/migrate-onboarding");
    await migrateExistingSmithers();

    expect(writeWorkspaceFileInternal).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("gives admin Smithers both save tools", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "smithers-3", ownerId: "admin-1", isPersonal: true, allowedTools: [] },
    ] as any);
    vi.mocked(db.query.users.findMany).mockResolvedValue([
      { id: "admin-1", role: "admin", context: null },
    ] as any);

    const { migrateExistingSmithers } = await import("@/lib/migrate-onboarding");
    await migrateExistingSmithers();

    const setFn = vi.mocked(db.update("" as never).set);
    expect(setFn).toHaveBeenCalledWith({
      allowedTools: ["pinchy_save_user_context", "pinchy_save_org_context"],
    });
  });

  it("handles no personal agents gracefully", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([]);

    const { migrateExistingSmithers } = await import("@/lib/migrate-onboarding");
    await expect(migrateExistingSmithers()).resolves.not.toThrow();

    expect(writeWorkspaceFileInternal).not.toHaveBeenCalled();
    // No owner ids to look up when there are no personal agents.
    expect(db.query.users.findMany).not.toHaveBeenCalled();
  });

  it("resolves every Smithers owner in a single batched query, not one findFirst per agent", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "smithers-1", ownerId: "user-1", isPersonal: true, allowedTools: [] },
      { id: "smithers-2", ownerId: "user-2", isPersonal: true, allowedTools: [] },
      { id: "smithers-3", ownerId: "user-1", isPersonal: true, allowedTools: [] }, // shared owner
    ] as any);
    vi.mocked(db.query.users.findMany).mockResolvedValue([
      { id: "user-1", role: "member", context: null },
      { id: "user-2", role: "member", context: "already onboarded" },
    ] as any);

    const { migrateExistingSmithers } = await import("@/lib/migrate-onboarding");
    await migrateExistingSmithers();

    // One batched lookup covering every owner, regardless of agent count.
    expect(db.query.users.findMany).toHaveBeenCalledTimes(1);
    // user-1 has null context (write); user-2 already has context (skip).
    expect(writeWorkspaceFileInternal).toHaveBeenCalledWith(
      "smithers-1",
      "USER.md",
      expect.any(String)
    );
    expect(writeWorkspaceFileInternal).toHaveBeenCalledWith(
      "smithers-3",
      "USER.md",
      expect.any(String)
    );
    expect(writeWorkspaceFileInternal).not.toHaveBeenCalledWith(
      "smithers-2",
      "USER.md",
      expect.any(String)
    );
  });
});
