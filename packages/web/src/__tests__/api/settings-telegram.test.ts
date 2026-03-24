import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockResolvePairingCode = vi.fn();
vi.mock("@/lib/telegram-pairing", () => ({
  resolvePairingCode: (...args: unknown[]) => mockResolvePairingCode(...args),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

const mockFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/db", () => ({
  db: {
    query: {
      channelLinks: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    insert: (...args: unknown[]) => mockInsert(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    eq: vi.fn((_col, val) => ({ eq: val })),
    and: vi.fn((...args) => ({ and: args })),
  };
});

// ── Import route handlers ────────────────────────────────────────────────

import { GET, POST, DELETE } from "@/app/api/settings/telegram/route";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

// ── Helpers ──────────────────────────────────────────────────────────────

const userSession = {
  user: { id: "user-1", email: "user@test.com", role: "member" },
};

function makePostRequest(body: object) {
  return new Request("http://localhost/api/settings/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/settings/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(userSession);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("returns linked status when link exists", async () => {
    mockFindFirst.mockResolvedValueOnce({
      userId: "user-1",
      channel: "telegram",
      channelUserId: "8734062810",
    });

    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ linked: true, channelUserId: "8734062810" });
  });

  it("returns not linked when no link exists", async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);

    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ linked: false, channelUserId: null });
  });
});

describe("POST /api/settings/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(userSession);
    mockInsert.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });
    mockResolvePairingCode.mockReturnValue({ found: true, telegramUserId: "8734062810" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await POST(makePostRequest({ code: "ABC123" }));
    expect(response.status).toBe(401);
  });

  it("returns 400 when code is missing", async () => {
    const response = await POST(makePostRequest({}));
    expect(response.status).toBe(400);
  });

  it("resolves pairing code, stores link, regenerates config", async () => {
    const response = await POST(makePostRequest({ code: "FMSVEN7M" }));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ linked: true, telegramUserId: "8734062810" });

    expect(mockResolvePairingCode).toHaveBeenCalledWith("FMSVEN7M");
    expect(mockInsert).toHaveBeenCalled();
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("returns 400 when pairing code is invalid", async () => {
    mockResolvePairingCode.mockReturnValueOnce({ found: false });

    const response = await POST(makePostRequest({ code: "BADCODE" }));
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("Invalid or expired");
  });
});

describe("DELETE /api/settings/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(userSession);
    mockDelete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await DELETE();
    expect(response.status).toBe(401);
  });

  it("removes link and regenerates config", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ linked: false });

    expect(mockDelete).toHaveBeenCalled();
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });
});
