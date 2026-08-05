/**
 * Reads OpenClaw's `plugin.approval.requested` broadcast.
 *
 * OpenClaw mints its own approval id when it suspends a call and announces it
 * to every client that may review it. Pinchy has to recognise ITS approvals in
 * that stream — the same broadcast also carries OpenClaw's own (skill workshop,
 * exec) — and learn the id, because resolving one later needs it.
 *
 * The link back to our pending row is `request.toolCallId`: the call id the
 * gate recorded when it opened the confirmation.
 */

export interface ApprovalRequested {
  /** OpenClaw's id for the suspended call (`plugin:<uuid>`). */
  approvalId: string;
  /** The tool call it is holding up — our key back to the pending row. */
  toolCallId: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Returns the approval when the event is a `plugin.approval.requested` Pinchy
 * can act on, and `null` for everything else — a different event, a payload in
 * a shape we do not know, or an approval with no tool call behind it.
 *
 * Null rather than a throw, deliberately: this runs on EVERY gateway event, so
 * an unrecognised shape is the normal case rather than an error. Throwing would
 * take the listener down for the one event it does understand.
 */
export function readApprovalRequested(event: unknown): ApprovalRequested | null {
  const frame = event as { event?: unknown; payload?: unknown } | null | undefined;
  if (frame?.event !== "plugin.approval.requested") return null;

  const payload = frame.payload as { id?: unknown; request?: unknown } | null | undefined;
  const approvalId = nonEmptyString(payload?.id);
  const request = payload?.request as { toolCallId?: unknown } | null | undefined;
  const toolCallId = nonEmptyString(request?.toolCallId);
  // An approval naming no tool call is not one of ours: every Pinchy
  // confirmation is opened from a before_tool_call hook that carries the id.
  // Matching on anything looser could resolve a call the user never saw.
  if (!approvalId || !toolCallId) return null;

  return { approvalId, toolCallId };
}
