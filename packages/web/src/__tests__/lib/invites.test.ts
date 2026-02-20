import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateInviteToken } from "@/lib/invites";

// ── Mock @/db ────────────────────────────────────────────────────────────────
const returningMock = vi.fn();
const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
const setMock = vi.fn().mockReturnValue({ where: whereMock });
const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
const updateMock = vi.fn().mockReturnValue({ set: setMock });
const findFirstMock = vi.fn();

vi.mock("@/db", () => ({
  db: {
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    query: {
      invites: {
        findFirst: (...args: unknown[]) => findFirstMock(...args),
      },
    },
  },
}));

// ── generateInviteToken (pure crypto, no mocks needed) ──────────────────────

describe("generateInviteToken", () => {
  it("returns an object with token and tokenHash", () => {
    const result = generateInviteToken();

    expect(result).toHaveProperty("token");
    expect(result).toHaveProperty("tokenHash");
  });

  it("returns a token that is 64 hex characters (32 bytes)", () => {
    const { token } = generateInviteToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a tokenHash that is different from the token", () => {
    const { token, tokenHash } = generateInviteToken();

    expect(tokenHash).not.toBe(token);
  });

  it("returns a tokenHash that is a 64 hex character SHA-256 digest", () => {
    const { tokenHash } = generateInviteToken();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different tokens on each call", () => {
    const first = generateInviteToken();
    const second = generateInviteToken();

    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });
});

// ── createInvite ─────────────────────────────────────────────────────────────

describe("createInvite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts an invite and returns it with the plaintext token", async () => {
    const fakeInvite = {
      id: "inv-1",
      tokenHash: "somehash",
      email: "user@example.com",
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      expiresAt: new Date(),
      claimedAt: null,
      claimedByUserId: null,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeInvite]);

    const { createInvite } = await import("@/lib/invites");
    const result = await createInvite({
      email: "user@example.com",
      role: "user",
      createdBy: "admin-1",
    });

    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBe(64);
    expect(result.id).toBe("inv-1");
    expect(result.email).toBe("user@example.com");
  });

  it("passes correct values to db.insert", async () => {
    const fakeInvite = {
      id: "inv-2",
      tokenHash: "hash",
      email: "user@test.com",
      role: "editor",
      type: "invite",
      createdBy: "admin-1",
      expiresAt: new Date(),
      claimedAt: null,
      claimedByUserId: null,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeInvite]);

    const { createInvite } = await import("@/lib/invites");
    await createInvite({
      email: "user@test.com",
      role: "editor",
      createdBy: "admin-1",
    });

    expect(insertMock).toHaveBeenCalled();
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@test.com",
        role: "editor",
        type: "invite",
        createdBy: "admin-1",
        tokenHash: expect.any(String),
        expiresAt: expect.any(Date),
      })
    );
  });

  it("sets expiresAt to approximately 7 days from now", async () => {
    const fakeInvite = {
      id: "inv-3",
      tokenHash: "hash",
      email: null,
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      expiresAt: new Date(),
      claimedAt: null,
      claimedByUserId: null,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeInvite]);

    const { createInvite } = await import("@/lib/invites");
    await createInvite({
      role: "user",
      createdBy: "admin-1",
    });

    const passedValues = valuesMock.mock.calls[0][0];
    const expiresAt = passedValues.expiresAt as Date;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const diff = expiresAt.getTime() - Date.now();

    // Should be within 5 seconds of 7 days
    expect(diff).toBeGreaterThan(sevenDaysMs - 5000);
    expect(diff).toBeLessThanOrEqual(sevenDaysMs);
  });

  it("defaults type to 'invite'", async () => {
    const fakeInvite = {
      id: "inv-4",
      tokenHash: "hash",
      email: null,
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      expiresAt: new Date(),
      claimedAt: null,
      claimedByUserId: null,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeInvite]);

    const { createInvite } = await import("@/lib/invites");
    await createInvite({ role: "user", createdBy: "admin-1" });

    const passedValues = valuesMock.mock.calls[0][0];
    expect(passedValues.type).toBe("invite");
  });

  it("allows overriding type to 'reset'", async () => {
    const fakeInvite = {
      id: "inv-5",
      tokenHash: "hash",
      email: null,
      role: "user",
      type: "reset",
      createdBy: "admin-1",
      expiresAt: new Date(),
      claimedAt: null,
      claimedByUserId: null,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeInvite]);

    const { createInvite } = await import("@/lib/invites");
    await createInvite({ role: "user", type: "reset", createdBy: "admin-1" });

    const passedValues = valuesMock.mock.calls[0][0];
    expect(passedValues.type).toBe("reset");
  });
});

// ── validateInviteToken ──────────────────────────────────────────────────────

describe("validateInviteToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the invite when token is valid", async () => {
    const fakeInvite = {
      id: "inv-1",
      tokenHash: "somehash",
      email: "user@example.com",
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: null,
      claimedByUserId: null,
      createdAt: new Date(),
    };
    findFirstMock.mockResolvedValue(fakeInvite);

    const { validateInviteToken } = await import("@/lib/invites");
    const result = await validateInviteToken("some-raw-token");

    expect(result).toEqual(fakeInvite);
    expect(findFirstMock).toHaveBeenCalled();
  });

  it("returns null when token is not found", async () => {
    findFirstMock.mockResolvedValue(undefined);

    const { validateInviteToken } = await import("@/lib/invites");
    const result = await validateInviteToken("nonexistent-token");

    expect(result).toBeNull();
  });

  it("returns null when token is expired", async () => {
    // The db query filters by expiresAt > now, so expired tokens return undefined
    findFirstMock.mockResolvedValue(undefined);

    const { validateInviteToken } = await import("@/lib/invites");
    const result = await validateInviteToken("expired-token");

    expect(result).toBeNull();
  });

  it("returns null when token is already claimed", async () => {
    // The db query filters by claimedAt IS NULL, so claimed tokens return undefined
    findFirstMock.mockResolvedValue(undefined);

    const { validateInviteToken } = await import("@/lib/invites");
    const result = await validateInviteToken("claimed-token");

    expect(result).toBeNull();
  });
});

// ── claimInvite ──────────────────────────────────────────────────────────────

describe("claimInvite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates the invite with claimedAt and claimedByUserId", async () => {
    const updatedInvite = {
      id: "inv-1",
      tokenHash: "somehash",
      email: "user@example.com",
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: new Date(),
      claimedByUserId: "user-1",
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([updatedInvite]);

    const { claimInvite } = await import("@/lib/invites");
    const result = await claimInvite("somehash", "user-1");

    expect(updateMock).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        claimedAt: expect.any(Date),
        claimedByUserId: "user-1",
      })
    );
    expect(result).toEqual(updatedInvite);
  });

  it("returns the updated invite", async () => {
    const updatedInvite = {
      id: "inv-2",
      tokenHash: "hash2",
      email: null,
      role: "user",
      type: "invite",
      createdBy: "admin-1",
      expiresAt: new Date(),
      claimedAt: new Date(),
      claimedByUserId: "user-2",
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([updatedInvite]);

    const { claimInvite } = await import("@/lib/invites");
    const result = await claimInvite("hash2", "user-2");

    expect(result.id).toBe("inv-2");
    expect(result.claimedByUserId).toBe("user-2");
    expect(result.claimedAt).toBeInstanceOf(Date);
  });
});
