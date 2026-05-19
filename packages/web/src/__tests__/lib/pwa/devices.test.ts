import { describe, it, expect } from "vitest";
import { DEVICES } from "@/lib/pwa/devices";

describe("DEVICES", () => {
  it("contains at least one iPhone and one iPad", () => {
    expect(DEVICES.some((d) => d.family === "iphone")).toBe(true);
    expect(DEVICES.some((d) => d.family === "ipad")).toBe(true);
  });

  it("every device has a unique slug", () => {
    const slugs = DEVICES.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every device has positive logical and physical dimensions", () => {
    for (const d of DEVICES) {
      expect(d.logicalWidth).toBeGreaterThan(0);
      expect(d.logicalHeight).toBeGreaterThan(0);
      expect(d.pixelRatio).toBeGreaterThanOrEqual(2);
      // Physical = logical × pixelRatio; sanity-check this invariant.
      expect(d.logicalWidth * d.pixelRatio).toBe(d.physicalWidth);
      expect(d.logicalHeight * d.pixelRatio).toBe(d.physicalHeight);
    }
  });
});
