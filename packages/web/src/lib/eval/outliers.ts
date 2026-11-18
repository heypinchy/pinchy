/**
 * Finds the eval-v1 scorecard cells that nobody is allowed to leave unread
 * (pinchy#669, pinchy#766).
 *
 * WHY THIS EXISTS. On 2026-07-11 the model sweep measured
 * `minimax-m3` at 0/12 on the line-items scenario — the scenario that needs
 * `account.move` `invoice_line_ids` command triplets, i.e. nested arrays. Four
 * days later the production agent "Penny" failed to book invoices on exactly
 * that model, for exactly that defect. The number was committed in this repo
 * the whole time. Nothing connected it to anything, so nobody read it.
 *
 * These functions are pure over the PUBLISHED scorecards (see
 * `eval/export-scorecard.ts`); `eval/__tests__/scorecard-triage-guard.test.ts`
 * turns their output into a CI failure unless every flagged cell carries a
 * committed verdict in `eval/triage-ledger.ts`. Pure eval logic lives here
 * rather than under `eval/` by the convention its siblings follow (graders,
 * scorecard, normalize — see eval/README.md's layout section).
 *
 * WHAT A FLAG MEANS, AND WHAT IT DOES NOT. A flag says "a capable model never
 * once succeeded here — someone must look and record what they concluded". It
 * does NOT say the model's tools are broken, and it must never grow into a
 * mechanism for generating blocklist rules: this eval measures OUTCOMES. It
 * re-reads Odoo state after the run; it never inspects a tool-call payload. It
 * can ground a suspicion, not a cause. The ledger is where a human writes down
 * which kind of defect a flagged cell actually is — the four cells flagged
 * today have three different answers.
 */

/** A published scorecard cell. Structurally satisfied by `export-scorecard.ts`'s output. */
export interface OutlierCell {
  model: string;
  /** Trials, with invalid ones (`run-infra-error`) already excluded. */
  n: number;
  passes: number;
  passRate: number;
  tagHistogram: Record<string, number>;
}

export interface OutlierScenario {
  slug: string;
  models: readonly OutlierCell[];
}

export interface CatastrophicCell {
  /** The scenario's published slug, e.g. `line-items`. */
  scenario: string;
  model: string;
  n: number;
  /** The model's median pass rate across the OTHER capability scenarios. */
  capabilityMedian: number;
  /** The cell's failure tags, verbatim — the first thing a triager reads. */
  tags: Record<string, number>;
}

/**
 * The scenarios that measure whether a model can drive the tool loop at all
 * (read the mail, pick the document, extract the fields, enter the record).
 * The judgement and honesty scenarios (duplicate-guard, silent-failure,
 * hard-rejection) are deliberately NOT anchors: a model can score well on them
 * by incapacity — never getting far enough to lie or to duplicate — so they
 * say nothing about whether it is capable. See eval/data/README.md.
 */
export const CAPABILITY_SCENARIO_SLUGS = [
  "happy-path",
  "distractor-inbox",
  "conflicting-data",
  "line-items",
] as const;

/**
 * A model must clear this median pass rate across the capability scenarios
 * before its zero counts as an outlier worth a human's time. Set at 0.5 from
 * the 2026-07-11 sweep: it separates the models whose zeros carry information
 * (minimax-m3 0.83, gemma4:31b 0.92, qwen3.5:397b 0.96) from the ones that are
 * simply weak everywhere (deepseek-v3.2 0.08, gpt-oss:20b and mistral-large-3
 * both 0.0). Nothing lands between 0.08 and 0.83, so the constant is placed in
 * a wide gap rather than fitted to the data — anywhere in that range flags the
 * same four cells.
 */
export const CAPABILITY_FLOOR = 0.5;

/** Below this many trials a zero is thin evidence, not a finding. */
export const MIN_RUNS = 8;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The model's median pass rate across the capability scenarios, EXCLUDING
 * `exceptSlug`. The exclusion matters: the cell under judgement is by
 * definition a zero, and letting it drag down the anchor that decides whether
 * it's worth flagging is circular — a bad enough outlier would disqualify
 * itself. Returns null when the model has no other capability coverage to
 * judge by, which is not the same as "not capable".
 */
function capabilityMedian(
  scenarios: readonly OutlierScenario[],
  model: string,
  exceptSlug: string
): number | null {
  const rates = scenarios
    .filter(
      (s) =>
        s.slug !== exceptSlug && (CAPABILITY_SCENARIO_SLUGS as readonly string[]).includes(s.slug)
    )
    .flatMap((s) => s.models.filter((m) => m.model === model).map((m) => m.passRate));
  return median(rates);
}

/**
 * Every cell where a demonstrably capable model never passed a single run.
 * Ordered by scenario, then model, so the guard's failure message is stable.
 */
export function findCatastrophicCells(scenarios: readonly OutlierScenario[]): CatastrophicCell[] {
  const flagged: CatastrophicCell[] = [];
  for (const scenario of scenarios) {
    for (const cell of scenario.models) {
      if (cell.passes !== 0 || cell.n < MIN_RUNS) continue;
      const anchor = capabilityMedian(scenarios, cell.model, scenario.slug);
      if (anchor === null || anchor < CAPABILITY_FLOOR) continue;
      flagged.push({
        scenario: scenario.slug,
        model: cell.model,
        n: cell.n,
        capabilityMedian: anchor,
        tags: cell.tagHistogram,
      });
    }
  }
  return flagged.sort(
    (a, b) => a.scenario.localeCompare(b.scenario) || a.model.localeCompare(b.model)
  );
}
