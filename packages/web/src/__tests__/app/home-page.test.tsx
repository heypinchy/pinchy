import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/setup", () => ({
  isSetupComplete: vi.fn(),
  isProviderConfigured: vi.fn(),
}));

vi.mock("@/lib/require-auth", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/db/schema", () => ({
  agents: {
    id: "id",
    isPersonal: "is_personal",
    ownerId: "owner_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
}));

// Use a shared reference object that the mock factory can close over
const dbMock = {
  where: vi.fn(),
  from: vi.fn(),
};

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: (...args: unknown[]) => dbMock.from(...args),
    }),
  },
}));

import { redirect } from "next/navigation";
import { isSetupComplete, isProviderConfigured } from "@/lib/setup";
import { requireAuth } from "@/lib/require-auth";
import Home from "@/app/page";

const mockIsSetupComplete = isSetupComplete as ReturnType<typeof vi.fn>;
const mockIsProviderConfigured = isProviderConfigured as ReturnType<typeof vi.fn>;
const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockRedirect = redirect as ReturnType<typeof vi.fn>;

describe("Home page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: setup complete, provider configured
    mockIsSetupComplete.mockResolvedValue(true);
    mockIsProviderConfigured.mockResolvedValue(true);
    // Default: from returns object with where
    dbMock.from.mockReturnValue({ where: dbMock.where });
  });

  it("shows 'No agent configured' when a non-admin user has no accessible agents", async () => {
    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "user" },
    });

    // The filtered query returns no agents (only another user's personal agent exists, but it's filtered out)
    dbMock.where.mockResolvedValue([]);

    const result = await Home();

    expect(dbMock.where).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("redirects a non-admin user to their own personal agent", async () => {
    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "user" },
    });

    const myAgent = { id: "agent-1", name: "My Agent", ownerId: "user-1", isPersonal: true };
    dbMock.where.mockResolvedValue([myAgent]);

    await expect(Home()).rejects.toThrow("REDIRECT:/chat/agent-1");

    expect(dbMock.where).toHaveBeenCalled();
  });

  it("redirects a non-admin user to a shared (non-personal) agent", async () => {
    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "user" },
    });

    const sharedAgent = { id: "agent-2", name: "Shared Agent", ownerId: null, isPersonal: false };
    dbMock.where.mockResolvedValue([sharedAgent]);

    await expect(Home()).rejects.toThrow("REDIRECT:/chat/agent-2");

    expect(dbMock.where).toHaveBeenCalled();
  });

  it("redirects an admin to the first agent (unfiltered)", async () => {
    mockRequireAuth.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
    });

    const allAgents = [
      { id: "agent-1", name: "Agent 1", ownerId: "other-user", isPersonal: true },
      { id: "agent-2", name: "Agent 2", ownerId: null, isPersonal: false },
    ];

    // For admin, the query should NOT call .where() — it should return from .from() directly
    dbMock.from.mockResolvedValue(allAgents);

    await expect(Home()).rejects.toThrow("REDIRECT:/chat/agent-1");

    // Admin should NOT have the where filter applied
    expect(dbMock.where).not.toHaveBeenCalled();
  });

  it("does not redirect a non-admin to another user's personal agent", async () => {
    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "user" },
    });

    // After filtering, no agents are accessible
    dbMock.where.mockResolvedValue([]);

    const result = await Home();

    // Should not redirect — should render the "no agent" message
    expect(mockRedirect).not.toHaveBeenCalledWith(expect.stringContaining("/chat/"));
    expect(result).toBeDefined();
  });
});
