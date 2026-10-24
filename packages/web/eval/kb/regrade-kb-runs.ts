/**
 * Re-grades the PUBLISHED KB trajectories with the CURRENT graders, offline.
 *
 *   OLLAMA_CLOUD_API_KEY=… pnpm -C packages/web exec tsx eval/kb/regrade-kb-runs.ts
 *
 * This is the tool `data/README.md` has always pointed at ("read by humans and
 * by an offline re-grade") and the answer to a problem the harness kept hitting:
 * five sweeps in, four of them measured a grader defect rather than a model, and
 * each correction would otherwise have cost another full sweep — a docker stack,
 * an agent dispatch per run, hours of model time — to re-measure answers that
 * had not changed. A model's answer is the measurement. The verdict on it is a
 * function this repo owns, and a function can be re-run.
 *
 * So this reads the archived trajectories, re-derives everything downstream of
 * the raw answer, and writes a fresh verdict + evidence pair into `results/`.
 * What it does NOT touch is the answer itself, the retrieved set, the query or
 * the latency: those are the record of what happened, and nothing here may
 * rewrite them. `citedPassageTexts` IS re-derived — it is the premise the
 * grader chose, not something the model produced, and the parser fix in #1173
 * changes which sources an answer is understood to have cited.
 *
 * Premises come from the committed corpus manifest, not from Postgres. The
 * sweep reads `kb_chunks` because it grades while a seeded stack is up;
 * `seed-corpus.ts` writes `kb_chunks.chunk_text` verbatim from
 * `corpus/manifest.ts`, so offline the manifest IS that table, and a re-grade
 * that needed a database would not be an offline re-grade.
 *
 * Resumable, appending after each run: the judge is a network call and this
 * laptop travels. Re-invoking picks up where a dropped uplink left off, and
 * `--fresh` starts over.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { KB_EVAL_CORPUS, nearDuplicatePathGroups } from "./corpus/manifest";
import { GOLD_QA } from "./corpus/gold-qa";
import { premiseSourcePaths } from "./resolve-cited-paths";
import { readAllTrajectories, runKey } from "./published-dataset";
import type { PublishedTrajectory } from "./published-dataset";
import {
  RESULTS_DIR,
  appendRunResult,
  appendTrajectory,
  readExistingRuns,
  requireOllamaCloudApiKey,
} from "./run-kb-eval";
import { withTransportRetry } from "../transport-retry";
import { gradeKbRun } from "../../src/lib/eval/kb/answer-graders";
import type { KbRunTrajectory } from "../../src/lib/eval/kb/answer-graders";
import {
  DEFAULT_KB_JUDGE_MODEL,
  LlmAbstentionJudge,
  LlmNliClient,
  LlmRelevanceJudge,
  createOllamaCloudChatFn,
} from "../../src/lib/eval/kb/llm-nli";
import type { KbFailureTag, KbRunResultRow } from "../../src/lib/eval/kb/types";

/** Written to `results/`, then copied into `data/` by hand once the numbers have been read. */
export const REGRADE_LABEL = "kb-groundedness-regrade";

/**
 * Chunk texts per sourcePath, from the committed manifest — the offline stand-in
 * for `chunk-texts.ts`'s SELECT over `kb_chunks`. Pure, so the premise half of a
 * re-grade is testable without a database or an API key.
 */
export function chunkTextsByPath(
  corpus: typeof KB_EVAL_CORPUS = KB_EVAL_CORPUS
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const doc of corpus) {
    map.set(
      doc.sourcePath,
      doc.chunks.map((chunk) => chunk.text)
    );
  }
  return map;
}

/**
 * Rebuilds one run's grading input from its published trajectory.
 *
 * Pure, and separate from the judge loop below, because this is where the
 * re-grade earns its keep: `premiseSourcePaths` is the function #1173 fixed, so
 * which passages become the premise is exactly what changed. A re-grade that
 * reused the STORED `citedPassageTexts` would re-run the judge against the old
 * parser's premise set and reproduce the defect it exists to correct.
 */
export function rebuildTrajectory(
  published: PublishedTrajectory,
  texts: Map<string, string[]> = chunkTextsByPath()
): KbRunTrajectory {
  const citedPaths = premiseSourcePaths(published.answer, published.retrieved);
  return {
    model: published.model,
    query: published.query,
    answer: published.answer,
    retrieved: published.retrieved,
    citedPassageTexts: citedPaths.flatMap((p) => texts.get(p) ?? []),
    latencyMs: published.latencyMs,
  };
}

/** Tag counts across a set of runs, for the before/after the operator actually reads. */
export function tagHistogram(runs: Array<{ tags: KbFailureTag[] }>): Map<KbFailureTag, number> {
  const counts = new Map<KbFailureTag, number>();
  for (const run of runs) {
    for (const tag of run.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

function formatHistogram(before: Map<KbFailureTag, number>, after: Map<KbFailureTag, number>) {
  const tags = [...new Set([...before.keys(), ...after.keys()])].sort();
  return tags.map((tag) => `  ${tag.padEnd(22)} ${before.get(tag) ?? 0} → ${after.get(tag) ?? 0}`);
}

async function main(): Promise<void> {
  const apiKey = requireOllamaCloudApiKey();
  const judgeModel = process.env.KB_EVAL_JUDGE_MODEL || DEFAULT_KB_JUDGE_MODEL;

  if (process.argv.includes("--fresh")) {
    for (const suffix of [".jsonl", ".trajectories.jsonl"]) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are module constants
      await rm(path.join(RESULTS_DIR, `${REGRADE_LABEL}${suffix}`), { force: true });
    }
  }

  const published = await readAllTrajectories();
  if (published.length === 0)
    throw new Error("No published trajectories found under eval/kb/data.");

  const goldById = new Map(GOLD_QA.map((gold) => [gold.id, gold]));
  const texts = chunkTextsByPath();

  // Resume COUNTS per (model, gold) pair rather than marking the pair done. The
  // published dataset is one run per pair, so a Set would behave identically
  // today — and would silently drop every repeat the moment a sweep publishes
  // n > 1, re-grading 24 of 48 runs while reporting a complete pass.
  const done = new Map<string, number>();
  for (const run of await readExistingRuns(REGRADE_LABEL)) {
    const key = runKey(run.model, run.scenario ?? "");
    done.set(key, (done.get(key) ?? 0) + 1);
  }
  const doneTotal = [...done.values()].reduce((a, b) => a + b, 0);
  const seen = new Map<string, number>();
  const chat = createOllamaCloudChatFn({ apiKey, model: judgeModel });
  const deps = {
    nli: new LlmNliClient(chat),
    relevance: new LlmRelevanceJudge(chat),
    abstention: new LlmAbstentionJudge(chat),
    // Same groups the sweep grades against, from the same source: a re-grade
    // that scored a different dedup rule than the sweep would publish two
    // measurements under one column heading.
    nearDuplicateGroups: nearDuplicatePathGroups(),
  };

  console.log(
    `[kb-regrade] ${published.length} published runs, ${doneTotal} already re-graded, judge=${judgeModel}`
  );

  for (const [i, entry] of published.entries()) {
    const key = runKey(entry.model, entry.goldId);
    const gold = goldById.get(entry.goldId);
    // Loud rather than skipped: a gold id the corpus no longer defines means
    // the dataset and the gold set have diverged, and re-grading the rest would
    // publish a partial sweep that reads as a complete one.
    if (!gold) throw new Error(`${key}: no gold question with id "${entry.goldId}".`);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    if (occurrence <= (done.get(key) ?? 0)) continue;

    const trajectory = rebuildTrajectory(entry, texts);
    const result = await withTransportRetry(() => gradeKbRun(trajectory, gold, deps), {
      what: `re-grade ${key}`,
    });
    const row: KbRunResultRow = { ...result, scenario: entry.goldId, axis: gold.axis };
    await appendRunResult(REGRADE_LABEL, row);
    await appendTrajectory(REGRADE_LABEL, entry.goldId, trajectory, result.passed, result.tags);
    console.log(
      `[kb-regrade] ${String(i + 1).padStart(3)}/${published.length} ${key} ` +
        `${result.passed ? "pass" : `fail [${result.tags.join(", ")}]`}`
    );
  }

  const after = await readExistingRuns(REGRADE_LABEL);
  console.log(`\n[kb-regrade] tag histogram (published → re-graded), ${after.length} runs:`);
  console.log(formatHistogram(tagHistogram(published), tagHistogram(after)).join("\n"));
  console.log(
    `\n[kb-regrade] passed: ${published.filter((p) => p.passed).length} → ` +
      `${after.filter((r) => r.passed).length}`
  );
  console.log(`[kb-regrade] wrote results/${REGRADE_LABEL}.{jsonl,trajectories.jsonl}`);
}

// Same guard as `export-kb-scorecard.ts`: only run when invoked directly, so a
// test importing the pure helpers above does not fire the judge loop.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
