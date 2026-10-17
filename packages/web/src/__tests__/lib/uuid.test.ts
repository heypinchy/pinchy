import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isUuid, uuid } from "@/lib/uuid";

describe("uuid", () => {
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    // Restore original crypto
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      writable: true,
      configurable: true,
    });
  });

  it("should use crypto.randomUUID() when available", () => {
    const mockUUID = "550e8400-e29b-41d4-a716-446655440000";
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: () => mockUUID, getRandomValues: originalCrypto.getRandomValues },
      writable: true,
      configurable: true,
    });

    expect(uuid()).toBe(mockUUID);
  });

  it("should fall back to crypto.getRandomValues when randomUUID is unavailable", () => {
    Object.defineProperty(globalThis, "crypto", {
      value: {
        randomUUID: undefined,
        getRandomValues: (arr: Uint8Array) => {
          for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
          return arr;
        },
      },
      writable: true,
      configurable: true,
    });

    const result = uuid();
    // Should look like a UUID (8-4-4-4-12 hex pattern)
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("should fall back to timestamp-based ID when crypto is unavailable", () => {
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const result = uuid();
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(10);
  });

  it("should generate unique IDs on repeated calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuid()));
    expect(ids.size).toBe(100);
  });
});

describe("isUuid", () => {
  it("accepts a canonical uuid in either case", () => {
    expect(isUuid("3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e")).toBe(true);
    expect(isUuid("3F2B8C1E-4D5A-4B6C-8D7E-9F0A1B2C3D4E")).toBe(true);
  });

  it("rejects anything a uuid column would answer with a cast error", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e-extra")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});
