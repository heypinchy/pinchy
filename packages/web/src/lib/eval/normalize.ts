/**
 * Normalizer for Eval-v1 (pinchy#669): turns raw audit rows + run artifacts
 * into the `RunTrajectory` shape the pure graders in `graders.ts` consume.
 *
 * Pure, synchronous, no I/O — the orchestrator (Playwright-driven) is
 * responsible for gathering the raw inputs (audit rows, the scraped final
 * assistant message, the Odoo mock read-back) and calling `buildTrajectory`.
 */
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
  /**
   * The handle the pinchy-email plugin issues for the seeded message,
   * pre-computed by the caller via `handleFor(seededMessageId, MSG_PREFIX)`.
   * Passed in (rather than computed here) so this module stays inside the
   * app build graph without importing plugin source — `packages/plugins/*`
   * `.ts` files are not present in the production `next build` stage, only
   * their manifests. The orchestrator (`packages/web/eval/run-eval.ts`, test
   * code with the full monorepo available) computes it.
   */
  issuedMessageHandle: string;
  /** The handle the plugin issues for the seeded attachment (see above). */
  issuedAttachmentHandle: string;
  /**
   * Handles for ADDITIONAL seeded inbox items (e.g. a distractor scenario's
   * second invoice). Without these, `gradeIdFidelity` would false-flag the
   * model for reading a legitimately-listed extra email as an unissued handle.
   */
  extraIssuedMessageHandles?: string[];
  extraIssuedAttachmentHandles?: string[];
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
function attachIssuedId(toolCalls: ToolCall[], names: string[], handles: string[]): void {
  if (handles.length === 0) return;
  const target = toolCalls.find((call) => names.includes(call.name));
  if (!target) return;
  target.issuedIds = [...(target.issuedIds ?? []), ...handles];
}

/**
 * Builds a normalized `RunTrajectory` from raw audit rows + run artifacts.
 *
 * - Tool calls are derived from audit entries whose `eventType` starts with
 *   `"tool."`, sorted by `timestamp` ascending.
 * - `name` prefers `detail.toolName`, falling back to the `tool.` suffix of
 *   `eventType` when detail is sparse/null.
 * - The caller-supplied issued handles let `gradeIdFidelity` recognize
 *   legitimate handle usage: the message handle is attached to the earliest
 *   `email_list`/`email_search` call, and the attachment handle to the
 *   earliest `email_read` call.
 */
export function buildTrajectory(input: NormalizeInput): RunTrajectory {
  const toolCalls = input.auditEntries
    .filter((entry) => entry.eventType.startsWith(TOOL_EVENT_PREFIX))
    .slice()
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .map(toToolCall);

  attachIssuedId(
    toolCalls,
    ["email_list", "email_search"],
    [input.issuedMessageHandle, ...(input.extraIssuedMessageHandles ?? [])]
  );
  attachIssuedId(
    toolCalls,
    ["email_read"],
    [input.issuedAttachmentHandle, ...(input.extraIssuedAttachmentHandles ?? [])]
  );

  return {
    model: input.model,
    toolCalls,
    finalMessage: input.finalMessage,
    odooMoves: input.odooMoves.map(coerceOdooMove),
    latencyMs: input.latencyMs,
    tokens: input.tokens,
  };
}
