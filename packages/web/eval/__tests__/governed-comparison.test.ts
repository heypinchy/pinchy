// #723: governed-tools comparison sweep — the before/after export surface.
//
// Per (model, scenario) it pairs the UNGOVERNED cell (the frozen Eval-v1
// baseline under the plain label) with the GOVERNED cell (the "-governed" arm
// swept with the write guards on) and reports the delta. Four scenarios: the
// two the guards target (duplicate-guard, silent-failure) plus two regression
// controls (happy-path, line-items).
//
// The structure follows the `robustness` precedent: it is spread into
// buildExport() CONDITIONALLY — absent while no "-governed" data exists — so the
// dataset fingerprint (and byte output) does not move until real governed
// numbers land. The first governed sweep makes the key appear; that is the
// intended version-bump prompt.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  buildExport,
  buildGovernedComparison,
  GOVERNED_COMPARISON_SLUGS,
} from "../export-scorecard";

let nextLatency = 5000;
const row = (model: string, passed: boolean): string =>
  JSON.stringify({ model, passed, tags: [], notes: [], latencyMs: nextLatency++ });

describe("buildGovernedComparison against the committed dataset (no -governed data yet)", () => {
  it("covers exactly the four designated comparison scenarios, in order", async () => {
    const comparison = await buildGovernedComparison();
    expect(comparison.map((s) => s.slug)).toEqual([...GOVERNED_COMPARISON_SLUGS]);
  });

  it("marks every scenario not-yet-run until its -governed sweep lands", async () => {
    const comparison = await buildGovernedComparison();
    for (const s of comparison) {
      expect(s.status, s.slug).toBe("not-yet-run");
      expect(s.models, s.slug).toEqual([]);
    }
  });

  it("buildExport OMITS governedComparison entirely while no governed data exists (no fingerprint move)", async () => {
    const exported = await buildExport();
    expect("governedComparison" in exported).toBe(false);
  });
});

describe("buildGovernedComparison against a fixture with both arms", () => {
  async function fixtureDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-governed-fixture-"));
    // duplicate-guard, ungoverned baseline: alpha files the dup 3/4 times.
    await writeFile(
      path.join(dir, "hetzner-invoice-duplicate-models.jsonl"),
      [
        row("ollama-cloud/alpha", false),
        row("ollama-cloud/alpha", false),
        row("ollama-cloud/alpha", false),
        row("ollama-cloud/alpha", true),
        row("beta", false),
      ].join("\n") + "\n"
    );
    // duplicate-guard, governed arm: the guard blocks the dup, alpha now 4/4;
    // beta is absent from the governed arm (only-one-arm case).
    await writeFile(
      path.join(dir, "hetzner-invoice-duplicate-models-governed.jsonl"),
      [
        row("ollama-cloud/alpha", true),
        row("ollama-cloud/alpha", true),
        row("ollama-cloud/alpha", true),
        row("ollama-cloud/alpha", true),
      ].join("\n") + "\n"
    );
    return dir;
  }

  it("pairs cells per model and reports governed − ungoverned as the delta", async () => {
    const comparison = await buildGovernedComparison(await fixtureDir());
    const dup = comparison.find((s) => s.slug === "duplicate-guard")!;
    expect(dup.status).toBeUndefined(); // published now — governed data exists

    const alpha = dup.models.find((m) => m.model === "alpha")!;
    expect(alpha.ungoverned).toMatchObject({ n: 4, passes: 1 });
    expect(alpha.governed).toMatchObject({ n: 4, passes: 4 });
    // 4/4 − 1/4 = +0.75
    expect(alpha.delta).toBeCloseTo(0.75, 5);
  });

  it("keeps a model present in only the ungoverned arm, with a null governed cell and null delta", async () => {
    const comparison = await buildGovernedComparison(await fixtureDir());
    const dup = comparison.find((s) => s.slug === "duplicate-guard")!;
    const beta = dup.models.find((m) => m.model === "beta")!;
    expect(beta.ungoverned).toMatchObject({ n: 1, passes: 0 });
    expect(beta.governed).toBeNull();
    expect(beta.delta).toBeNull();
  });

  it("a scenario with no -governed file stays not-yet-run even when another has data", async () => {
    const comparison = await buildGovernedComparison(await fixtureDir());
    const silent = comparison.find((s) => s.slug === "silent-failure")!;
    expect(silent.status).toBe("not-yet-run");
  });

  it("buildExport INCLUDES governedComparison once any governed arm has data", async () => {
    const exported = await buildExport(await fixtureDir());
    expect("governedComparison" in exported).toBe(true);
    expect(exported.governedComparison!.map((s) => s.slug)).toEqual([...GOVERNED_COMPARISON_SLUGS]);
  });
});
