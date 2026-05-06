import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi
    .fn()
    .mockResolvedValue({ user: { id: "user-1", email: "user@test.com", role: "member" } });
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockWhere = vi.fn();
vi.mock("@/db", () => ({
  db: {
    query: {
      users: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
    },
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));
mockUpdate.mockReturnValue({ set: mockSet });
mockSet.mockReturnValue({ where: mockWhere });
mockWhere.mockResolvedValue(undefined);

vi.mock("@/db/schema", () => ({
  users: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

const mockSyncUserContextToWorkspaces = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/context-sync", () => ({
  syncUserContextToWorkspaces: (...args: unknown[]) => mockSyncUserContextToWorkspaces(...args),
}));

import { auth } from "@/lib/auth";
import { GET, PUT } from "@/app/api/users/me/context/route";
import { NextRequest } from "next/server";

function makeGetRequest() {
  return new NextRequest("http://localhost/api/users/me/context", { method: "GET" });
}

function makePutRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/users/me/context", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/users/me/context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "user-1", email: "user@test.com", role: "member" },
      expires: "",
    });
  });

  it("should return 401 when unauthenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET(makeGetRequest());
    expect(response.status).toBe(401);
  });

  it("should return user context from database", async () => {
    mockFindFirst.mockResolvedValueOnce({ id: "user-1", context: "My personal context" });

    const response = await GET(makeGetRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBe("My personal context");
  });

  it("should return empty string when context is null", async () => {
    mockFindFirst.mockResolvedValueOnce({ id: "user-1", context: null });

    const response = await GET(makeGetRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBe("");
  });
});

describe("PUT /api/users/me/context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "user-1", email: "user@test.com", role: "member" },
      expires: "",
    });
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
    mockWhere.mockResolvedValue(undefined);
  });

  it("should return 401 when unauthenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await PUT(makePutRequest({ content: "test" }));
    expect(response.status).toBe(401);
  });

  it("should update user context in database", async () => {
    const response = await PUT(makePutRequest({ content: "Updated context" }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(mockSet).toHaveBeenCalledWith({ context: "Updated context" });
  });

  it("should call syncUserContextToWorkspaces", async () => {
    await PUT(makePutRequest({ content: "Updated context" }));

    expect(mockSyncUserContextToWorkspaces).toHaveBeenCalledWith("user-1");
  });

  it("should return 400 when content is not a string", async () => {
    const response = await PUT(makePutRequest({ content: 123 }));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Validation failed");
    expect(data.details.fieldErrors.content).toBeDefined();
  });

  it("should return 400 when content is missing", async () => {
    const response = await PUT(makePutRequest({}));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Validation failed");
    expect(data.details.fieldErrors.content).toBeDefined();
  });
});
