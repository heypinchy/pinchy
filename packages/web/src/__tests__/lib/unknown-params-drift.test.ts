/**
 * Drift-guard: the unknown-parameter check that the write tools run at their
 * own edge is duplicated across pinchy-email and pinchy-files
 * (`unknown-params.ts`). Plugins are separate packages loaded by OpenClaw from
 * their own directories, so neither can import the other's copy.
 *
 * Both copies guard the same promise — a tool call carries nothing the tool
 * does not read, so the approval card cannot offer a look-alike key the tool
 * ignores. A fix to one copy that misses the other would
 * leave half the write tools on the old behaviour, so the two must stay
 * byte-identical.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COPIES = ["pinchy-email", "pinchy-files"].map((plugin) =>
  resolve(import.meta.dirname, `../../../../plugins/${plugin}/unknown-params.ts`)
);

describe("unknown-params.ts drift guard", () => {
  it("is identical in every plugin that carries it", () => {
    const [first, ...rest] = COPIES.map((file) => readFileSync(file, "utf8"));
    expect(first).toContain("export function unknownParams(");
    for (const copy of rest) expect(copy).toBe(first);
  });
});
