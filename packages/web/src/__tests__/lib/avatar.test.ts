import { describe, it, expect } from "vitest";
import {
  getAgentAvatarSvg,
  generateAvatarSeed,
  resolvePresentation,
  buildNotionistsOptions,
  BACKGROUND_COLORS,
  HAIR_MASCULINE,
  HAIR_FEMININE,
  HAIR_MIXED,
} from "@/lib/avatar";

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

describe("resolvePresentation", () => {
  it("pins clearly-gendered names we ship", () => {
    expect(resolvePresentation("Ada")).toBe("feminine");
    expect(resolvePresentation("Maya")).toBe("feminine");
    expect(resolvePresentation("Sherlock")).toBe("masculine");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolvePresentation("ada")).toBe("feminine");
    expect(resolvePresentation("  SHERLOCK ")).toBe("masculine");
  });

  it("falls back to mixed for codenames and unknown names", () => {
    expect(resolvePresentation("Pulse")).toBe("mixed");
    expect(resolvePresentation("Quill")).toBe("mixed");
    expect(resolvePresentation("Scout")).toBe("mixed");
    expect(resolvePresentation("Jet")).toBe("mixed");
    expect(resolvePresentation("Xyzzy")).toBe("mixed");
    expect(resolvePresentation("")).toBe("mixed");
  });
});

describe("buildNotionistsOptions", () => {
  it("locks the background to the warm brand ramp", () => {
    expect(buildNotionistsOptions("s", "Quill").backgroundColor).toEqual(BACKGROUND_COLORS);
  });

  it("uses a head-focused framing", () => {
    const opts = buildNotionistsOptions("s", "Quill");
    expect(opts.scale).toBe(150);
    expect(opts.translateY).toBe(16);
  });

  it("suppresses gestures and body icons", () => {
    const opts = buildNotionistsOptions("s", "Quill");
    expect(opts.gestureProbability).toBe(0);
    expect(opts.bodyIconProbability).toBe(0);
  });

  it("selects feminine hair and no beard for a feminine name", () => {
    const opts = buildNotionistsOptions("s", "Ada");
    expect(opts.hair).toEqual([...HAIR_FEMININE]);
    expect(opts.beardProbability).toBe(0);
  });

  it("selects masculine hair for a masculine name", () => {
    const opts = buildNotionistsOptions("s", "Sherlock");
    expect(opts.hair).toEqual([...HAIR_MASCULINE]);
    expect(opts.beardProbability).toBeGreaterThan(0);
  });

  it("uses the mixed hair pool for codenames", () => {
    const opts = buildNotionistsOptions("s", "Quill");
    expect(opts.hair).toEqual([...HAIR_MIXED]);
  });
});

describe("hair curation", () => {
  // Culturally specific headwear (turban/headscarf) and props must never appear.
  const EXCLUDED = ["hat", "variant08", "variant61", "variant62", "variant63"];

  it("excludes culturally specific and prop hairstyles from every set", () => {
    for (const set of [HAIR_MASCULINE, HAIR_FEMININE, HAIR_MIXED]) {
      for (const excluded of EXCLUDED) {
        expect(set).not.toContain(excluded);
      }
    }
  });

  it("keeps masculine and feminine sets disjoint", () => {
    const fem = new Set<string>(HAIR_FEMININE);
    expect(HAIR_MASCULINE.some((h) => fem.has(h))).toBe(false);
  });
});

describe("generateAvatarSeed", () => {
  it("returns a non-empty string", () => {
    const seed = generateAvatarSeed();
    expect(typeof seed).toBe("string");
    expect(seed.length).toBeGreaterThan(0);
  });
});
