/**
 * Pure logic for the cross-lingual answer sweep (#1296): which models run,
 * what is still pending, and the summary the PR quotes. Kept out of the spec
 * so vitest can check it without a stack or a key.
 */

import { TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS } from "../../../src/lib/ollama-cloud-models";
import { getModelCatalogForProvider } from "../../../src/lib/openclaw-builtin-models";
import type { AnswerLanguage } from "../../../src/lib/eval/kb/answer-language";

export const LANGUAGE_SWEEP_LABEL = "kb-answer-language";

/** Haiku 5.5 failed in staging; Sonnet 5 did not. The sweep compares the two. */
export const DEFAULT_LANGUAGE_CANDIDATES = [
  "anthropic/claude-haiku-5-5",
  "anthropic/claude-sonnet-5",
];

export interface LanguageRunRow {
  /** Which build the run measured, e.g. `before` / `after` the fix. */
  condition: string;
  model: string;
  questionId: string;
  lang: AnswerLanguage;
  passed: boolean;
  found: AnswerLanguage[];
  /**
   * Whether the knowledge_search plugin the stack ran carried the language
   * reminder (#1296), read from the container rather than taken from the
   * condition label, so a mislabelled run shows up in its own rows.
   */
  reminderInToolResult: boolean;
  /** Whether the answer contains the expected fact. Not part of `passed`. */
  mentioned: boolean;
  answer: string;
  latencyMs: number;
  at: string;
  /** Set when the run failed for a harness or transport reason, not a model one. */
  infraError?: string;
}

function servedIds(): Set<string> {
  return new Set([
    ...getModelCatalogForProvider("anthropic").map((m) => `anthropic/${m.id}`),
    ...TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS.map((id) => `ollama-cloud/${id}`),
  ]);
}

/**
 * The models to sweep: the default pair, or `EVAL_CANDIDATE_MODELS`. Unlike
 * the groundedness sweep this one accepts Anthropic models, because the
 * failure it measures was found on one. An id outside the curated catalogs
 * is refused here, before the stack is asked for anything.
 */
export function languageCandidatesFromEnv(env: Record<string, string | undefined>): string[] {
  const raw = env.EVAL_CANDIDATE_MODELS;
  const candidates = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_LANGUAGE_CANDIDATES;
  if (candidates.length === 0) {
    throw new Error("EVAL_CANDIDATE_MODELS resolves to an empty candidate set.");
  }
  const served = servedIds();
  const unknown = candidates.filter((id) => !served.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Not in the curated model catalog: ${unknown.join(", ")}. Write ids as ` +
        `"anthropic/<id>" or "ollama-cloud/<id>", as the agent model field takes them.`
    );
  }
  return candidates;
}

/** The condition label every row of this run is stamped with. */
export function languageConditionFromEnv(env: Record<string, string | undefined>): string {
  const condition = env.KB_LANG_EVAL_CONDITION?.trim();
  if (!condition) {
    throw new Error(
      "Set KB_LANG_EVAL_CONDITION (e.g. `before` or `after`). Rows of every condition " +
        "share one results file, and an unlabelled run could not be told apart."
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(condition)) {
    throw new Error(`KB_LANG_EVAL_CONDITION must be a lowercase slug, got "${condition}".`);
  }
  return condition;
}

/** Every (model, question) run still missing for `condition`, one entry per run. */
export function pendingLanguageRuns(
  existing: readonly LanguageRunRow[],
  condition: string,
  models: readonly string[],
  questionIds: readonly string[],
  n: number
): Array<{ model: string; questionId: string }> {
  const pending: Array<{ model: string; questionId: string }> = [];
  for (const model of models) {
    for (const questionId of questionIds) {
      const done = existing.filter(
        (r) =>
          r.condition === condition &&
          r.model === model &&
          r.questionId === questionId &&
          !r.infraError
      ).length;
      for (let i = done; i < n; i++) pending.push({ model, questionId });
    }
  }
  return pending;
}

export interface LanguageSummaryCell {
  condition: string;
  model: string;
  lang: AnswerLanguage;
  passed: number;
  n: number;
  mentioned: number;
}

/** Passes per condition, model and question language. Infra errors are not runs. */
export function summarizeLanguageRuns(rows: readonly LanguageRunRow[]): LanguageSummaryCell[] {
  const cells = new Map<string, LanguageSummaryCell>();
  for (const r of rows) {
    if (r.infraError) continue;
    const key = `${r.condition}\u0000${r.model}\u0000${r.lang}`;
    const cell = cells.get(key) ?? {
      condition: r.condition,
      model: r.model,
      lang: r.lang,
      passed: 0,
      n: 0,
      mentioned: 0,
    };
    cell.n++;
    if (r.passed) cell.passed++;
    if (r.mentioned) cell.mentioned++;
    cells.set(key, cell);
  }
  return [...cells.values()].sort(
    (a, b) =>
      a.condition.localeCompare(b.condition) ||
      a.model.localeCompare(b.model) ||
      a.lang.localeCompare(b.lang)
  );
}
