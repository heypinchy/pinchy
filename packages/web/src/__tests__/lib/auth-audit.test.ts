import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAppendAuditLog } = vi.hoisted(() => ({
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

vi.mock("@/db", () => ({
  db: {},
}));

vi.mock("@/db/schema", () => ({
  users: {},
  sessions: {},
  accounts: {},
}));

vi.mock("better-auth", () => ({
  betterAuth: vi.fn(() => ({
    handler: vi.fn(),
    api: {},
    $Infer: { Session: {} },
  })),
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: vi.fn(),
}));

vi.mock("better-auth/plugins", () => ({
  admin: vi.fn(() => ({})),
}));

vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn() },
}));

// Mock createAuthMiddleware to pass through the handler function
vi.mock("better-auth/api", () => ({
  createAuthMiddleware: vi.fn((handler: unknown) => handler),
}));

import { auditAfterHook } from "@/lib/auth";

// The auditAfterHook is the raw handler function (because createAuthMiddleware is mocked)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = auditAfterHook as any;

function createMockContext(overrides: Record<string, unknown> = {}) {
  return {
    path: "/sign-in/email",
    body: { email: "user@example.com" },
    context: {
      newSession: null,
      session: null,
    },
    ...overrides,
  };
}

describe("auth audit logging (Better Auth hooks)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sign-in hooks", () => {
    it("should log auth.login on successful sign-in", async () => {
      const ctx = createMockContext({
        context: {
          newSession: {
            user: {
              id: "user-123",
              email: "admin@example.com",
              name: "Admin",
            },
            session: { id: "session-1" },
          },
          session: null,
        },
        body: { email: "admin@example.com" },
      });

      await handler(ctx);

      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "user",
        actorId: "user-123",
        eventType: "auth.login",
        outcome: "success",
        detail: { email: "admin@example.com" },
      });
    });

    it("should log auth.failed on failed sign-in", async () => {
      const ctx = createMockContext({
        context: {
          newSession: null,
          session: null,
        },
        body: { email: "unknown@example.com" },
      });

      await handler(ctx);

      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "system",
        actorId: "system",
        eventType: "auth.failed",
        outcome: "failure",
        error: { message: "Invalid credentials" },
        detail: { email: "unknown@example.com", reason: "invalid_credentials" },
      });
    });

    it("should use 'unknown' email when body has no email", async () => {
      const ctx = createMockContext({
        context: {
          newSession: null,
          session: null,
        },
        body: {},
      });

      await handler(ctx);

      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "system",
        actorId: "system",
        eventType: "auth.failed",
        outcome: "failure",
        error: { message: "Invalid credentials" },
        detail: { email: "unknown", reason: "invalid_credentials" },
      });
    });

    it("should not break auth if audit logging fails on successful login", async () => {
      mockAppendAuditLog.mockRejectedValue(new Error("DB connection lost"));

      const ctx = createMockContext({
        context: {
          newSession: {
            user: { id: "user-123", email: "admin@example.com" },
            session: { id: "session-1" },
          },
          session: null,
        },
        body: { email: "admin@example.com" },
      });

      // Should not throw
      await expect(handler(ctx)).resolves.not.toThrow();
    });

    it("should not break auth if audit logging fails on failed login", async () => {
      mockAppendAuditLog.mockRejectedValue(new Error("DB connection lost"));

      const ctx = createMockContext({
        context: {
          newSession: null,
          session: null,
        },
        body: { email: "bad@example.com" },
      });

      // Should not throw
      await expect(handler(ctx)).resolves.not.toThrow();
    });
  });

  describe("sign-out hooks", () => {
    it("should log auth.logout on sign-out", async () => {
      const ctx = createMockContext({
        path: "/sign-out",
        body: {},
        context: {
          newSession: null,
          session: {
            user: { id: "user-456" },
            session: { id: "session-2" },
          },
        },
      });

      await handler(ctx);

      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "user",
        actorId: "user-456",
        eventType: "auth.logout",
        outcome: "success",
        detail: {},
      });
    });

    it("should not log auth.logout when session has no user", async () => {
      const ctx = createMockContext({
        path: "/sign-out",
        body: {},
        context: {
          newSession: null,
          session: null,
        },
      });

      await handler(ctx);

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("should not break auth if audit logging fails on sign-out", async () => {
      mockAppendAuditLog.mockRejectedValue(new Error("DB connection lost"));

      const ctx = createMockContext({
        path: "/sign-out",
        body: {},
        context: {
          newSession: null,
          session: {
            user: { id: "user-456" },
            session: { id: "session-2" },
          },
        },
      });

      // Should not throw
      await expect(handler(ctx)).resolves.not.toThrow();
    });
  });

  describe("non-auth paths", () => {
    it("should not log anything for unrelated paths", async () => {
      const ctx = createMockContext({
        path: "/get-session",
        body: {},
      });

      await handler(ctx);

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });
  });
});
