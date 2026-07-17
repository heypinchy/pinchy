/**
 * Pins the per-cell contract of the PUBLISHED export — the fields the
 * /reliability hub and heypinchy-website#141 read out of `data.json`.
 *
 * The estimator itself has unit tests (`src/lib/eval/__tests__/scorecard.test.ts`).
 * What those cannot see is the WIRING: before this file, deleting
 * `passHatK: passHatKCurve(passes, n)` from `aggregate()` — or swapping its two
 * arguments, which is invisible on the all-pass cells — left `pnpm test` green
 * while the curve vanished from the website's only data source. Same contract
 * as the triage guard next door: judge the numbers we actually publish.
 */
import { describe, it, expect } from "vitest";
import { buildPublishedScenarios } from "../export-scorecard";
import { computePassHatK, PASS_HAT_K_LEVELS } from "../../src/lib/eval/scorecard";

const cells = (await buildPublishedScenarios()).flatMap((s) =>
  s.models.map((m) => ({ ...m, where: `${s.label} / ${m.model}` }))
);

describe("published export: pass^k curve", () => {
  it("carries a curve on every published cell", () => {
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.passHatK, c.where).toBeDefined();
    }
  });

  it("reports exactly the standard k levels at or below the cell's n", () => {
    for (const c of cells) {
      const expected = PASS_HAT_K_LEVELS.filter((k) => k <= c.n);
      expect(
        c.passHatK.map((p) => p.k),
        `${c.where} (n=${c.n})`
      ).toEqual([...expected]);
    }
  });

  it("recomputes from the cell's own passes/n — catches swapped arguments", () => {
    for (const c of cells) {
      for (const { k, value } of c.passHatK) {
        const expected = Number(computePassHatK(c.passes, c.n, k).toFixed(3));
        expect(value, `${c.where} at k=${k}`).toBe(expected);
      }
    }
  });

  it("anchors at k=1 = passRate, the published capability number", () => {
    for (const c of cells) {
      expect(c.passHatK.find((p) => p.k === 1)?.value, c.where).toBe(c.passRate);
    }
  });

  it("decays monotonically — k in a row is never easier than fewer", () => {
    for (const c of cells) {
      for (let i = 1; i < c.passHatK.length; i++) {
        expect(c.passHatK[i].value, `${c.where} at k=${c.passHatK[i].k}`).toBeLessThanOrEqual(
          c.passHatK[i - 1].value
        );
      }
    }
  });

  it("is all-1 exactly for the passAllK cells (and n=0 is not one)", () => {
    for (const c of cells) {
      expect(c.passAllK, c.where).toBe(c.n > 0 && c.passHatK.every((p) => p.value === 1));
    }
  });
});
