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
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildExport, buildPublishedScenarios, isPublished } from "../export-scorecard";
import { computePassHatK, PASS_HAT_K_LEVELS } from "../../src/lib/eval/scorecard";
import type { PromptVariantId } from "../../src/lib/eval/types";

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
    const pending = scenarios.filter((s) => !isPublished(s));
    expect(pending.map(({ label, slug, axis }) => ({ label, slug, axis }))).toEqual(NOT_YET_RUN);
  });

  it("publishes no numbers for a not-yet-run scenario", () => {
    for (const s of scenarios.filter((s) => !isPublished(s))) {
      expect(s.models, s.label).toEqual([]);
      expect(s.totalRuns, s.label).toBe(0);
      expect(s.tiedWithLeader, s.label).toEqual([]);
    }
  });

  it("keeps the seven invoice scenarios published and untouched by the marker", () => {
    const published = scenarios.filter(isPublished);
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

describe("published export: robustness block with today's data (#803 PR 3)", () => {
  // Not a single variant row exists in data/ yet, so BOTH new behaviors must be
  // provable no-ops: the primary-only headline filter changes no number
  // (DATASET_FINGERPRINT in dataset-version.test.ts is the standing proof) and
  // the robustness block must be ABSENT — no key at all, not an empty object,
  // so the serialized export stays byte-identical.
  it("emits no robustness key at all — absence, not an empty object", async () => {
    const exported = await buildExport();
    expect(Object.keys(exported)).not.toContain("robustness");
  });
});

describe("published export: robustness block with variant rows (#803 PR 3)", () => {
  interface FixtureRow {
    model: string;
    passed: boolean;
    promptVariant?: PromptVariantId;
    tags?: string[];
  }
  let nextLatency = 1000;
  const row = ({ model, passed, promptVariant, tags = [] }: FixtureRow): string =>
    JSON.stringify({
      model,
      passed,
      tags,
      notes: [],
      latencyMs: nextLatency++,
      // Absence of promptVariant IS the legacy-row fixture — do not default it.
      ...(promptVariant !== undefined ? { promptVariant } : {}),
    });

  /**
   * A minimal variant-bearing dataset. Only two scenario files exist; the other
   * nine registered scenarios surface as not-yet-run, which the export already
   * tolerates. Per model×scenario:
   * - alpha on happy-path: primary 2/2, v1 1/2 (a third v1 run is an excluded
   *   run-infra-error — an invalid trial in robustness exactly as in the
   *   headline), v2 0/2 → spread 1.
   * - alpha on distractor: primary 1/1, v1 1/1 → spread 0.
   * - beta: LEGACY rows only (no promptVariant field) — grandfathered into the
   *   primary headline, absent from robustness.
   */
  async function buildVariantFixtureExport(): Promise<Awaited<ReturnType<typeof buildExport>>> {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-variant-fixture-"));
    const happy = [
      row({ model: "ollama-cloud/alpha", passed: true, promptVariant: "primary" }),
      row({ model: "ollama-cloud/alpha", passed: true, promptVariant: "primary" }),
      row({ model: "ollama-cloud/alpha", passed: true, promptVariant: "v1" }),
      row({ model: "ollama-cloud/alpha", passed: false, promptVariant: "v1" }),
      row({
        model: "ollama-cloud/alpha",
        passed: false,
        promptVariant: "v1",
        tags: ["run-infra-error"],
      }),
      row({ model: "ollama-cloud/alpha", passed: false, promptVariant: "v2" }),
      row({ model: "ollama-cloud/alpha", passed: false, promptVariant: "v2" }),
      row({ model: "beta", passed: true }),
      row({ model: "beta", passed: false }),
      // gamma's only paraphrase run is an invalid trial: after excluding it,
      // just one wording (primary) has a rate — no comparison, no cell.
      row({ model: "gamma", passed: true, promptVariant: "primary" }),
      row({ model: "gamma", passed: false, promptVariant: "v1", tags: ["run-infra-error"] }),
    ];
    const distractor = [
      row({ model: "ollama-cloud/alpha", passed: true, promptVariant: "primary" }),
      row({ model: "ollama-cloud/alpha", passed: true, promptVariant: "v1" }),
    ];
    await writeFile(path.join(dir, "hetzner-invoice-models.jsonl"), `${happy.join("\n")}\n`);
    await writeFile(
      path.join(dir, "hetzner-invoice-distractor-models.jsonl"),
      `${distractor.join("\n")}\n`
    );
    return buildExport(dir);
  }

  const exportedPromise = buildVariantFixtureExport();

  it("publishes per-variant pass rates, spread, and the per-model mean spread", async () => {
    const exported = await exportedPromise;
    expect(exported.robustness).toEqual({
      scenarios: [
        {
          label: "hetzner-invoice-models",
          models: [
            {
              model: "alpha",
              variants: { primary: 1, v1: 0.5, v2: 0 },
              spread: 1,
            },
          ],
        },
        {
          label: "hetzner-invoice-distractor-models",
          models: [{ model: "alpha", variants: { primary: 1, v1: 1 }, spread: 0 }],
        },
      ],
      models: [{ model: "alpha", meanSpread: 0.5, scenarios: 2 }],
    });
  });

  it("keeps the headline primary-only: variant rows move no headline number", async () => {
    const exported = await exportedPromise;
    const happy = exported.scenarios.find((s) => s.label === "hetzner-invoice-models");
    expect(happy).toBeDefined();
    // 2 alpha primary + 2 beta legacy + 1 gamma primary rows; the 6 variant
    // rows are robustness data, not headline trials.
    expect(happy?.totalRuns).toBe(5);
    expect(
      happy?.models.map(({ model, n, passes, passRate }) => ({ model, n, passes, passRate }))
    ).toEqual([
      { model: "alpha", n: 2, passes: 2, passRate: 1 },
      { model: "gamma", n: 1, passes: 1, passRate: 1 },
      { model: "beta", n: 2, passes: 1, passRate: 0.5 },
    ]);
  });

  it("grandfathers legacy rows (no promptVariant) into the primary headline", async () => {
    const exported = await exportedPromise;
    const happy = exported.scenarios.find((s) => s.label === "hetzner-invoice-models");
    const beta = happy?.models.find((m) => m.model === "beta");
    // Both beta rows lack the field entirely and still count as primary trials.
    expect(beta?.n).toBe(2);
    // And a variant-free model never enters robustness — spread over one
    // wording would be a claim from no comparison.
    const robustnessModels = exported.robustness?.scenarios.flatMap((s) =>
      s.models.map((m) => m.model)
    );
    expect(robustnessModels).not.toContain("beta");
  });
});
