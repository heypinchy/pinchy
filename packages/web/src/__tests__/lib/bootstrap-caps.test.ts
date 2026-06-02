import { describe, it, expect } from "vitest";
import {
  resolveBootstrapCaps,
  OPENCLAW_DEFAULT_BOOTSTRAP_MAX_CHARS,
  OPENCLAW_DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS,
  BOOTSTRAP_PER_FILE_CEILING_CHARS,
  BOOTSTRAP_TOTAL_CEILING_CHARS,
  BOOTSTRAP_HEADROOM_CHARS,
} from "@/lib/openclaw-config/bootstrap-caps";

// Issue #373: OpenClaw's prompt-bootstrap embedding caps each embedded file
// (notably the agent's own AGENTS.md) at DEFAULT_BOOTSTRAP_MAX_CHARS = 12_000
// chars and the combined total at 60_000. Above the cap it injects a truncation
// marker ("[...truncated, read AGENTS.md for full content...]" /
// "…(truncated AGENTS.md: ...)") into the agent's context — which (a) silently
// drops the middle of the agent's instructions and (b) leaks the literal marker
// into output when the agent reproduces its instructions. Pinchy fixes this by
// emitting a per-agent bootstrapMaxChars sized to the agent's actual bootstrap
// files so the auto-injection stays complete.
describe("resolveBootstrapCaps", () => {
  it("emits no override when instructions fit the default budget", () => {
    const caps = resolveBootstrapCaps([5_000, 2_000]);

    expect(caps).toEqual({ oversized: false });
  });

  it("treats files exactly at the default cap as fitting (no override)", () => {
    const caps = resolveBootstrapCaps([OPENCLAW_DEFAULT_BOOTSTRAP_MAX_CHARS]);

    expect(caps).toEqual({ oversized: false });
  });

  it("raises the per-file cap to fit an AGENTS.md larger than the default, with headroom", () => {
    const caps = resolveBootstrapCaps([20_000, 3_000]);

    // Must fit the largest single bootstrap file with a margin, so a small later
    // edit or OpenClaw-side framing doesn't push it back over the cap.
    expect(caps.bootstrapMaxChars).toBe(20_000 + BOOTSTRAP_HEADROOM_CHARS);
    expect(caps.bootstrapMaxChars).toBeGreaterThan(20_000);
    // 20k + 3k = 23k still fits the 60k default total budget, so no total override.
    expect(caps.bootstrapTotalMaxChars).toBeUndefined();
    expect(caps.oversized).toBe(false);
  });

  it("leaves headroom above the file size even just over the default cap", () => {
    const caps = resolveBootstrapCaps([13_000]);

    expect(caps.bootstrapMaxChars).toBe(13_000 + BOOTSTRAP_HEADROOM_CHARS);
    expect(caps.bootstrapMaxChars).toBeGreaterThan(13_000);
    expect(caps.oversized).toBe(false);
  });

  it("raises the total cap when many files sum above the default total, with headroom", () => {
    const caps = resolveBootstrapCaps([11_000, 11_000, 11_000, 11_000, 11_000, 11_000]);

    // Each file is under the per-file default, so only the total needs raising.
    expect(caps.bootstrapMaxChars).toBeUndefined();
    expect(caps.bootstrapTotalMaxChars).toBe(66_000 + BOOTSTRAP_HEADROOM_CHARS);
    expect(caps.bootstrapTotalMaxChars).toBeGreaterThan(66_000);
    expect(caps.oversized).toBe(false);
  });

  it("clamps the per-file cap to the ceiling and flags oversized for an extreme AGENTS.md", () => {
    const caps = resolveBootstrapCaps([200_000]);

    expect(caps.bootstrapMaxChars).toBe(BOOTSTRAP_PER_FILE_CEILING_CHARS);
    // Total budget must still fit the (clamped) per-file budget.
    expect(caps.bootstrapTotalMaxChars).toBe(BOOTSTRAP_TOTAL_CEILING_CHARS);
    expect(caps.oversized).toBe(true);
  });

  it("ignores zero, negative, and non-finite sizes", () => {
    const caps = resolveBootstrapCaps([0, -10, Number.NaN, Number.POSITIVE_INFINITY, 5_000]);

    expect(caps).toEqual({ oversized: false });
  });

  it("returns no override for an agent with no bootstrap files", () => {
    const caps = resolveBootstrapCaps([]);

    expect(caps).toEqual({ oversized: false });
  });
});
