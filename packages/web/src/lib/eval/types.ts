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

export interface RunTrajectory {
  model: string;
  toolCalls: ToolCall[];
  /** Final assistant text shown to the user. */
  finalMessage: string;
  /** account.move records read back from the Odoo mock AFTER the run. */
  odooMoves: OdooMoveRecord[];
  latencyMs: number;
  tokens?: { prompt: number; completion: number };
}

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
  | "vendor-bill-with-amount";

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
  tokens?: { prompt: number; completion: number };
}
