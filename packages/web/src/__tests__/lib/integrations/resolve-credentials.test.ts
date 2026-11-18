// Unit tests for resolveConnectionCredentials — the credential-resolution seam
// extracted from the internal credentials route so BOTH the route (mapping to
// HTTP status codes) and the Inbox Agent's mailbox port (mapping to the sweep's
// unit-level failure) share one decrypt + OAuth-refresh path.
//
// The contract the port depends on is *typed errors*, not HTTP status codes:
// not-found / not-active / decrypt-failure each throw a distinct class so the
// route can map them to 404 / 403 / 500 while the port lets them propagate to
// the sweep as the workflow's `error` status. Mirrors the route test's mock
// style (db/encryption/oauth stubbed) — the real decrypt + real DB coverage
// lives in the port's integration tests against the provider mocks.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: vi.fn().mockReturnValue('{"accessToken":"test-token","refreshToken":"test-refresh"}'),
  encrypt: vi.fn().mockReturnValue("re-encrypted-blob"),
}));

vi.mock("@/lib/integrations/oauth-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/oauth-token")>();
  return { ...actual, isTokenExpired: vi.fn().mockReturnValue(false) };
});

vi.mock("@/lib/integrations/oauth-settings", () => ({
  getOAuthSettings: vi.fn().mockResolvedValue(null),
}));

import { db } from "@/db";
import { decrypt } from "@/lib/encryption";
import {
  resolveConnectionCredentials,
  ConnectionNotFoundError,
  ConnectionNotActiveError,
  CredentialsDecryptError,
} from "@/lib/integrations/resolve-credentials";

function mockDbSelectResult(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>);
}

describe("resolveConnectionCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decrypt).mockReturnValue(
      '{"accessToken":"test-token","refreshToken":"test-refresh"}'
    );
  });

  it("returns { type, credentials } for an active connection", async () => {
    mockDbSelectResult([{ id: "conn-1", type: "imap", status: "active", credentials: "blob" }]);

    const resolved = await resolveConnectionCredentials("conn-1");

    expect(resolved.type).toBe("imap");
    expect(resolved.credentials).toEqual({
      accessToken: "test-token",
      refreshToken: "test-refresh",
    });
  });

  it("throws ConnectionNotFoundError when the connection does not exist", async () => {
    mockDbSelectResult([]);

    await expect(resolveConnectionCredentials("missing")).rejects.toBeInstanceOf(
      ConnectionNotFoundError
    );
  });

  it("throws ConnectionNotActiveError for a pending connection", async () => {
    mockDbSelectResult([{ id: "conn-1", type: "imap", status: "pending", credentials: "blob" }]);

    await expect(resolveConnectionCredentials("conn-1")).rejects.toBeInstanceOf(
      ConnectionNotActiveError
    );
  });

  it("throws CredentialsDecryptError when decryption fails", async () => {
    mockDbSelectResult([{ id: "conn-1", type: "imap", status: "active", credentials: "corrupt" }]);
    vi.mocked(decrypt).mockImplementation(() => {
      throw new Error("bad ciphertext");
    });

    await expect(resolveConnectionCredentials("conn-1")).rejects.toBeInstanceOf(
      CredentialsDecryptError
    );
  });
});
