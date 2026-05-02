import { describe, it, expect, vi } from "vitest";
import { betterAuth } from "better-auth";

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

  it("constructs the auth instance with the result of getAuthRateLimitConfig() — guards against future refactors that wire the wrong config object into betterAuth", () => {
    // Module-load side effect: betterAuth() was already called when @/lib/auth
    // was imported above. The first call's first arg holds the options.
    const calls = vi.mocked(betterAuth).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const options = calls[0][0] as { rateLimit?: unknown };
    expect(options.rateLimit).toBeDefined();
    // Compare structurally — getAuthRateLimitConfig() may be re-evaluated, but
    // its return value at module-load time MUST be what was wired in.
    expect(options.rateLimit).toEqual(getAuthRateLimitConfig());
  });
});

describe("getAuthRateLimitConfig", () => {
  function withEnv<T>(value: string | undefined, fn: () => T): T {
    const original = process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT;
    if (value === undefined) delete process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT;
    else process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT = value;
    try {
      return fn();
    } finally {
      if (original === undefined) delete process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT;
      else process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT = original;
    }
  }

  it("returns explicit hardened config by default — does NOT rely on Better Auth defaults so a future upgrade can't silently weaken us", () => {
    withEnv(undefined, () => {
      const config = getAuthRateLimitConfig();
      expect(config).toBeDefined();
      // customRules MUST be defined — this is the brute-force protection
      expect(config?.customRules).toBeDefined();
    });
  });

  it("pins the global rate-limit fallback at 100 req / 10s per IP — matches Better Auth's own default so we don't accidentally throttle benign session checks", () => {
    withEnv(undefined, () => {
      const config = getAuthRateLimitConfig();
      expect(config?.window).toBe(10);
      expect(config?.max).toBe(100);
    });
  });

  it("returns { enabled: false } when PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT=1 — bypasses rate limit so Playwright form-login tests don't lock themselves out against the production image", () => {
    withEnv("1", () => {
      expect(getAuthRateLimitConfig()).toEqual({ enabled: false });
    });
  });

  it("treats values other than '1' as not set — guard against accidentally disabling rate limiting in production", () => {
    withEnv("true", () => {
      const config = getAuthRateLimitConfig();
      // Must NOT be the disabled config
      expect(config).not.toEqual({ enabled: false });
      // Must still produce hardened customRules
      expect(config?.customRules).toBeDefined();
    });
  });

  describe("customRules — hardened thresholds for sensitive paths", () => {
    // Issue #239: Better Auth defaults are too weak for enterprise. Sign-in
    // defaults to 3 req / 10s = 18/min = 1080/hour per IP, trivially defeated
    // by residential proxy pools. We tighten to:
    //   sign-in/email:           5 / 60s   (was 18/min)
    //   sign-up/email:           3 / 300s
    //   forget-password:         3 / 600s
    //   reset-password:          5 / 600s
    //   change-password:         5 / 600s  (post-auth)
    //   change-email:            3 / 600s  (post-auth — account takeover risk)
    //   request-password-reset:  3 / 600s
    //   send-verification-email: 3 / 600s

    function getCustomRules() {
      return withEnv(undefined, () => {
        const config = getAuthRateLimitConfig();
        if (!config?.customRules) {
          throw new Error("customRules must be defined");
        }
        return config.customRules;
      });
    }

    it("hardens /sign-in/email — at most 5 attempts per minute per IP", () => {
      const rule = getCustomRules()["/sign-in/email"];
      expect(rule).toBeDefined();
      // Stricter than Better Auth's 3/10s = 18/min default
      expect(rule).toEqual({ window: 60, max: 5 });
    });

    it("hardens /sign-in/* (wildcard) — covers OAuth callbacks, magic-link, passkey, etc. that Pinchy may add later, so they don't fall back to Better Auth's weaker 3/10s default", () => {
      const rule = getCustomRules()["/sign-in/*"];
      expect(rule).toEqual({ window: 60, max: 5 });
    });

    it("hardens /sign-up/email — at most 3 sign-ups per 5 minutes per IP", () => {
      const rule = getCustomRules()["/sign-up/email"];
      expect(rule).toEqual({ window: 300, max: 3 });
    });

    it("hardens /sign-up/* (wildcard) — same reason as /sign-in/*: future sub-paths inherit the hardened threshold", () => {
      const rule = getCustomRules()["/sign-up/*"];
      expect(rule).toEqual({ window: 300, max: 3 });
    });

    it("hardens /forget-password — at most 3 reset requests per 10 minutes per IP", () => {
      const rule = getCustomRules()["/forget-password"];
      expect(rule).toEqual({ window: 600, max: 3 });
    });

    it("hardens /reset-password — at most 5 resets per 10 minutes per IP", () => {
      const rule = getCustomRules()["/reset-password"];
      expect(rule).toEqual({ window: 600, max: 5 });
    });

    it("hardens /change-password — at most 5 changes per 10 minutes per IP (post-auth)", () => {
      const rule = getCustomRules()["/change-password"];
      expect(rule).toEqual({ window: 600, max: 5 });
    });

    it("hardens /change-email — at most 3 changes per 10 minutes per IP (post-auth, account takeover risk)", () => {
      const rule = getCustomRules()["/change-email"];
      expect(rule).toEqual({ window: 600, max: 3 });
    });

    it("hardens /request-password-reset — at most 3 per 10 minutes per IP (email-spam DOS protection)", () => {
      const rule = getCustomRules()["/request-password-reset"];
      expect(rule).toEqual({ window: 600, max: 3 });
    });

    it("hardens /send-verification-email — at most 3 per 10 minutes per IP", () => {
      const rule = getCustomRules()["/send-verification-email"];
      expect(rule).toEqual({ window: 600, max: 3 });
    });
  });
});
