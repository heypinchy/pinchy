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

const mockTryAcquireTelegramPairingSlot = vi.fn();
const mockRecordTelegramPairingFailure = vi.fn().mockResolvedValue(undefined);
// Only the two stateful helpers are stubbed. `isChannelUserIdConflictError`
// deliberately keeps its real implementation: stubbing it made the 409 test
// assert nothing about error recognition, which is precisely where the bug
// was — the predicate read `code`/`constraint_name` off the thrown error,
// while drizzle hands it over wrapped in a `DrizzleQueryError`. The test
// below now throws the shape the route really catches.
vi.mock("@/lib/telegram-pairing-security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telegram-pairing-security")>()),
  tryAcquireTelegramPairingSlot: (...args: unknown[]) => mockTryAcquireTelegramPairingSlot(...args),
  recordTelegramPairingFailure: (...args: unknown[]) => mockRecordTelegramPairingFailure(...args),
}));

// #508: the route no longer writes session.identityLinks (per-task session
// model — each Telegram peer keeps its own per-peer OpenClaw session). It no
// longer imports anything from @/lib/openclaw-config, so there is nothing to
// mock here; the assertions below verify channel_links + allow-store remain
// the only effects of link/unlink.

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
import { DrizzleQueryError } from "drizzle-orm/errors";
import { NextRequest } from "next/server";
import { makeNextRequest, routeContext } from "@/test-helpers/route";

// ── Helpers ──────────────────────────────────────────────────────────────

const userSession = {
  user: { id: "user-1", email: "user@test.com", role: "member" },
};

/**
 * A unique violation shaped the way `db.insert(...)` really rejects: the
 * postgres.js `PostgresError` (the only object carrying `code` /
 * `constraint_name`) wrapped in drizzle's `DrizzleQueryError`.
 */
function makeUniqueViolation(constraintName = "channel_links_channel_user_id_uniq") {
  const pgError = Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraintName}"`),
    { code: "23505", constraint_name: constraintName }
  );
  return new DrizzleQueryError("insert into channel_links …", [], pgError);
}

function makePostRequest(body: object) {
  return new NextRequest("http://localhost/api/settings/telegram", {
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

    const response = await GET(makeNextRequest(), routeContext());
    expect(response.status).toBe(401);
  });

  it("returns linked status when link exists", async () => {
    mockFindFirst.mockResolvedValueOnce({
      userId: "user-1",
      channel: "telegram",
      channelUserId: "8734062810",
    });

    const response = await GET(makeNextRequest(), routeContext());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ linked: true, channelUserId: "8734062810" });
  });

  it("returns not linked when no link exists", async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);

    const response = await GET(makeNextRequest(), routeContext());
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
    mockTryAcquireTelegramPairingSlot.mockReturnValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await POST(makePostRequest({ code: "ABC123" }), routeContext());
    expect(response.status).toBe(401);
  });

  it("returns 400 when code is missing", async () => {
    const response = await POST(makePostRequest({}), routeContext());
    expect(response.status).toBe(400);
  });

  it("resolves pairing code, stores link in DB, regenerates config", async () => {
    const response = await POST(makePostRequest({ code: "FMSVEN7M" }), routeContext());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ linked: true, telegramUserId: "8734062810" });

    // Pairing code resolved
    expect(mockResolvePairingCode).toHaveBeenCalledWith("FMSVEN7M");

    // DB written first
    expect(mockInsert).toHaveBeenCalled();

    // Per-account allow-from stores recalculated (permission-aware)
    expect(mockRecalculateTelegramAllowStores).toHaveBeenCalled();

    // #508: no session.identityLinks write — channel_links + the allow-store
    // recalc are the only effects of linking under the per-task session model.
  });

  it("returns 400 when pairing code is invalid", async () => {
    mockResolvePairingCode.mockReturnValueOnce({ found: false });

    const response = await POST(makePostRequest({ code: "BADCODE" }), routeContext());
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("Invalid or expired");
  });

  it("records an audit failure when the pairing code is invalid", async () => {
    mockResolvePairingCode.mockReturnValueOnce({ found: false });

    await POST(makePostRequest({ code: "BADCODE" }), routeContext());

    expect(mockRecordTelegramPairingFailure).toHaveBeenCalledWith(
      "user-1",
      "invalid_or_expired_code"
    );
  });

  it("returns 429 and does not touch the DB when the per-user rate limit is exceeded", async () => {
    // Simulates the brute-force scenario: a member looping guesses against a
    // live victim's pairing code. The 6th attempt within the window must be
    // rejected before resolvePairingCode (and therefore any DB write) runs.
    mockTryAcquireTelegramPairingSlot.mockReturnValueOnce(false);

    const response = await POST(makePostRequest({ code: "GUESS1" }), routeContext());
    expect(response.status).toBe(429);

    const data = await response.json();
    expect(data.error).toMatch(/too many/i);

    expect(mockResolvePairingCode).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockRecordTelegramPairingFailure).toHaveBeenCalledWith("user-1", "rate_limited");
  });

  it("returns 409 when the Telegram account is already linked to a different user", async () => {
    // channel_links carries a unique index on (channel, channelUserId) that
    // onConflictDoUpdate's (userId, channel) target does not cover — a
    // second user redeeming a code for an already-linked Telegram id must
    // raise this, not upsert over the existing owner's link.
    //
    // Thrown WRAPPED, because that is what the route actually catches:
    // drizzle-orm 0.45 re-throws every driver error as DrizzleQueryError with
    // the PostgresError on `.cause`. Rejecting with the bare PostgresError
    // here would let a predicate that ignores the wrapper pass this test and
    // still 500 in production.
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockRejectedValue(makeUniqueViolation()),
      }),
    });

    const response = await POST(makePostRequest({ code: "FMSVEN7M" }), routeContext());
    expect(response.status).toBe(409);

    const data = await response.json();
    expect(data.error).toContain("already linked");

    expect(mockRecordTelegramPairingFailure).toHaveBeenCalledWith(
      "user-1",
      "channel_user_id_conflict"
    );
    // Neither the pairing request nor the allow-store recalculation should
    // run after a rejected write.
    expect(mockRemovePairingRequest).not.toHaveBeenCalled();
    expect(mockRecalculateTelegramAllowStores).not.toHaveBeenCalled();
  });

  it("re-throws a DB error that is not the channel_user_id conflict", async () => {
    const otherError = Object.assign(new Error("connection reset"), { code: "08006" });
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockRejectedValue(otherError),
      }),
    });

    await expect(POST(makePostRequest({ code: "FMSVEN7M" }), routeContext())).rejects.toThrow(
      "connection reset"
    );
  });

  it("re-throws a unique violation on the OTHER channel_links index", async () => {
    // (userId, channel) is the onConflictDoUpdate target, so a violation of it
    // is not a "someone else owns this Telegram account" condition and must
    // not be dressed up as one.
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi
          .fn()
          .mockRejectedValue(makeUniqueViolation("channel_links_user_channel_uniq")),
      }),
    });

    await expect(POST(makePostRequest({ code: "FMSVEN7M" }), routeContext())).rejects.toThrow(
      /Failed query/
    );
    expect(mockRecordTelegramPairingFailure).not.toHaveBeenCalled();
  });

  it("still succeeds when OpenClaw client is not connected", async () => {
    // queueConfigPatch is fire-and-forget — route always returns success
    // since DB is source of truth
    const response = await POST(makePostRequest({ code: "ABC123" }), routeContext());
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

    const response = await DELETE(makeNextRequest(), routeContext());
    expect(response.status).toBe(401);
  });

  it("removes link from DB, updates allow store, and regenerates config", async () => {
    const response = await DELETE(makeNextRequest(), routeContext());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ linked: false });

    // DB updated
    expect(mockDelete).toHaveBeenCalled();

    // Per-account allow-from stores recalculated (removes unlinked user)
    expect(mockRecalculateTelegramAllowStores).toHaveBeenCalled();

    // #508: no session.identityLinks write on unlink either — the allow-store
    // recalc (driven by channel_links) is the sole config-side effect.
  });
});
