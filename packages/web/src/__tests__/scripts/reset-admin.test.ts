import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock("@/db/schema", () => ({
  users: { id: "id", email: "email", role: "role" },
  accounts: { userId: "userId", providerId: "providerId", password: "password" },
}));

vi.mock("better-auth/crypto", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed-password-123"),
}));

import { resetAdminPassword } from "@/lib/reset-admin";
import { hashPassword } from "better-auth/crypto";

// ── Tests ────────────────────────────────────────────────────────────────

describe("resetAdminPassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default chain: select().from().where()
    mockWhere.mockResolvedValue([]);
    mockFrom.mockReturnValue({ where: mockWhere });
    mockSelect.mockReturnValue({ from: mockFrom });

    // Default update chain: update().set().where()
    const mockUpdateWhere = vi.fn().mockResolvedValue([]);
    mockSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockReturnValue({ set: mockSet });
  });

  it("finds first admin user when no email provided", async () => {
    mockWhere.mockResolvedValueOnce([{ id: "admin-1", email: "admin@example.com", role: "admin" }]);

    // For the account update query
    const mockUpdateWhere = vi.fn().mockResolvedValue([]);
    mockSet.mockReturnValue({ where: mockUpdateWhere });

    const result = await resetAdminPassword();

    expect(result.email).toBe("admin@example.com");
    expect(result.password).toBeDefined();
    expect(result.password.length).toBeGreaterThanOrEqual(16);
  });

  it("finds specific user when --email is provided", async () => {
    mockWhere.mockResolvedValueOnce([
      { id: "user-1", email: "specific@example.com", role: "admin" },
    ]);

    const mockUpdateWhere = vi.fn().mockResolvedValue([]);
    mockSet.mockReturnValue({ where: mockUpdateWhere });

    const result = await resetAdminPassword("specific@example.com");

    expect(result.email).toBe("specific@example.com");
    expect(result.password).toBeDefined();
  });

  it("throws error when no admin user found (no email)", async () => {
    mockWhere.mockResolvedValueOnce([]);

    await expect(resetAdminPassword()).rejects.toThrow("No admin user found");
  });

  it("throws error when user with given email not found", async () => {
    mockWhere.mockResolvedValueOnce([]);

    await expect(resetAdminPassword("nobody@example.com")).rejects.toThrow(
      "No user found with email: nobody@example.com"
    );
  });

  it("generates a password of at least 16 characters", async () => {
    mockWhere.mockResolvedValueOnce([{ id: "admin-1", email: "admin@example.com", role: "admin" }]);

    const mockUpdateWhere = vi.fn().mockResolvedValue([]);
    mockSet.mockReturnValue({ where: mockUpdateWhere });

    const result = await resetAdminPassword();

    expect(result.password.length).toBeGreaterThanOrEqual(16);
  });

  it("hashes the password using better-auth/crypto", async () => {
    mockWhere.mockResolvedValueOnce([{ id: "admin-1", email: "admin@example.com", role: "admin" }]);

    const mockUpdateWhere = vi.fn().mockResolvedValue([]);
    mockSet.mockReturnValue({ where: mockUpdateWhere });

    const result = await resetAdminPassword();

    expect(hashPassword).toHaveBeenCalledWith(result.password);
  });

  it("updates the account table with the hashed password", async () => {
    mockWhere.mockResolvedValueOnce([{ id: "admin-1", email: "admin@example.com", role: "admin" }]);

    const mockUpdateWhere = vi.fn().mockResolvedValue([]);
    mockSet.mockReturnValue({ where: mockUpdateWhere });

    await resetAdminPassword();

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith({ password: "hashed-password-123" });
    expect(mockUpdateWhere).toHaveBeenCalled();
  });
});
