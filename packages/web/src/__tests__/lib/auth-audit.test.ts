import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAppendAuditLog, mockFindFirst, mockCompare } = vi.hoisted(() => ({
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  mockFindFirst: vi.fn(),
  mockCompare: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      users: {
        findFirst: mockFindFirst,
      },
    },
  },
}));

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));

vi.mock("@auth/drizzle-adapter", () => ({
  DrizzleAdapter: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: mockCompare,
  },
}));

import { authConfig } from "@/lib/auth";

// The real authorize function is stored in provider.options.authorize
// (the top-level authorize is a stub that returns null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const credentialsProvider = authConfig.providers[0] as any;
const authorize = credentialsProvider.options.authorize;

describe("auth audit logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authorize", () => {
    it("should log auth.login on successful authentication", async () => {
      const mockUser = {
        id: "user-123",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        passwordHash: "$2a$10$hashedpassword",
      };

      mockFindFirst.mockResolvedValue(mockUser);
      mockCompare.mockResolvedValue(true as never);

      const result = await authorize({
        email: "admin@example.com",
        password: "Password1",
      });

      expect(result).toEqual({
        id: "user-123",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
      });
      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "user",
        actorId: "user-123",
        eventType: "auth.login",
        detail: { email: "admin@example.com" },
      });
    });

    it("should log auth.failed with reason user_not_found when user does not exist", async () => {
      mockFindFirst.mockResolvedValue(undefined);

      const result = await authorize({
        email: "unknown@example.com",
        password: "Password1",
      });

      expect(result).toBeNull();
      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "system",
        actorId: "system",
        eventType: "auth.failed",
        detail: { email: "unknown@example.com", reason: "user_not_found" },
      });
    });

    it("should log auth.failed with reason user_not_found when user has no password hash", async () => {
      const mockUser = {
        id: "user-456",
        email: "nopw@example.com",
        name: "No Password",
        role: "user",
        passwordHash: null,
      };

      mockFindFirst.mockResolvedValue(mockUser);

      const result = await authorize({
        email: "nopw@example.com",
        password: "Password1",
      });

      expect(result).toBeNull();
      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "system",
        actorId: "system",
        eventType: "auth.failed",
        detail: { email: "nopw@example.com", reason: "user_not_found" },
      });
    });

    it("should log auth.failed with reason invalid_password when password is wrong", async () => {
      const mockUser = {
        id: "user-789",
        email: "valid@example.com",
        name: "Valid User",
        role: "user",
        passwordHash: "$2a$10$hashedpassword",
      };

      mockFindFirst.mockResolvedValue(mockUser);
      mockCompare.mockResolvedValue(false as never);

      const result = await authorize({
        email: "valid@example.com",
        password: "WrongPassword1",
      });

      expect(result).toBeNull();
      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "system",
        actorId: "system",
        eventType: "auth.failed",
        detail: { email: "valid@example.com", reason: "invalid_password" },
      });
    });

    it("should not break authentication if audit logging fails", async () => {
      const mockUser = {
        id: "user-123",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        passwordHash: "$2a$10$hashedpassword",
      };

      mockFindFirst.mockResolvedValue(mockUser);
      mockCompare.mockResolvedValue(true as never);
      mockAppendAuditLog.mockRejectedValue(new Error("DB connection lost"));

      const result = await authorize({
        email: "admin@example.com",
        password: "Password1",
      });

      expect(result).toEqual({
        id: "user-123",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
      });
    });
  });

  describe("signOut event", () => {
    it("should have events.signOut defined", () => {
      expect(authConfig.events?.signOut).toBeDefined();
      expect(typeof authConfig.events?.signOut).toBe("function");
    });

    it("should log auth.logout on signOut with token", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signOutHandler = authConfig.events?.signOut as any;

      await signOutHandler({ token: { sub: "user-123" } });

      expect(mockAppendAuditLog).toHaveBeenCalledWith({
        actorType: "user",
        actorId: "user-123",
        eventType: "auth.logout",
        detail: {},
      });
    });

    it("should not log auth.logout when token has no sub", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signOutHandler = authConfig.events?.signOut as any;

      await signOutHandler({ token: {} });

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("should not log auth.logout when message has no token", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signOutHandler = authConfig.events?.signOut as any;

      await signOutHandler({ session: {} });

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });
  });
});
