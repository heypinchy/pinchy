/**
 * Wires the committed eval scorecards to the tools blocklist (pinchy#669,
 * pinchy#766).
 *
 * The gap this closes: the 2026-07-11 sweep measured `minimax-m3` at 0/12 on
 * line-items — the scenario that needs nested-array tool arguments — and the
 * number sat committed in this repo until the same defect took down a
 * production agent four days later. Nothing read it, because nothing was
 * looking.
 *
 * This runs in vitest against the CHECKED-IN dataset, so it costs a second in
 * every CI run. The sweep itself cannot gate anything: `pnpm eval:models` needs
 * the docker stack plus live API keys at ~72s/run, and CI only ever runs
 * `eval:selftest`. Whoever commits a fresh scorecard gets the red test here.
 */
import { describe, it, expect } from "vitest";
import { buildPublishedScenarios } from "../export-scorecard";
import { TRIAGE_LEDGER, type TriageEntry } from "../triage-ledger";
import { findCatastrophicCells, type CatastrophicCell } from "../../src/lib/eval/outliers";
import { getBlockReason } from "../../src/lib/model-resolver/blocklist";

const key = (c: { scenario: string; model: string }) => `${c.scenario} / ${c.model}`;

/** Reading the whole dataset re-grades three scenarios from their trajectories. */
const flagged: CatastrophicCell[] = findCatastrophicCells(await buildPublishedScenarios());

function ledgerEntry(cell: { scenario: string; model: string }): TriageEntry | undefined {
  return TRIAGE_LEDGER.find((e) => e.scenario === cell.scenario && e.model === cell.model);
}

describe("eval scorecard triage guard", () => {
  it("flags the cells a capable model never once passed", () => {
    // Pinned so a re-sweep that changes WHICH cells are catastrophic shows up
    // as a diff to read, not as a silent shift under the ledger.
    expect(flagged.map(key)).toEqual([
      "duplicate-guard / gemma4:31b",
      "line-items / minimax-m3",
      "silent-failure / gemma4:31b",
      "silent-failure / qwen3.5:397b",
    ]);
  });

  // vitest's `it.each([])` registers zero tests and reports success — it is not
  // an error (checked against 4.1.10). So an empty `flagged` would silently
  // reduce all three per-cell blocks below to nothing and leave this guard
  // green while guarding nothing at all.
  it("has cells to guard at all", () => {
    expect(
      flagged.length,
      `findCatastrophicCells returned nothing, which turns the per-cell blocks in this file into zero tests.\n` +
        `If a re-sweep really did clear every catastrophic cell, that is good news — but delete those blocks and this one deliberately.\n` +
        `More likely the dataset moved or buildPublishedScenarios stopped finding it: check packages/web/eval/data first.`
    ).toBeGreaterThan(0);
  });

  it.each(flagged.map((c) => [key(c), c] as const))(
    "%s carries a committed verdict",
    (_label, cell) => {
      const entry = ledgerEntry(cell);

      expect(
        entry,
        `${key(cell)} scored 0/${cell.n} — a model with a capability median of ${cell.capabilityMedian.toFixed(2)} never passed a single run.\n` +
          `Tags: ${JSON.stringify(cell.tags)}\n\n` +
          `Look at it, then record what you concluded in packages/web/eval/triage-ledger.ts:\n` +
          `  - verdict "blocked" if blocklist.ts should name this model (it must already, for the capabilities you list), or\n` +
          `  - verdict "accepted" with the reason it is NOT blocklist material (a judgement or honesty defect is not a tools defect).\n` +
          `Do not derive the verdict from this number alone: the eval grades outcomes, never tool-call payloads.`
      ).toBeDefined();
    }
  );

  // A "blocked" verdict is a claim about blocklist.ts. If a rule is softened or
  // dropped, the ledger must not keep asserting a protection that is gone.
  //
  // The `ollama-cloud/` prefix is hardcoded because every model this sweep
  // covers is an ollama-cloud one. A ledger entry for a model from elsewhere
  // would look up an id that does not exist and fail here — loudly, which is
  // the right way for this assumption to end.
  it.each(TRIAGE_LEDGER.filter((e) => e.verdict === "blocked"))(
    "$scenario / $model is really blocked for $blockedFor",
    (entry) => {
      if (entry.verdict !== "blocked") throw new Error("filtered above");

      expect(
        getBlockReason(`ollama-cloud/${entry.model}`, entry.blockedFor),
        `The ledger says ${key(entry)} is blocked for ${entry.blockedFor.join(", ")}, but blocklist.ts allows it.\n` +
          `Either restore the rule, or change the verdict to "accepted" and say why the block is no longer right.`
      ).not.toBeNull();
    }
  );

  // The other drift direction: evidence disappears, verdict outlives it.
  it.each(TRIAGE_LEDGER.map((e) => [key(e), e] as const))(
    "%s is still a flagged cell",
    (_label, entry) => {
      expect(
        flagged.some((c) => c.scenario === entry.scenario && c.model === entry.model),
        `packages/web/eval/triage-ledger.ts still carries a verdict on ${key(entry)}, but that cell is no longer catastrophic — the evidence it rests on is gone.\n` +
          `Delete the entry. If it is a "blocked" verdict, decide deliberately whether the blocklist rule still stands: this eval corroborates rules, it does not carry them on its own.`
      ).toBe(true);
    }
  );

  it("gives every verdict a reason and evidence a human can follow", () => {
    for (const entry of TRIAGE_LEDGER) {
      expect(entry.reason.length, `${key(entry)} needs a real reason`).toBeGreaterThan(40);
      expect(entry.evidence, `${key(entry)} needs evidence`).toMatch(/eval\/data\/|pinchy#\d+/);
    }
  });
});
