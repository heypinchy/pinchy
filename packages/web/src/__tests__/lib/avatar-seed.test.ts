import { describe, it, expect, vi, afterEach } from "vitest";
import { generateAvatarSeed } from "@/lib/avatar";

describe("generateAvatarSeed", () => {
  it("should return a string", () => {
    const seed = generateAvatarSeed();
    expect(typeof seed).toBe("string");
    expect(seed.length).toBeGreaterThan(0);
  });

  it("should generate unique seeds on repeated calls", () => {
    const seeds = new Set(Array.from({ length: 50 }, () => generateAvatarSeed()));
    expect(seeds.size).toBe(50);
  });

  it("should work when crypto.randomUUID is unavailable", () => {
    const originalRandomUUID = crypto.randomUUID;
    // Simulate insecure context
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const seed = generateAvatarSeed();
    expect(typeof seed).toBe("string");
    expect(seed.length).toBeGreaterThan(0);

    Object.defineProperty(crypto, "randomUUID", {
      value: originalRandomUUID,
      writable: true,
      configurable: true,
    });
  });
});
