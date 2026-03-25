import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uuid } from "@/lib/uuid";

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
