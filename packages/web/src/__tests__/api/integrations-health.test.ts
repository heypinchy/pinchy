import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

// Mock db: the health route now loads all connections (not a filtered count)
// so it can attempt per-row decryption to derive `cannotDecrypt`.
const mockSelectFrom = vi.fn();
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: mockSelectFrom,
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { status: "status" },
}));

// decrypt throws for rows whose credentials start with "BAD" — this simulates a
// connection written under a different ENCRYPTION_KEY (cannotDecrypt).
const mockDecrypt = vi.fn((ciphertext: string) => {
  if (ciphertext.startsWith("BAD")) throw new Error("bad key");
  return JSON.stringify({ url: "https://odoo.example.com", db: "prod", login: "admin" });
});
vi.mock("@/lib/encryption", () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...(args as [string])),
}));

import { NextRequest } from "next/server";

const adminSession = { user: { id: "u1", email: "admin@test.com", role: "admin" } };

function makeRequest() {
  return new NextRequest("http://localhost:7777/api/integrations/health");
}

function conn(overrides: Partial<{ type: string; credentials: string; status: string }>) {
  return {
    type: "odoo",
    credentials: "OK-encrypted",
    status: "active",
    ...overrides,
  };
}

describe("GET /api/integrations/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
  });

  it("counts auth_failed AND cannotDecrypt connections as needs-attention", async () => {
    mockSelectFrom.mockResolvedValue([
      conn({ status: "active" }), // healthy
      conn({ status: "auth_failed" }), // auth failed
      conn({ status: "active", credentials: "BAD-encrypted" }), // cannot decrypt
    ]);
    const { GET } = await import("@/app/api/integrations/health/route");
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.authFailedCount).toBe(1);
    expect(body.cannotDecryptCount).toBe(1);
    expect(body.needsAttentionCount).toBe(2);
  });

  it("counts a row that is BOTH auth_failed and cannotDecrypt only once in needsAttentionCount", async () => {
    mockSelectFrom.mockResolvedValue([
      conn({ status: "auth_failed", credentials: "BAD-encrypted" }),
    ]);
    const { GET } = await import("@/app/api/integrations/health/route");
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.authFailedCount).toBe(1);
    expect(body.cannotDecryptCount).toBe(1);
    expect(body.needsAttentionCount).toBe(1);
  });

  it("returns zero counts when all connections are healthy", async () => {
    mockSelectFrom.mockResolvedValue([conn({ status: "active" }), conn({ status: "pending" })]);
    const { GET } = await import("@/app/api/integrations/health/route");
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body).toEqual({
      authFailedCount: 0,
      cannotDecryptCount: 0,
      needsAttentionCount: 0,
    });
  });

  it("returns 403 for non-admin authenticated user", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u2", role: "user" } });
    const { GET } = await import("@/app/api/integrations/health/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it("returns 401 for unauthenticated request", async () => {
    mockGetSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/integrations/health/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });
});
