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
  | "task-incomplete";

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
  /** Expected partner. */
  vendorName: string;
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

export interface RunResult {
  model: string;
  passed: boolean;
  tags: FailureTag[];
  notes: string[];
  latencyMs: number;
  tokens?: { prompt: number; completion: number };
}
