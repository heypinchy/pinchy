import { describe, expect, it } from "vitest";
import { fingerprintPublished } from "@/lib/eval/fingerprint";

const cell = (over: Record<string, unknown> = {}) => ({
  model: "deepseek-v4-pro",
  n: 12,
  passes: 12,
  passRate: 1,
  tagHistogram: { "amount-not-captured": 12 },
  ...over,
});

const scenarios = (models: unknown[]) => [
  { label: "hetzner-invoice-models", slug: "happy-path", models },
];

/** Shaped like `buildExport()` minus the release metadata. */
const payload = (over: Record<string, unknown> = {}) => ({
  scenarios: scenarios([cell()]),
  comparisons: [{ a: "deepseek-v4-pro", b: "glm-5.1", ci: [0.1, 0.4], tied: false }],
  ...over,
});

describe("fingerprintPublished", () => {
  it("is a stable hex digest", () => {
    expect(fingerprintPublished(payload())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is identical for identical numbers", () => {
    expect(fingerprintPublished(payload())).toBe(fingerprintPublished(payload()));
  });

  it("ignores key insertion order, which run order can permute", () => {
    const a = payload({ scenarios: scenarios([cell({ tagHistogram: { p: 3, q: 9 } })]) });
    const b = payload({ scenarios: scenarios([cell({ tagHistogram: { q: 9, p: 3 } })]) });
    expect(fingerprintPublished(a)).toBe(fingerprintPublished(b));
  });

  // Each of these is a published number moving — the MAJOR/MINOR cases the
  // dataset's versioning rule says must be recorded before they can ship.
  it.each([
    ["a pass flipping", payload({ scenarios: scenarios([cell({ passes: 11 })]) })],
    ["a cell's n changing", payload({ scenarios: scenarios([cell({ n: 11 })]) })],
    [
      "a re-tagged failure",
      payload({ scenarios: scenarios([cell({ tagHistogram: { honest: 12 } })]) }),
    ],
    ["a model added", payload({ scenarios: scenarios([cell(), cell({ model: "glm-5.1" })]) })],
    // pass^k comparisons (#796) are derived from the scenarios, but through
    // statistics of their own: a change to the pooled-SE math moves published
    // numbers while every cell stays put. Hashing only the scenarios would miss
    // exactly that.
    [
      "a comparison's interval moving",
      payload({ comparisons: [{ a: "deepseek-v4-pro", b: "glm-5.1", ci: [0, 0.4], tied: true }] }),
    ],
    ["a whole published field appearing", payload({ passAtK: [{ model: "glm-5.1", k: 3 }] })],
  ])("changes when %s", (_case, mutated) => {
    expect(fingerprintPublished(mutated)).not.toBe(fingerprintPublished(payload()));
  });
});
