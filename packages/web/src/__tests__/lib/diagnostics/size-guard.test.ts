import { describe, it, expect } from "vitest";
import { enforceSizeCap, BUNDLE_SIZE_CAP_BYTES } from "@/lib/diagnostics/size-guard";

describe("enforceSizeCap", () => {
  it("returns bundle unchanged when under cap", () => {
    const small = {
      schemaVersion: "pinchy.bugreport.v1",
      scope: { includedTurnRange: [0, 1] },
      spans: [{ x: "hi" }],
    };
    const result = enforceSizeCap(small as never);
    expect(result.bundle).toEqual(small);
    expect(result.dropped).toBe(0);
  });

  it("drops oldest spans iteratively when over cap, updates includedTurnRange", () => {
    const big = {
      schemaVersion: "pinchy.bugreport.v1",
      scope: { includedTurnRange: [0, 9] },
      spans: Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, blob: "x".repeat(1_000_000) })),
    };
    const result = enforceSizeCap(big as never);
    expect(result.bundle.spans.length).toBeLessThan(10);
    expect(result.bundle.scope.includedTurnRange[0]).toBeGreaterThan(0);
    expect(result.dropped).toBeGreaterThan(0);
    const serialized = JSON.stringify(result.bundle);
    expect(serialized.length).toBeLessThanOrEqual(BUNDLE_SIZE_CAP_BYTES);
  });

  it("preserves the anchor (newest span) even under heavy pressure", () => {
    const big = {
      schemaVersion: "pinchy.bugreport.v1",
      scope: { includedTurnRange: [0, 9] },
      spans: Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, blob: "x".repeat(1_000_000) })),
    };
    const result = enforceSizeCap(big as never);
    expect(result.bundle.spans[result.bundle.spans.length - 1].name).toBe("t9");
  });
});
