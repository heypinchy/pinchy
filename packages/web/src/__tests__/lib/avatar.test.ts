import { describe, it, expect } from "vitest";
import { getAgentAvatarSvg, generateAvatarSeed } from "@/lib/avatar";

describe("getAgentAvatarSvg", () => {
  it("returns a data URI for a normal seed", () => {
    const result = getAgentAvatarSvg({ avatarSeed: "test-seed", name: "Test" });
    expect(result).toMatch(/^data:image\/svg\+xml/);
  });

  it("falls back to agent name when avatarSeed is null", () => {
    const result = getAgentAvatarSvg({ avatarSeed: null, name: "Fallback" });
    expect(result).toMatch(/^data:image\/svg\+xml/);
  });

  it("returns Smithers avatar path for __smithers__ seed", () => {
    const result = getAgentAvatarSvg({
      avatarSeed: "__smithers__",
      name: "Smithers",
    });
    expect(result).toBe("/images/smithers-avatar.png");
  });

  it("is deterministic — same seed produces same output", () => {
    const a = getAgentAvatarSvg({ avatarSeed: "stable", name: "X" });
    const b = getAgentAvatarSvg({ avatarSeed: "stable", name: "X" });
    expect(a).toBe(b);
  });

  it("produces different output for different seeds", () => {
    const a = getAgentAvatarSvg({ avatarSeed: "seed-a", name: "X" });
    const b = getAgentAvatarSvg({ avatarSeed: "seed-b", name: "X" });
    expect(a).not.toBe(b);
  });
});

describe("generateAvatarSeed", () => {
  it("returns a non-empty string", () => {
    const seed = generateAvatarSeed();
    expect(typeof seed).toBe("string");
    expect(seed.length).toBeGreaterThan(0);
  });
});
