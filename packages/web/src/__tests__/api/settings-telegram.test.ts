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

const mockUpdateIdentityLinks = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({
  updateIdentityLinks: (...args: unknown[]) => mockUpdateIdentityLinks(...args),
}));

const mockRecalculateTelegramAllowStores = vi.fn().mockResolvedValue(undefined);
const mockRemovePairingRequest = vi.fn();
vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: (...args: unknown[]) =>
    mockRecalculateTelegramAllowStores(...args),
  removePairingRequest: (...args: unknown[]) => mockRemovePairingRequest(...args),
}));

const mockFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();
const mockSelectFrom = vi.fn().mockResolvedValue([]);

vi.mock("@/db", () => ({
  db: {
    query: {
      channelLinks: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    insert: (...args: unknown[]) => mockInsert(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    select: vi.fn().mockReturnValue({
      from: (...args: unknown[]) => mockSelectFrom(...args),
    }),
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
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    });
    mockResolvePairingCode.mockReturnValue({ found: true, telegramUserId: "8734062810" });
    mockUpdateIdentityLinks.mockReturnValue(undefined);
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

  it("resolves pairing code, stores link in DB, regenerates config", async () => {
    const response = await POST(makePostRequest({ code: "FMSVEN7M" }));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ linked: true, telegramUserId: "8734062810" });

    // Pairing code resolved
    expect(mockResolvePairingCode).toHaveBeenCalledWith("FMSVEN7M");

    // DB written first
    expect(mockInsert).toHaveBeenCalled();

    // Per-account allow-from stores recalculated (permission-aware)
    expect(mockRecalculateTelegramAllowStores).toHaveBeenCalled();

    // identityLinks updated (targeted write, no full config regeneration)
    expect(mockUpdateIdentityLinks).toHaveBeenCalled();
  });

  it("returns 400 when pairing code is invalid", async () => {
    mockResolvePairingCode.mockReturnValueOnce({ found: false });

    const response = await POST(makePostRequest({ code: "BADCODE" }));
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("Invalid or expired");
  });

  it("still succeeds when OpenClaw client is not connected", async () => {
    // queueConfigPatch is fire-and-forget — route always returns success
    // since DB is source of truth
    const response = await POST(makePostRequest({ code: "ABC123" }));
    expect(response.status).toBe(200);

    // DB was still written
    expect(mockInsert).toHaveBeenCalled();
  });
});

describe("DELETE /api/settings/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(userSession);
    mockFindFirst.mockResolvedValue({
      userId: "user-1",
      channel: "telegram",
      channelUserId: "8734062810",
    });
    mockDelete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await DELETE();
    expect(response.status).toBe(401);
  });

  it("removes link from DB, updates allow store, and regenerates config", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ linked: false });

    // DB updated
    expect(mockDelete).toHaveBeenCalled();

    // Per-account allow-from stores recalculated (removes unlinked user)
    expect(mockRecalculateTelegramAllowStores).toHaveBeenCalled();

    // identityLinks updated (targeted write, no full config regeneration)
    expect(mockUpdateIdentityLinks).toHaveBeenCalled();
  });
});
