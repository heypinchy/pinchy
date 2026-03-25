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

const mockConfigGet = vi.fn().mockResolvedValue({ hash: "abc123" });
const mockConfigPatch = vi.fn().mockResolvedValue(undefined);

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => ({
    config: {
      get: (...args: unknown[]) => mockConfigGet(...args),
      patch: (...args: unknown[]) => mockConfigPatch(...args),
    },
  }),
}));

// regenerateOpenClawConfig should NOT be called from routes
const mockRegenerateOpenClawConfig = vi.fn();
const mockQueueConfigPatch = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: (...args: unknown[]) => mockRegenerateOpenClawConfig(...args),
  queueConfigPatch: (...args: unknown[]) => mockQueueConfigPatch(...args),
}));

const mockFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();
const mockSelectWhere = vi.fn();

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
      from: vi.fn().mockReturnValue({
        where: (...args: unknown[]) => mockSelectWhere(...args),
      }),
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
      values: vi.fn().mockResolvedValue(undefined),
    });
    mockResolvePairingCode.mockReturnValue({ found: true, telegramUserId: "8734062810" });
    mockConfigGet.mockResolvedValue({ hash: "abc123" });
    mockConfigPatch.mockResolvedValue(undefined);
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

  it("resolves pairing code, stores link in DB, fires config.patch", async () => {
    const response = await POST(makePostRequest({ code: "FMSVEN7M" }));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ linked: true, telegramUserId: "8734062810" });

    // Pairing code resolved
    expect(mockResolvePairingCode).toHaveBeenCalledWith("FMSVEN7M");

    // DB written first
    expect(mockInsert).toHaveBeenCalled();

    // queueConfigPatch fired for live activation
    expect(mockQueueConfigPatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channels: { telegram: { allowFrom: ["8734062810"] } },
        session: { identityLinks: { "user-1": ["telegram:8734062810"] } },
      })
    );

    // regenerateOpenClawConfig NOT called (only at startup, not from routes)
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();
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
    mockDelete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    mockFindFirst.mockResolvedValue({
      userId: "user-1",
      channel: "telegram",
      channelUserId: "8734062810",
    });
    // After delete, no remaining links
    mockSelectWhere.mockResolvedValue([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await DELETE();
    expect(response.status).toBe(401);
  });

  it("removes link from DB and fires queueConfigPatch", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ linked: false });

    // DB updated
    expect(mockDelete).toHaveBeenCalled();

    // queueConfigPatch fired with empty allowFrom (no remaining links)
    expect(mockQueueConfigPatch).toHaveBeenCalledWith(expect.anything(), {
      channels: { telegram: { allowFrom: [] } },
      session: { identityLinks: { "user-1": null } },
    });

    // regenerateOpenClawConfig NOT called
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("preserves other users in allowFrom when unlinking", async () => {
    // Another user remains linked after this user's delete
    mockSelectWhere.mockResolvedValue([
      { userId: "user-2", channel: "telegram", channelUserId: "111222333" },
    ]);

    const response = await DELETE();
    expect(response.status).toBe(200);

    expect(mockQueueConfigPatch).toHaveBeenCalledWith(expect.anything(), {
      channels: { telegram: { allowFrom: ["111222333"] } },
      session: { identityLinks: { "user-1": null } },
    });
  });
});
