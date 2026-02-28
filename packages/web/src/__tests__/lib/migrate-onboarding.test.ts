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
        findFirst: vi.fn().mockResolvedValue(null),
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

  it("sets allowedTools and writes ONBOARDING.md for Smithers with null context", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "smithers-1", ownerId: "user-1", isPersonal: true, allowedTools: [] },
    ] as any);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "user-1",
      role: "user",
      context: null,
    } as any);

    const { migrateExistingSmithers } = await import("@/lib/migrate-onboarding");
    await migrateExistingSmithers();

    expect(writeWorkspaceFileInternal).toHaveBeenCalledWith(
      "smithers-1",
      "ONBOARDING.md",
      expect.any(String)
    );
    expect(db.update).toHaveBeenCalled();
  });

  it("skips Smithers where user already has context", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "smithers-2", ownerId: "user-2", isPersonal: true, allowedTools: [] },
    ] as any);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "user-2",
      role: "user",
      context: "I am a developer",
    } as any);

    const { migrateExistingSmithers } = await import("@/lib/migrate-onboarding");
    await migrateExistingSmithers();

    expect(writeWorkspaceFileInternal).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("gives admin Smithers both save tools", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "smithers-3", ownerId: "admin-1", isPersonal: true, allowedTools: [] },
    ] as any);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "admin-1",
      role: "admin",
      context: null,
    } as any);

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
  });
});
