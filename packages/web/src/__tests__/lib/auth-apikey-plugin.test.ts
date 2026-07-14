import { describe, it, expect, vi } from "vitest";

// This test constructs the REAL Better Auth instance (better-auth and the
// @better-auth/api-key plugin are NOT mocked) so it genuinely proves the
// apiKey() plugin is registered — a mocked auth.api could never surface
// createApiKey/verifyApiKey. Only the DB pool and the audit sink are stubbed
// so the module loads without a live Postgres or DATABASE_URL: registering the
// plugin's endpoints onto auth.api is synchronous and never touches the DB.
vi.mock("@/db", () => ({
  db: {},
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn(),
  redactEmail: vi.fn(() => ({})),
}));

import { auth } from "@/lib/auth";

describe("Better Auth apiKey plugin registration", () => {
  it("exposes auth.api.createApiKey — proves apiKey() is in the plugins array", () => {
    expect(typeof auth.api.createApiKey).toBe("function");
  });

  it("exposes auth.api.verifyApiKey — the server-side verification endpoint the Agent Provisioning API relies on", () => {
    expect(typeof auth.api.verifyApiKey).toBe("function");
  });
});
