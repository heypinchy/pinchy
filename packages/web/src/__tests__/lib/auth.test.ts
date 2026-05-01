import { describe, it, expect, vi } from "vitest";

// Use vi.hoisted so the mock object is available during vi.mock hoisting
const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    api: {
      getSession: vi.fn(),
      signUpEmail: vi.fn(),
      changePassword: vi.fn(),
    },
    handler: vi.fn(),
    $Infer: { Session: {} },
  },
}));

vi.mock("better-auth", () => ({
  betterAuth: vi.fn(() => mockAuth),
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: vi.fn(() => ({})),
}));

vi.mock("better-auth/plugins", () => ({
  admin: vi.fn(() => ({})),
}));

vi.mock("better-auth/api", () => ({
  createAuthMiddleware: vi.fn((fn) => fn),
}));

vi.mock("@/db", () => ({
  db: {},
}));

vi.mock("@/db/schema", () => ({
  users: {},
  sessions: {},
  accounts: {},
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn(),
}));

import { auth, getAuthRateLimitConfig } from "@/lib/auth";

describe("auth configuration", () => {
  it("should export auth instance", () => {
    expect(auth).toBeDefined();
  });

  it("should have api.getSession method", () => {
    expect(auth.api).toBeDefined();
    expect(typeof auth.api.getSession).toBe("function");
  });
});

describe("getAuthRateLimitConfig", () => {
  it("returns undefined by default — uses Better Auth's NODE_ENV-driven default (enabled in prod)", () => {
    const original = process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT;
    delete process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT;
    try {
      expect(getAuthRateLimitConfig()).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT = original;
    }
  });

  it("returns { enabled: false } when PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT=1 — bypasses /sign-in/* rate limit (3 req / 10s) so Playwright form-login tests don't lock themselves out against the production image", () => {
    const original = process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT;
    process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT = "1";
    try {
      expect(getAuthRateLimitConfig()).toEqual({ enabled: false });
    } finally {
      if (original === undefined) delete process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT;
      else process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT = original;
    }
  });

  it("treats values other than '1' as not set — guard against accidentally disabling rate limiting in production", () => {
    const original = process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT;
    process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT = "true";
    try {
      expect(getAuthRateLimitConfig()).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT;
      else process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT = original;
    }
  });
});
