import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
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

const mockPairingApprove = vi.fn();
const mockConfigGet = vi.fn().mockResolvedValue({ hash: "abc123" });
const mockConfigPatch = vi.fn().mockResolvedValue(undefined);
const mockHasMethod = vi.fn().mockReturnValue(true);

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => ({
    hasMethod: (...args: unknown[]) => mockHasMethod(...args),
    pairing: {
      approve: (...args: unknown[]) => mockPairingApprove(...args),
    },
    config: {
      get: (...args: unknown[]) => mockConfigGet(...args),
      patch: (...args: unknown[]) => mockConfigPatch(...args),
    },
  }),
}));

// ── Import route handlers ────────────────────────────────────────────────

import { GET, POST, DELETE } from "@/app/api/settings/telegram/route";

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
    mockPairingApprove.mockResolvedValue({ userId: "8734062810" });
    mockConfigGet.mockResolvedValue({ hash: "abc123" });
    mockConfigPatch.mockResolvedValue(undefined);
    mockHasMethod.mockReturnValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await POST(makePostRequest({ code: "ABC123" }));
    expect(response.status).toBe(401);
  });

  it("returns 400 when code is missing", async () => {
    const response = await POST(makePostRequest({}));
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toBe("Pairing code is required");
  });

  it("returns 400 when code is not a string", async () => {
    const response = await POST(makePostRequest({ code: 123 }));
    expect(response.status).toBe(400);
  });

  it("approves pairing code, stores link, and updates config", async () => {
    const response = await POST(makePostRequest({ code: "ABC123" }));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ linked: true, telegramUserId: "8734062810" });

    // Verify pairing was approved
    expect(mockPairingApprove).toHaveBeenCalledWith("telegram", "ABC123");

    // Verify link was stored in DB
    expect(mockInsert).toHaveBeenCalled();

    // Verify config was patched with identity link
    expect(mockConfigPatch).toHaveBeenCalledWith(
      expect.stringContaining("telegram:8734062810"),
      "abc123"
    );
  });

  it("returns 501 when pairing method is not available", async () => {
    mockHasMethod.mockReturnValueOnce(false);

    const response = await POST(makePostRequest({ code: "ABC123" }));
    expect(response.status).toBe(501);
  });

  it("returns 400 when pairing fails", async () => {
    mockPairingApprove.mockRejectedValueOnce(new Error("Invalid code"));

    const response = await POST(makePostRequest({ code: "BADCODE" }));
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toBe("Invalid code");
  });
});

describe("DELETE /api/settings/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(userSession);
    mockDelete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    mockConfigGet.mockResolvedValue({ hash: "abc123" });
    mockConfigPatch.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await DELETE();
    expect(response.status).toBe(401);
  });

  it("removes link and patches config", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ linked: false });

    // Verify link was deleted from DB
    expect(mockDelete).toHaveBeenCalled();

    // Verify config was patched to remove identity link
    expect(mockConfigPatch).toHaveBeenCalledWith(
      expect.stringContaining('"user-1":null'),
      "abc123"
    );
  });
});
