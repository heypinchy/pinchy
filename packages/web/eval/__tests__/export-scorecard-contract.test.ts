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

const scenarios = await buildPublishedScenarios();

const cells = scenarios.flatMap((s) =>
  s.models.map((m) => ({ ...m, where: `${s.label} / ${m.model}` }))
);

describe("published export: scenario roster and not-yet-run tolerance", () => {
  // The four crm-lead scenarios are registered before their sweep has run
  // (#803): their data files do not exist yet, and the export must say so
  // explicitly instead of publishing a silent 0-run scorecard.
  const NOT_YET_RUN = [
    { label: "crm-lead-models", slug: "crm-lead", axis: "generalization: task capability" },
    {
      label: "crm-lead-duplicate-models",
      slug: "crm-lead-duplicate",
      axis: "generalization: verify before write",
    },
    {
      label: "crm-lead-rejected-models",
      slug: "crm-lead-rejected",
      axis: "generalization: honesty under loud failure",
    },
    {
      label: "crm-lead-silent-failure-models",
      slug: "crm-lead-silent-failure",
      axis: "generalization: honesty under silent failure",
    },
  ];

  it("exports all 11 scenarios", () => {
    expect(scenarios).toHaveLength(11);
  });

  it("marks exactly the four crm-lead scenarios not-yet-run, with their axes", () => {
    const pending = scenarios.filter((s) => s.status === "not-yet-run");
    expect(pending.map(({ label, slug, axis }) => ({ label, slug, axis }))).toEqual(NOT_YET_RUN);
  });

  it("publishes no numbers for a not-yet-run scenario", () => {
    for (const s of scenarios.filter((s) => s.status === "not-yet-run")) {
      expect(s.models, s.label).toEqual([]);
      expect(s.totalRuns, s.label).toBe(0);
      expect(s.tiedWithLeader, s.label).toEqual([]);
    }
  });

  it("keeps the seven invoice scenarios published and untouched by the marker", () => {
    const published = scenarios.filter((s) => s.status === undefined);
    expect(published.map((s) => s.label)).toEqual([
      "hetzner-invoice-models",
      "hetzner-invoice-distractor-models",
      "hetzner-invoice-conflict-models",
      "hetzner-invoice-lineitems-models",
      "hetzner-invoice-duplicate-models",
      "hetzner-invoice-rejected-models",
      "hetzner-invoice-silent-failure-models",
    ]);
    for (const s of published) {
      // Published entries must not carry a status key at all: the dataset
      // fingerprint hashes them, so even `status: undefined` appearing as a
      // key would be invisible here but a new field there.
      expect(Object.keys(s), s.label).not.toContain("status");
      expect(s.models.length, s.label).toBeGreaterThan(0);
    }
  });
});

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
