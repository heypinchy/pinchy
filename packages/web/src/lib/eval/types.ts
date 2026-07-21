/**
 * Shared types for Eval-v1, a model-reliability evaluation harness (pinchy#669).
 *
 * These types describe a NORMALIZED agent-run trajectory, decoupled from the
 * audit-row schema, so graders in `graders.ts` are pure functions over plain
 * data and trivially unit-testable with hand-built fixtures. The orchestrator
 * that produces real `RunTrajectory` values from live audit rows is a
 * separate, later task.
 */

/**
 * Failure taxonomy. These string values are a shared contract across the
 * eval harness (graders, scorecards, and any future reporting UI) — do not
 * rename them without checking every consumer.
 */
export type FailureTag =
  | "id-malformed"
  | "false-success"
  | "thinking-leaked"
  | "tool-result-not-recognized"
  | "refused-tool"
  | "wrong-field-extraction"
  | "task-incomplete"
  // Soft signal, NOT pass-gating: the invoice amount is a DERIVED field in
  // Odoo (amount_total computed from line_ids). A v1 minimal scenario without
  // chart-of-accounts scaffolding can't fairly require it, so a missing/wrong
  // amount is recorded here but does not fail the run. See graders.ts
  // gradeTaskCompletion and packages/web/eval/model-selection-methodology.md.
  | "amount-not-captured"
  // The LLM request itself died (transport/connection error between the
  // gateway and the provider): the harness surface ("couldn't respond" /
  // "LLM request failed") IS the final message, so the model produced no
  // answer at all. Unlike run-timeout (a model hang, which is model behavior
  // and graded as a failure), this is an invalid trial: it must never be
  // credited as honesty in failure-injection scenarios ("no claim" is not a
  // verification act) and is excluded + re-run at the dataset level. The first
  // silent-failure sweep had 17 such runs silently graded as passes.
  | "run-infra-error"
  // The run never went idle within the dispatch timeout — the model hung or
  // looped without producing a final answer. Recorded by the sweep loop
  // (eval-models) so a single hung run becomes a graded data point (a hang IS
  // a reliability failure) instead of throwing away the whole scenario's
  // scorecard. This is itself a discriminating signal (some models spiral into
  // an unbounded loop when a tool result contradicts their plan).
  | "run-timeout"
  // ── crm-lead domain (Eval-v2, pinchy#803) ──
  // The post-run read-back holds no crm.lead row at all — the crm-lead
  // counterpart of task-incomplete. See graders.ts gradeLeadCompletion.
  | "lead-not-created"
  // A crm.lead row exists but a HARD identity field (name/title containing
  // the expected substring, email_from, partner_id) doesn't match — the
  // crm-lead counterpart of wrong-field-extraction.
  | "lead-fields-mismatch"
  // Soft signal, NOT pass-gating — the crm-lead counterpart of
  // amount-not-captured: a missing/wrong `expected_revenue` is recorded here
  // but never fails the run (see ExpectedLead.expectedRevenue).
  | "lead-revenue-not-captured"
  // The model ATTEMPTED to create a SECOND vendor bill for an invoice already
  // recorded in Odoo (the duplicate-guard scenario seeds the bill first) — a
  // blind double-record (double-pay) attempt, whether or not the stack's
  // duplicate guard happened to block it. The correct behavior is to verify
  // (odoo_read/odoo_count) it is already on file and NOT call odoo_create at
  // all. See graders.ts gradeDuplicateAvoidance.
  | "duplicate-created";

export interface ToolCall {
  /** e.g. "email_list", "email_read", "email_get_attachment", "odoo_create" */
  name: string;
  /** Inputs the model sent (from audit detail.params). */
  params: Record<string, unknown>;
  /** As logged in the audit trail. */
  outcome: "success" | "failure";
  /** Error message if the tool actually failed (from details.error). */
  error?: string;
  /** Ids/handles this call's RESULT handed back to the model (msg_/att_ handles, odoo refs). */
  issuedIds?: string[];
}

export interface OdooMoveRecord {
  id: number;
  /** "in_invoice" for a vendor bill. */
  move_type?: string;
  partner_id?: [number, string] | number | false;
  /** Invoice number. */
  ref?: string;
  /** "YYYY-MM-DD" */
  invoice_date?: string;
  amount_total?: number;
  [k: string]: unknown;
}

/**
 * Token + cost accounting for one run, joined from `usage_records` by the run's
 * unique OpenClaw session key (pinchy#798). `prompt`/`completion` are summed
 * over every turn of the run's tool loop (so the total cost of completing the
 * task, not one call). `prompt` counts all three prompt classes the model read
 * — `input + cacheRead + cacheWrite` — which differ only in billing, so caching
 * hosters aren't under-reported. Two optional fields carry the extra signals
 * #798 asked for:
 * - `contextTokens`: the PEAK context-window pressure across the run's turns
 *   (max, not sum) — the read-side of the "Piper" false-success incident, a
 *   PLATFORM risk factor rather than a model score.
 * - `costUsd`: summed `estimated_cost_usd`. Undefined for Ollama Cloud, which is
 *   subscription-billed (no per-token price) — the published $ figure is a
 *   labeled multi-hoster range computed offline from the token counts, not this
 *   column. Present only when a provider actually prices per token.
 *
 * A single named type (not three inline duplicates) so RunResult, RunTrajectory,
 * and the normalizer's input can never drift apart.
 */
export interface RunTokenUsage {
  prompt: number;
  completion: number;
  contextTokens?: number;
  costUsd?: number;
}

export interface RunTrajectory {
  model: string;
  toolCalls: ToolCall[];
  /** Final assistant text shown to the user. */
  finalMessage: string;
  /**
   * Records of the scenario's FIRST read-back model (default account.move,
   * see `readbackModelsFor`) read from the Odoo mock AFTER the run. The name
   * predates parametrized read-back (#803) and is consumed by the graders —
   * do NOT rename; multi-model scenarios get `odooRecordsByModel` instead.
   */
  odooMoves: OdooMoveRecord[];
  /**
   * Post-run read-back keyed by Odoo model. Set ONLY by scenarios that declare
   * more than one `readbackModels` entry (#803) — a single-model scenario
   * would just duplicate `odooMoves` here, doubling the read-back payload of
   * every persisted trajectory line (`results/<label>.trajectories.jsonl`) for
   * no information. When present it includes the first model too, so
   * `odooRecordsByModel[models[0]]` mirrors `odooMoves`.
   */
  odooRecordsByModel?: Record<string, OdooMoveRecord[]>;
  latencyMs: number;
  tokens?: RunTokenUsage;
}

/**
 * The record domain a scenario grades against. The completion/non-persistence/
 * failure phrase sets are calibrated per domain (see `PHRASE_SETS` in
 * graders.ts); phrases for one domain must never trigger graders for another.
 * A domain is only gradable once its phrase sets exist — `phraseSetFor` throws
 * otherwise rather than passing every run.
 */
export type EvalDomain = "invoice" | "crm-lead";

export interface ExpectedInvoice {
  /** Expected partner (display name). */
  vendorName: string;
  /**
   * Expected partner record id. Odoo resolves a many2one display name to a
   * bare numeric id on create, so the `account.move` read-back carries
   * `partner_id: <id>` (a number), not a `[id, name]` tuple — the name is not
   * recoverable from the record alone. When set, the grader matches the read
   * numeric id against this seeded id; when omitted, a bare numeric id is
   * accepted as present-but-unverifiable.
   */
  vendorPartnerId?: number;
  /** Expected ref. */
  invoiceNumber: string;
  /** Expected YYYY-MM-DD. */
  invoiceDate: string;
  /** Expected amount_total (allow small float tolerance). */
  amountTotal: number;
}

/**
 * Expected `crm.lead` field values for the CRM-lead domain (Eval-v2, #803).
 * Camel-cased expectation-side names, mirroring `ExpectedInvoice`; the Odoo
 * read-back carries the snake_case model fields (`email_from`, `phone`,
 * `expected_revenue`, `partner_id`).
 */
export interface ExpectedLead {
  /** The lead's name/title must contain this substring. */
  leadTitleContains: string;
  /** Expected `email_from` on the lead. */
  emailFrom: string;
  /**
   * Expected `partner_id` record id. As with `ExpectedInvoice.vendorPartnerId`,
   * Odoo resolves a many2one display name to a bare numeric id on create, so
   * the `crm.lead` read-back carries `partner_id: <id>` — match against the
   * seeded `res.partner` id.
   */
  partnerId: number;
  /**
   * Soft signal, taxonomy-only — NEVER a pass gate (the crm-lead counterpart
   * of the invoice domain's `amount-not-captured` policy): recorded when
   * `expected_revenue` is missing/wrong, but a run without it still passes.
   */
  expectedRevenue?: number;
  /**
   * Currently UNGRADED — carried in the scenario spec only, reserved for a
   * future soft-signal calibration (it would mirror `expectedRevenue`'s
   * never-gating policy, e.g. a lead-phone-not-captured tag).
   */
  phone?: string;
}

export interface GraderResult {
  passed: boolean;
  tags: FailureTag[];
  notes: string[];
}

/**
 * What a successful run of a scenario is expected to produce. Selects which
 * grading mode `gradeRunForScenario` (graders.ts) applies:
 * - "vendor-bill-created": the default Hetzner-invoice scenario — a matching
 *   `account.move` must exist (see `gradeRun`/`gradeTaskCompletion`).
 * - "honest-failure": the failure-injection scenario (pinchy#669) — the
 *   `odoo_create` call is injected to fail, so NO move is expected. Grading
 *   instead measures whether the model HONESTLY reported the failure rather
 *   than falsely narrating success (see `gradeHonestFailureRun`).
 */
export type ExpectedOutcome =
  | "vendor-bill-created"
  | "honest-failure"
  | "duplicate-detected"
  // The line-items scenario: the bill must be entered WITH line items so the
  // mock-computed amount_total matches — amount is graded HARD (gates), unlike
  // the default where it's a soft derived-field signal. See gradeTaskCompletion.
  | "vendor-bill-with-amount"
  // The crm-lead happy-path scenario (Eval-v2, #803): a matching `crm.lead`
  // must exist. Graded by gradeLeadCompletion via gradeLeadRun (graders.ts).
  | "lead-created";

/**
 * The grading modes the INVOICE scenario family can declare — everything but
 * the crm-lead "lead-created" mode. Keeps `GradableScenario` (graders.ts) a
 * discriminated union: an `ExpectedInvoice` can never ride under
 * "lead-created", so the dispatch narrows without casts.
 */
export type InvoiceExpectedOutcome = Exclude<ExpectedOutcome, "lead-created">;

/**
 * One graded run. Generic over its failure-tag union so `scorecard.ts`'s
 * aggregation (grouping, pass-rate, Wilson interval, pass^k, tag histogram)
 * is reusable outside the invoice eval without a cast — the KB eval harness
 * (`kb/answer-graders.ts`'s `KbRunResult`) is `RunResult<KbFailureTag>`.
 * `Tag` defaults to the invoice `FailureTag` union, so every existing
 * call site that writes plain `RunResult` (no type argument) is unaffected.
 */
export interface RunResult<Tag extends string = FailureTag> {
  model: string;
  /**
   * Which scenario produced this run, e.g. "hetzner-invoice" or
   * "hetzner-invoice-rejected". Optional for backward compatibility with
   * existing single-scenario call sites; the models sweep (eval-models.spec.ts)
   * sets it so a scorecard can group/report per (model, scenario).
   */
  scenario?: string;
  passed: boolean;
  tags: Tag[];
  notes: string[];
  latencyMs: number;
  tokens?: RunTokenUsage;
}
