/**
 * Normalizer for Eval-v1 (pinchy#669): turns raw audit rows + run artifacts
 * into the `RunTrajectory` shape the pure graders in `graders.ts` consume.
 *
 * Pure, synchronous, no I/O — the orchestrator (Playwright-driven) is
 * responsible for gathering the raw inputs (audit rows, the scraped final
 * assistant message, the Odoo mock read-back) and calling `buildTrajectory`.
 */
import {
  ATT_PREFIX,
  handleFor,
  MSG_PREFIX,
} from "../../../../plugins/pinchy-email/id-handle-store";
import type { OdooMoveRecord, RunTrajectory, ToolCall } from "./types";

const TOOL_EVENT_PREFIX = "tool.";

export interface NormalizeAuditEntry {
  eventType: string;
  outcome: "success" | "failure";
  detail: { toolName?: string; params?: unknown; error?: string } | null;
  timestamp: string | number;
}

export interface NormalizeInput {
  model: string;
  auditEntries: NormalizeAuditEntry[];
  finalMessage: string;
  /** Raw account.move records from the Odoo mock. */
  odooMoves: OdooMoveRecord[];
  /** The real Graph message id that was seeded. */
  seededMessageId: string;
  /** The real Graph attachment id that was seeded. */
  seededAttachmentId: string;
  latencyMs: number;
  tokens?: { prompt: number; completion: number };
}

function toToolCall(entry: NormalizeAuditEntry): ToolCall {
  const name = entry.detail?.toolName ?? entry.eventType.slice(TOOL_EVENT_PREFIX.length);
  const params = isRecord(entry.detail?.params) ? entry.detail.params : {};
  return {
    name,
    params,
    outcome: entry.outcome,
    error: entry.detail?.error,
    issuedIds: undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defensive pass-through: keep only what OdooMoveRecord expects, tolerating extra/missing fields. */
function coerceOdooMove(move: OdooMoveRecord): OdooMoveRecord {
  return { ...move };
}

/**
 * Attaches `handle` to the `issuedIds` of the EARLIEST toolCall (in the
 * already-time-sorted array) whose name matches one of `names`. No-op if no
 * such call exists. Mutates the call in place (the array itself was freshly
 * built by this module, so this is safe and avoids an extra full clone).
 */
function attachIssuedId(toolCalls: ToolCall[], names: string[], handle: string): void {
  const target = toolCalls.find((call) => names.includes(call.name));
  if (!target) return;
  target.issuedIds = [...(target.issuedIds ?? []), handle];
}

/**
 * Builds a normalized `RunTrajectory` from raw audit rows + run artifacts.
 *
 * - Tool calls are derived from audit entries whose `eventType` starts with
 *   `"tool."`, sorted by `timestamp` ascending.
 * - `name` prefers `detail.toolName`, falling back to the `tool.` suffix of
 *   `eventType` when detail is sparse/null.
 * - Handles the model was issued are computed deterministically via
 *   `handleFor` (the same function `pinchy-email`'s plugin uses to mint
 *   them), so `gradeIdFidelity` can recognize legitimate handle usage: the
 *   message handle is attached to the earliest `email_list`/`email_search`
 *   call, and the attachment handle to the earliest `email_read` call.
 */
export function buildTrajectory(input: NormalizeInput): RunTrajectory {
  const toolCalls = input.auditEntries
    .filter((entry) => entry.eventType.startsWith(TOOL_EVENT_PREFIX))
    .slice()
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .map(toToolCall);

  const msgHandle = handleFor(input.seededMessageId, MSG_PREFIX);
  const attHandle = handleFor(input.seededAttachmentId, ATT_PREFIX);

  attachIssuedId(toolCalls, ["email_list", "email_search"], msgHandle);
  attachIssuedId(toolCalls, ["email_read"], attHandle);

  return {
    model: input.model,
    toolCalls,
    finalMessage: input.finalMessage,
    odooMoves: input.odooMoves.map(coerceOdooMove),
    latencyMs: input.latencyMs,
    tokens: input.tokens,
  };
}
