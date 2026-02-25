import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
vi.mock("@/db", () => ({
  db: {
    query: {
      agents: { findMany: (...args: unknown[]) => mockFindMany(...args) },
      users: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
    },
  },
}));

vi.mock("@/db/schema", () => ({
  agents: { isPersonal: "isPersonal", ownerId: "ownerId" },
  users: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}));

const mockGetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

const mockWriteWorkspaceFileInternal = vi.fn();
vi.mock("@/lib/workspace", () => ({
  writeWorkspaceFileInternal: (...args: unknown[]) => mockWriteWorkspaceFileInternal(...args),
}));

import {
  syncUserContextToWorkspaces,
  syncOrgContextToWorkspaces,
  getContextForAgent,
} from "@/lib/context-sync";

describe("syncUserContextToWorkspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should write user context to USER.md for all personal agents of user", async () => {
    mockFindFirst.mockResolvedValue({ id: "user-1", context: "I am a developer" });
    mockFindMany.mockResolvedValue([
      { id: "agent-1", isPersonal: true, ownerId: "user-1" },
      { id: "agent-2", isPersonal: true, ownerId: "user-1" },
    ]);

    await syncUserContextToWorkspaces("user-1");

    expect(mockWriteWorkspaceFileInternal).toHaveBeenCalledTimes(2);
    expect(mockWriteWorkspaceFileInternal).toHaveBeenCalledWith(
      "agent-1",
      "USER.md",
      "I am a developer"
    );
    expect(mockWriteWorkspaceFileInternal).toHaveBeenCalledWith(
      "agent-2",
      "USER.md",
      "I am a developer"
    );
  });

  it("should handle user with no personal agents", async () => {
    mockFindFirst.mockResolvedValue({ id: "user-1", context: "Some context" });
    mockFindMany.mockResolvedValue([]);

    await syncUserContextToWorkspaces("user-1");

    expect(mockWriteWorkspaceFileInternal).not.toHaveBeenCalled();
  });

  it("should write empty string when user context is null", async () => {
    mockFindFirst.mockResolvedValue({ id: "user-1", context: null });
    mockFindMany.mockResolvedValue([{ id: "agent-1", isPersonal: true, ownerId: "user-1" }]);

    await syncUserContextToWorkspaces("user-1");

    expect(mockWriteWorkspaceFileInternal).toHaveBeenCalledWith("agent-1", "USER.md", "");
  });
});

describe("syncOrgContextToWorkspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should write org context to USER.md for all shared agents", async () => {
    mockGetSetting.mockResolvedValue("We are a Vienna-based team");
    mockFindMany.mockResolvedValue([
      { id: "shared-1", isPersonal: false, ownerId: null },
      { id: "shared-2", isPersonal: false, ownerId: null },
    ]);

    await syncOrgContextToWorkspaces();

    expect(mockGetSetting).toHaveBeenCalledWith("org_context");
    expect(mockWriteWorkspaceFileInternal).toHaveBeenCalledTimes(2);
    expect(mockWriteWorkspaceFileInternal).toHaveBeenCalledWith(
      "shared-1",
      "USER.md",
      "We are a Vienna-based team"
    );
    expect(mockWriteWorkspaceFileInternal).toHaveBeenCalledWith(
      "shared-2",
      "USER.md",
      "We are a Vienna-based team"
    );
  });

  it("should handle no shared agents", async () => {
    mockGetSetting.mockResolvedValue("Some org context");
    mockFindMany.mockResolvedValue([]);

    await syncOrgContextToWorkspaces();

    expect(mockWriteWorkspaceFileInternal).not.toHaveBeenCalled();
  });

  it("should write empty string when org context is null", async () => {
    mockGetSetting.mockResolvedValue(null);
    mockFindMany.mockResolvedValue([{ id: "shared-1", isPersonal: false, ownerId: null }]);

    await syncOrgContextToWorkspaces();

    expect(mockWriteWorkspaceFileInternal).toHaveBeenCalledWith("shared-1", "USER.md", "");
  });
});

describe("getContextForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return user context for personal agent", async () => {
    mockFindFirst.mockResolvedValue({ id: "user-1", context: "My personal context" });

    const result = await getContextForAgent({ isPersonal: true, ownerId: "user-1" });

    expect(result).toBe("My personal context");
  });

  it("should return org context for shared agent", async () => {
    mockGetSetting.mockResolvedValue("Organization context");

    const result = await getContextForAgent({ isPersonal: false, ownerId: null });

    expect(result).toBe("Organization context");
    expect(mockGetSetting).toHaveBeenCalledWith("org_context");
  });

  it("should return empty string when user context is null", async () => {
    mockFindFirst.mockResolvedValue({ id: "user-1", context: null });

    const result = await getContextForAgent({ isPersonal: true, ownerId: "user-1" });

    expect(result).toBe("");
  });

  it("should return empty string when org context is null", async () => {
    mockGetSetting.mockResolvedValue(null);

    const result = await getContextForAgent({ isPersonal: false, ownerId: null });

    expect(result).toBe("");
  });

  it("should return empty string when user is not found", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const result = await getContextForAgent({ isPersonal: true, ownerId: "nonexistent" });

    expect(result).toBe("");
  });
});
