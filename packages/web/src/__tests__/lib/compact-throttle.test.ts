import { describe, it, expect, beforeEach, vi } from "vitest";

// Re-import per test so the module-level Map starts fresh (the throttle is
// intentionally stateful across calls within a process).
describe("allowCompaction", () => {
  beforeEach(() => vi.resetModules());

  it("allows the first compaction, throttles a second within the window", async () => {
    const { allowCompaction, COMPACT_MIN_INTERVAL_MS } = await import("@/lib/compact-throttle");
    expect(allowCompaction("k", 1000)).toBe(true);
    expect(allowCompaction("k", 1000 + COMPACT_MIN_INTERVAL_MS - 1)).toBe(false);
  });

  it("allows again once the window has fully elapsed", async () => {
    const { allowCompaction, COMPACT_MIN_INTERVAL_MS } = await import("@/lib/compact-throttle");
    expect(allowCompaction("k", 1000)).toBe(true);
    expect(allowCompaction("k", 1000 + COMPACT_MIN_INTERVAL_MS)).toBe(true);
  });

  it("throttles per session key independently", async () => {
    const { allowCompaction } = await import("@/lib/compact-throttle");
    expect(allowCompaction("a", 1000)).toBe(true);
    // A different session is unaffected by `a`'s recent compaction.
    expect(allowCompaction("b", 1000)).toBe(true);
    // `a` again within the window is throttled.
    expect(allowCompaction("a", 1000)).toBe(false);
  });
});
