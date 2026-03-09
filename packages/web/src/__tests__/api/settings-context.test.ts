import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi
    .fn()
    .mockResolvedValue({ user: { id: "admin-1", email: "admin@test.com", role: "admin" } });
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
}));

const mockSyncOrgContextToWorkspaces = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/context-sync", () => ({
  syncOrgContextToWorkspaces: (...args: unknown[]) => mockSyncOrgContextToWorkspaces(...args),
}));

import { auth } from "@/lib/auth";
import { GET, PUT } from "@/app/api/settings/context/route";
import { NextRequest } from "next/server";

function makeGetRequest() {
  return new NextRequest("http://localhost/api/settings/context", { method: "GET" });
}

function makePutRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/settings/context", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/settings/context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", role: "admin" },
      expires: "",
    });
  });

  it("should return 401 when unauthenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET(makeGetRequest());
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", email: "user@test.com", role: "member" },
      expires: "",
    });

    const response = await GET(makeGetRequest());
    expect(response.status).toBe(403);
  });

  it("should return org context from settings", async () => {
    mockGetSetting.mockResolvedValueOnce("Organization context");

    const response = await GET(makeGetRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBe("Organization context");
    expect(mockGetSetting).toHaveBeenCalledWith("org_context");
  });

  it("should return empty string when not set", async () => {
    mockGetSetting.mockResolvedValueOnce(null);

    const response = await GET(makeGetRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBe("");
  });
});

describe("PUT /api/settings/context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", role: "admin" },
      expires: "",
    });
  });

  it("should return 401 when unauthenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await PUT(makePutRequest({ content: "test" }));
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", email: "user@test.com", role: "member" },
      expires: "",
    });

    const response = await PUT(makePutRequest({ content: "test" }));
    expect(response.status).toBe(403);
  });

  it("should save org context via setSetting", async () => {
    const response = await PUT(makePutRequest({ content: "New org context" }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(mockSetSetting).toHaveBeenCalledWith("org_context", "New org context");
  });

  it("should call syncOrgContextToWorkspaces", async () => {
    await PUT(makePutRequest({ content: "New org context" }));

    expect(mockSyncOrgContextToWorkspaces).toHaveBeenCalled();
  });

  it("should return 400 when content is not a string", async () => {
    const response = await PUT(makePutRequest({ content: 42 }));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("content must be a string");
  });

  it("should return 400 when content is missing", async () => {
    const response = await PUT(makePutRequest({}));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("content must be a string");
  });
});
