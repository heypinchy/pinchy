// packages/web/eval/kb/run-kb-eval.ts
//
// KB Eval Harness Task 3.4: shared helpers for the stochastic groundedness
// SWEEP (real Ollama Cloud, resumable) — the KB-scoped analogue of
// `../run-eval.ts`. This module has no Playwright `test`/`expect` so it stays
// importable from `kb-eval-models.spec.ts` (the sweep LOOP) without embedding
// assertions, mirroring `../run-eval.ts`'s own split from
// `../eval-models.spec.ts`.
//
// Reused VERBATIM from `../run-eval.ts` (generic HTTP/env helpers, nothing
// invoice-specific): `requireOllamaCloudApiKey`, `candidateModelsFromEnv`,
// `runsPerModelFromEnv`, `pinAgentModel`, `pinchyGet`/`pinchyPost`/
// `pinchyPatch`. JSONL append/resume + scorecard I/O are NOT reused — they
// write to THIS module's own `results/` directory (`eval/kb/results/`, not
// `eval/results/`) and are generic over `KbFailureTag` via
// `buildScorecard<KbFailureTag>` (`../../src/lib/eval/scorecard.ts`).
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildScorecard } from "../../src/lib/eval/scorecard";
import type { ScorecardEntry } from "../../src/lib/eval/scorecard";
import type { KbRunResult, KbRunTrajectory } from "../../src/lib/eval/kb/answer-graders";
import type { RetrievedSource } from "../../src/lib/eval/kb/attribution-graders";

export {
  requireOllamaCloudApiKey,
  candidateModelsFromEnv,
  runsPerModelFromEnv,
  pinAgentModel,
  pinchyGet,
  pinchyPost,
  pinchyPatch,
  pinchyPut,
} from "../run-eval";

export const RESULTS_DIR = path.join(__dirname, "results");

const LABEL_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Defense in depth: `label` is a hardcoded literal at every call site today, but reject path separators/traversal. */
function assertValidLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`Invalid run-log label (must be a plain filename segment): ${label}`);
  }
}

// ── JSONL append/resume ──────────────────────────────────────────────────

/**
 * Appends one graded KB run to `results/<label>.jsonl` immediately after it
 * completes, so a long unattended sweep never loses finished runs if it
 * crashes mid-sweep. Mirrors `../run-eval.ts`'s `appendRunResult`.
 */
export async function appendRunResult(label: string, result: KbRunResult): Promise<void> {
  assertValidLabel(label);
  await mkdir(RESULTS_DIR, { recursive: true });
  const filePath = path.join(RESULTS_DIR, `${label}.jsonl`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- label validated above (alnum/./_/- only)
  await appendFile(filePath, `${JSON.stringify(result)}\n`, "utf8");
}

/**
 * Reads the runs already persisted to `results/<label>.jsonl` (empty if the
 * file doesn't exist), so the sweep can RESUME: a (model, goldId) pair that
 * already has `n` runs on disk is skipped (see `pendingPairs` below) instead
 * of restarting the whole sweep from zero after a timeout/crash.
 */
export async function readExistingRuns(label: string): Promise<KbRunResult[]> {
  assertValidLabel(label);
  const filePath = path.join(RESULTS_DIR, `${label}.jsonl`);
  let text: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- label validated above (alnum/._- only)
    text = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as KbRunResult);
}

/**
 * The runs that COUNT toward a scorecard: everything except `run-infra-error`
 * invalid trials (a harness/transport failure where the model never produced a
 * gradeable answer — neither a pass nor a model failure). PURE — no I/O — so
 * the exclusion is unit-testable directly. Mirrors `export-kb-scorecard.ts`'s
 * `aggregateKbResults` filter EXACTLY: without it a harness flake would depress
 * a model's passRate and zero its passCaretK, conflating harness reliability
 * with model quality (the very confounding `KbFailureTag`'s `run-infra-error`
 * exists to prevent — see `../../src/lib/eval/kb/types.ts`).
 */
export function scorecardRuns(runs: KbRunResult[]): KbRunResult[] {
  return runs.filter((r) => !r.tags.includes("run-infra-error"));
}

export async function writeScorecard(
  label: string,
  runs: KbRunResult[]
): Promise<ScorecardEntry[]> {
  assertValidLabel(label);
  // Score over VALID trials only (same exclusion the published exporter
  // applies), but persist the FULL `runs` array for forensics so an excluded
  // infra-error is still auditable from the on-disk record.
  const scorecard = buildScorecard(scorecardRuns(runs));
  await mkdir(RESULTS_DIR, { recursive: true });
  const filePath = path.join(RESULTS_DIR, `${label}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- label validated above (alnum/./_/- only, no path separators)
  await writeFile(
    filePath,
    JSON.stringify({ generatedAt: new Date().toISOString(), runs, scorecard }, null, 2),
    "utf8"
  );
  return scorecard;
}

/** One persisted trajectory record: the full normalized KB run plus the grade it received. Mirrors `../run-eval.ts`'s `PersistedTrajectory`. */
export interface PersistedKbTrajectory extends KbRunTrajectory {
  goldId: string;
  passed: boolean;
  tags: KbRunResult["tags"];
}

/**
 * Appends one full trajectory to `results/<label>.trajectories.jsonl` — the
 * evidence corpus (raw answer text, retrieved set, cited passages) behind a
 * graded `KbRunResult`, so a grader change can be re-scored offline
 * (`gradeKbRun`) against real runs instead of burning a re-sweep. Best-effort:
 * a dump failure must never fail the run itself (mirrors `../run-eval.ts`).
 */
export async function appendTrajectory(
  label: string,
  goldId: string,
  trajectory: KbRunTrajectory,
  passed: boolean,
  tags: KbRunResult["tags"]
): Promise<void> {
  assertValidLabel(label);
  await mkdir(RESULTS_DIR, { recursive: true });
  const filePath = path.join(RESULTS_DIR, `${label}.trajectories.jsonl`);
  const record: PersistedKbTrajectory = { ...trajectory, goldId, passed, tags };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- label validated above (alnum/./_/- only)
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

// ── Resume filter: (model, goldId) pairs ─────────────────────────────────

/**
 * How many runs already exist for one (model, goldId) pair. A KB run's
 * `RunResult.scenario` (optional, generic across the invoice + KB harnesses —
 * see `../../src/lib/eval/types.ts`) carries the gold Q/A's `id` here, the
 * same way the invoice sweep stamps its scenario label onto `scenario`.
 */
export function countRunsForPair(existing: KbRunResult[], model: string, goldId: string): number {
  return existing.filter((r) => r.model === model && r.scenario === goldId).length;
}

export interface PendingPair {
  model: string;
  goldId: string;
  /** Runs already on disk for this pair — the sweep loop starts its `i` counter here, not at 0. */
  alreadyDone: number;
}

/**
 * The (model, goldId) pairs still needing at least one more run to reach `n`,
 * given what's already persisted to `results/<label>.jsonl` (`existing`).
 * PURE — no I/O — so the resume behavior is unit-testable directly against
 * hand-built `existing` fixtures, without a real sweep or filesystem.
 *
 * Order: models outer, goldIds inner (same nesting the invoice sweep uses:
 * per-model setup — pin the model, wait for it to be dispatchable — is more
 * expensive than per-query dispatch, so grouping by model lets the sweep loop
 * pin once and run every gold query before switching models).
 */
export function pendingPairs(
  existing: KbRunResult[],
  models: string[],
  goldIds: string[],
  n: number
): PendingPair[] {
  const pending: PendingPair[] = [];
  for (const model of models) {
    for (const goldId of goldIds) {
      const alreadyDone = countRunsForPair(existing, model, goldId);
      if (alreadyDone < n) pending.push({ model, goldId, alreadyDone });
    }
  }
  return pending;
}

// ── `--corpus` switch ─────────────────────────────────────────────────────

export type KbEvalCorpus = "synthetic" | "noack";

/**
 * Reads a `--corpus=<value>` CLI flag from `argv` (checked first, so an
 * explicit flag always wins) or the `KB_EVAL_CORPUS` env var, defaulting to
 * `"synthetic"`. Accepts `env`/`argv` params (defaulting to the real
 * `process.env`/`process.argv`) purely so this stays unit-testable without
 * mutating global process state.
 *
 * GUARD (KB Eval Harness plan, Task 3.4 + design's corpus decision): the
 * Noack corpus is real, non-public customer/company documents and must
 * NEVER be selectable in CI or any committed/automated path — only an
 * explicit, local, human-supplied opt-in.
 *   - `CI` set (any truthy value, matching every other CI-detection in this
 *     repo) + `--corpus=noack` is a HARD ERROR, unconditionally — this is
 *     the one guard that must never be bypassable by an env var, since CI is
 *     exactly the environment this exists to protect.
 *   - Outside CI, `--corpus=noack` additionally requires `KB_EVAL_CORPUS_DIR`
 *     to be set (see `noackCorpusDir`) — refusing to guess a path to a
 *     non-public corpus keeps the opt-in explicit rather than "whatever
 *     happens to be on disk."
 * An unrecognized `--corpus` value is also a hard error (fail loud, not a
 * silent fall-through to synthetic).
 */
export function corpusFromEnv(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv
): KbEvalCorpus {
  const argFlag = argv
    .map((arg) => /^--corpus=(.*)$/.exec(arg)?.[1])
    .find((v): v is string => v !== undefined);
  const requested = (argFlag ?? env.KB_EVAL_CORPUS ?? "synthetic").trim();

  if (requested !== "synthetic" && requested !== "noack") {
    throw new Error(
      `Unknown --corpus value "${requested}" — expected "synthetic" (default) or "noack".`
    );
  }

  if (requested === "noack") {
    if (env.CI) {
      throw new Error(
        "--corpus=noack is not allowed when CI is set. The Noack corpus is real, non-public " +
          "customer documents and is local-only by design — it must never run in CI or any " +
          "committed/automated path. Use --corpus=synthetic (default) in CI."
      );
    }
    noackCorpusDir(env); // throws if the explicit local opt-in is missing.
  }

  return requested;
}

// ── Retrieved-set from the `tool.knowledge_search` audit row ────────────────

/** The subset of a `tool.knowledge_search` audit row's `detail` this module reads — see `pinchy-knowledge/index.ts`'s `returnedDocumentIds`. */
export interface KnowledgeSearchAuditDetail {
  toolName?: string;
  success?: boolean;
  returnedDocumentIds?: Array<{ id: string; name: string }>;
}

/** The minimal shape of one `GET /api/audit` entry this module reads. */
export interface KnowledgeSearchAuditEntry {
  detail: unknown;
}

/**
 * Builds the run's `retrieved: RetrievedSource[]` (for `KbRunTrajectory`,
 * `gradeKbRun`) from every `tool.knowledge_search` audit row's
 * `detail.returnedDocumentIds` (KB Eval Harness plan, Task 3.4: "The
 * retrieved-set for grading comes from the `tool.knowledge_search` audit
 * row's `returnedDocumentIds`"). PURE — no I/O — so this is directly
 * unit-testable against hand-built audit-entry fixtures.
 *
 * `returnedDocumentIds` (`packages/plugins/pinchy-knowledge/index.ts`) is
 * DEDUPED BY sourcePath and carries no per-chunk `page` — see that file's
 * `returnedDocumentIds()`. This is a deliberate, sufficient degradation: none
 * of the current attribution graders (`attribution-graders.ts`) use
 * `RetrievedSource.n` or `.page` — `gradePathCitation`, the only grader that
 * reads `retrieved` at all, only checks sourcePath SET membership. `n` here
 * is assigned by insertion order across every audit row for the run
 * (typically one row, one `knowledge_search` call) purely to satisfy the
 * type; `page` is always `null` (unavailable from the audit trail).
 *
 * Deduplicates across MULTIPLE `knowledge_search` calls in one run (a model
 * that searches more than once) by sourcePath, in first-seen order — a
 * document returned by an earlier call and again by a later call is one
 * retrieved source, not two.
 */
export function retrievedSourcesFromAuditEntries(
  entries: KnowledgeSearchAuditEntry[]
): RetrievedSource[] {
  const seen = new Set<string>();
  const sources: RetrievedSource[] = [];

  for (const entry of entries) {
    const detail = entry.detail as KnowledgeSearchAuditDetail | null | undefined;
    const docs = detail?.returnedDocumentIds;
    if (!Array.isArray(docs)) continue;

    for (const doc of docs) {
      if (typeof doc?.id !== "string" || doc.id.length === 0) continue;
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      sources.push({ n: sources.length + 1, sourcePath: doc.id, page: null });
    }
  }

  return sources;
}

/**
 * Resolves the local directory the (local-only) Noack corpus lives in.
 * Requires `KB_EVAL_CORPUS_DIR` to be explicitly set — see `corpusFromEnv`'s
 * doc comment for why this must be an explicit opt-in, never a guessed
 * default path.
 */
export function noackCorpusDir(env: Record<string, string | undefined> = process.env): string {
  const dir = env.KB_EVAL_CORPUS_DIR?.trim();
  if (!dir) {
    throw new Error(
      "--corpus=noack requires KB_EVAL_CORPUS_DIR to be set to the local Noack corpus directory " +
        "— refusing to guess a path to a non-public corpus. This is a local-only, explicit opt-in."
    );
  }
  return dir;
}
