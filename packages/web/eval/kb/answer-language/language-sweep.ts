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

/**
 * The AGENTS.md section a staging test used as a per-agent workaround for
 * #1296, verbatim. `KB_LANG_EVAL_AGENTS_MD_SECTION=1` appends it, so the
 * sweep can compare it with the tool-result fix on the same questions.
 */
export const AGENTS_MD_LANGUAGE_SECTION = `## Language (mandatory)
Always write your entire answer in the language of the user's latest message, even when every source is in German. If the question is in Polish, answer in Polish; quote source passages in their original language.`;

/**
 * Role instructions in German, as a German-speaking organization writes them
 * for its own agent. `KB_LANG_EVAL_GERMAN_INSTRUCTIONS=1` appends this to
 * AGENTS.md, to measure how much German instructions pull the answer.
 */
export const GERMAN_INSTRUCTIONS_SECTION = `## Unternehmen
Du bist der Wissensassistent der Musterbau GmbH. Du beantwortest Fragen der Mitarbeiterinnen und Mitarbeiter zu Prüfberichten, Abnahmeprotokollen, Wartungsanweisungen und internen Richtlinien. Antworte sachlich und knapp und nenne immer das Dokument, aus dem die Information stammt.`;

/**
 * The German name and tagline of the staging agent that showed #1296. They
 * land in IDENTITY.md, inside the system prompt. `KB_LANG_EVAL_GERMAN_IDENTITY=1`
 * uses them instead of the sweep's English agent name.
 */
export const GERMAN_IDENTITY = {
  name: "Musterbau Wissen",
  tagline: "Antworten aus dem Musterbau-Archiv",
};

/**
 * A German question asked first, in the same chat, before the question under
 * test. #1296 first showed up in a chat that already had German turns.
 * `KB_LANG_EVAL_GERMAN_WARMUP=1` turns it on.
 */
export const GERMAN_WARMUP_QUESTION =
  "Wie hoch war der Druckverlust des WT-450 im Primärkreislauf?";

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
  /**
   * sha256 of the plugin's index.ts in the OpenClaw container. The boolean
   * above only tells before from after; this tells one "after" from another.
   * Optional because rows from the first sweeps predate it.
   */
  pluginSha?: string;
  /**
   * Whether the agent's AGENTS.md carried `AGENTS_MD_LANGUAGE_SECTION`: the
   * per-agent workaround tried on staging, measured next to the plugin fix.
   */
  agentsMdLanguageSection: boolean;
  /** Whether the agent carried `GERMAN_IDENTITY` as its name and tagline. */
  germanIdentity: boolean;
  /** Whether AGENTS.md carried `GERMAN_INSTRUCTIONS_SECTION`. */
  germanInstructions: boolean;
  /** Whether `GERMAN_WARMUP_QUESTION` was asked first in the same chat. */
  germanWarmup: boolean;
  /**
   * Whether another question in the same language was asked first, in the
   * same chat. Measures a follow-up turn, which the plugin's per-turn note
   * skips when the language hasn't changed. Optional: older rows predate it.
   */
  sameLanguageWarmup?: boolean;
  /**
   * The tools the agent called for this question, in order, from the audit
   * trail. Whether the answer came through knowledge_search or through a
   * direct file read decides which tool result the model read last.
   */
  toolCalls: string[];
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

/** The knobs a run was made with. Rows of one condition must agree on all of them. */
export type LanguageVariant = Pick<
  LanguageRunRow,
  | "reminderInToolResult"
  | "pluginSha"
  | "agentsMdLanguageSection"
  | "germanIdentity"
  | "germanInstructions"
  | "germanWarmup"
  | "sameLanguageWarmup"
>;

const VARIANT_KEYS: readonly (keyof LanguageVariant)[] = [
  "reminderInToolResult",
  "pluginSha",
  "agentsMdLanguageSection",
  "germanIdentity",
  "germanInstructions",
  "germanWarmup",
  "sameLanguageWarmup",
];

/**
 * Refuses to add rows to `condition` under different knobs than its existing
 * rows. Resume counts runs per condition, model and question, so a second run
 * under the same label with a knob flipped would find nothing pending, run
 * nothing, and print the first run's numbers as its own.
 */
export function assertConditionMatchesVariant(
  existing: readonly LanguageRunRow[],
  condition: string,
  variant: LanguageVariant
): void {
  const earlier = existing.find((r) => r.condition === condition);
  if (!earlier) return;
  // Rows from before a field existed: a missing plugin stamp is not compared,
  // and a missing sameLanguageWarmup means the knob was off.
  const value = (r: LanguageVariant, key: keyof LanguageVariant) =>
    key === "sameLanguageWarmup" ? (r.sameLanguageWarmup ?? false) : r[key];
  const differing = VARIANT_KEYS.filter(
    (key) =>
      !(key === "pluginSha" && earlier.pluginSha === undefined) &&
      value(earlier, key) !== value(variant, key)
  );
  if (differing.length > 0) {
    throw new Error(
      `Condition "${condition}" already has rows made with different settings ` +
        `(${differing.map((k) => `${k}: ${String(earlier[k])} -> ${String(variant[k])}`).join(", ")}). ` +
        "Pick a new KB_LANG_EVAL_CONDITION label for this variant."
    );
  }
}

/**
 * Whether the captured answer is the warmup turn's answer. The capture walks
 * back to the last turn with assistant text, so a question turn that produced
 * none comes back as the German warmup answer, which would be graded as the
 * very failure the sweep measures.
 */
export function isWarmupEcho(answer: string, warmupAnswer: string | null): boolean {
  return warmupAnswer !== null && answer.trim() === warmupAnswer.trim();
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

/** The question asked first for a same-language warmup: another one in `lang`. */
export function sameLanguageWarmupQuestion(
  questions: readonly { id: string; lang: string; query: string }[],
  question: { id: string; lang: string }
): string | null {
  return questions.find((q) => q.lang === question.lang && q.id !== question.id)?.query ?? null;
}
