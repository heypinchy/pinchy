/**
 * Keeps `eval/data/README.md`'s comparison claims honest against the committed
 * dataset (pinchy#797).
 *
 * The README tells a reader how much of the leaderboard to believe — "76 of the
 * 91 model pairs are tied", "none survives a Benjamini-Hochberg correction". A
 * re-sweep moves those numbers, and prose does not fail CI. That is exactly the
 * gap `scorecard-triage-guard.test.ts` exists to close for the triage ledger:
 * committed evidence nobody re-reads protects nobody.
 *
 * So this guard PARSES the claims out of the README rather than restating them,
 * which means the README itself cannot drift. Whoever commits a fresh scorecard
 * gets a red test naming the sentence to fix.
 *
 * Like that guard it runs in vitest against the checked-in data (no docker, no
 * API keys), because `pnpm eval:models` needs both and CI only runs
 * `eval:selftest`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pooledClusteredDifference } from "../../src/lib/eval/comparisons";
import { buildComparisons, buildPublishedScenarios } from "../export-scorecard";

const scenarios = await buildPublishedScenarios();
const comparisons = buildComparisons(scenarios);
const readme = await readFile(path.join(__dirname, "..", "data", "README.md"), "utf8");

/** Pulls one number out of a README sentence, failing loudly if the sentence moved. */
function claim(pattern: RegExp, what: string): number {
  const match = readme.match(pattern);
  if (!match) {
    throw new Error(
      `eval/data/README.md no longer states ${what} in a form this guard can read ` +
        `(${pattern}). The claim and its guard must move together — update the regex ` +
        `if you rewrote the sentence, and re-check the number while you are there.`
    );
  }
  return Number(match[1]);
}

describe("published comparison claims match the committed dataset", () => {
  it("states the tie counts the data actually produces", () => {
    const tied = claim(/(\d+) of the \d+ model pairs are statistically \*\*tied\*\*/, "tied pairs");
    const total = claim(
      /\d+ of the (\d+) model pairs are statistically \*\*tied\*\*/,
      "total pairs"
    );
    const separating = claim(/only (\d+) separate/, "separating pairs");

    expect(comparisons.length).toBe(total);
    expect(comparisons.filter((c) => c.tied).length).toBe(tied);
    expect(comparisons.filter((c) => !c.tied).length).toBe(separating);
    expect(tied + separating).toBe(total);
  });

  it("has a comparison for every unordered pair of the models in the dataset", () => {
    const models = new Set(scenarios.flatMap((s) => s.models.map((m) => m.model)));
    expect(comparisons.length).toBe((models.size * (models.size - 1)) / 2);
  });

  it("states how many pairs the binomial floor actually binds for", () => {
    // The README claims the within-scenario term is not decorative. Verify it
    // from the OUTSIDE: rebuild the between-scenario-only SE the module used to
    // use, and count the pairs whose published SE is genuinely larger. Zero here
    // would mean the floor never binds and the README oversells it.
    const claimed = claim(/binding term for (\d+) of the \d+ pairs today/, "floor-bound pairs");

    const floorBound = comparisons.filter((c) => {
      const cellsFor = (model: string) =>
        scenarios.map((s) => s.models.find((m) => m.model === model));
      const as = cellsFor(c.a);
      const bs = cellsFor(c.b);
      const pairs = as.flatMap((a, i) => {
        const b = bs[i];
        return a && b ? [{ a, b }] : [];
      });
      const diffs = pairs
        .filter(({ a, b }) => a.n > 0 && b.n > 0)
        .map(({ a, b }) => a.passes / a.n - b.passes / b.n);
      if (diffs.length < 2) return false;

      const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
      const between = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (diffs.length - 1);
      const betweenOnlySe = Math.sqrt(between / diffs.length);
      // Against the UNROUNDED se: the published one is 3dp, which blurs the
      // margin for pairs where the two terms nearly coincide.
      const exactSe = pooledClusteredDifference(pairs).se;
      return exactSe !== null && exactSe > betweenOnlySe;
    }).length;

    expect(floorBound).toBe(claimed);
  });

  it("never publishes a zero-width interval", () => {
    // The collapse this module's SE exists to prevent: identical per-scenario
    // differences -> zero between-scenario spread -> a point interval asserting
    // a winner with certainty.
    for (const c of comparisons) {
      expect(c.ci[1] - c.ci[0], `${c.a} vs ${c.b} published a point interval`).toBeGreaterThan(0);
    }
  });

  it("publishes a `tied` flag a reader can recompute from the published bounds", () => {
    for (const c of comparisons) {
      expect(c.tied, `${c.a} vs ${c.b}`).toBe(c.ci[0] <= 0 && c.ci[1] >= 0);
    }
  });

  it("states truthfully that no separating pair survives Benjamini-Hochberg", () => {
    // BH at q=0.05 rejects nothing unless the smallest p clears 0.05/91. On 6 df
    // that means |t| > 6.6705 (bisected on the t CDF; p(6.6705, 6) = 5.495e-4).
    // Asserting it as a t threshold keeps a whole incomplete-beta implementation
    // out of the repo for one claim.
    expect(readme).toMatch(/none of them survives a Benjamini–Hochberg correction/i);
    const BH_STEP1_T = 6.6705;

    const maxT = Math.max(
      ...comparisons.filter((c) => c.se !== null && c.se > 0).map((c) => Math.abs(c.diff / c.se!))
    );
    expect(
      maxT,
      `A pair now clears the BH step-1 threshold, so the README's "none survives" claim is false. ` +
        `Re-check the multiplicity paragraph in eval/data/README.md.`
    ).toBeLessThan(BH_STEP1_T);
  });
});
