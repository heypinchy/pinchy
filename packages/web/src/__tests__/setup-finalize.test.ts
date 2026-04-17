import { describe, it, expect, vi, beforeEach } from "vitest";

const { findFirstMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
}));

vi.mock("@/lib/settings-timezone");

vi.mock("@/db", () => ({
  db: {
    query: {
      users: { findFirst: findFirstMock },
      agents: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([
            { id: "agent-1", name: "Smithers", model: "test/model", createdAt: new Date() },
          ]),
      }),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      signUpEmail: vi.fn().mockResolvedValue({
        user: { id: "user-1", email: "a@x.com" },
      }),
    },
  },
}));

vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  writeWorkspaceFileInternal: vi.fn(),
  writeIdentityFile: vi.fn(),
}));

vi.mock("@/lib/context-sync", () => ({
  getContextForAgent: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/lib/smithers-soul", () => ({
  SMITHERS_SOUL_MD: "# Smithers",
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/providers", () => ({
  PROVIDERS: {},
}));

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn().mockResolvedValue("ollama-local/test-model"),
}));

import { createAdmin } from "@/lib/setup";
import * as tz from "@/lib/settings-timezone";

describe("createAdmin — timezone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirstMock.mockResolvedValue(undefined);
    vi.mocked(tz.setOrgTimezone).mockResolvedValue(undefined);
  });

  it("persists browser timezone as org timezone", async () => {
    await createAdmin("A", "a@x.com", "password123", "Europe/Vienna");
    expect(tz.setOrgTimezone).toHaveBeenCalledWith("Europe/Vienna");
  });

  it("falls back to UTC when browser timezone is missing", async () => {
    await createAdmin("A", "a@x.com", "password123", undefined);
    expect(tz.setOrgTimezone).toHaveBeenCalledWith("UTC");
  });
});
