import { apiGet, apiPost } from "@/lib/api-client";
import { MAX_KNOWN_APPROVALS, type DecisionBody } from "@/lib/schemas/approvals";

export interface PendingApproval {
  id: string;
  agentId: string;
  agentName: string;
  toolName: string;
  argsSummary: Record<string, unknown> | null;
  sessionKey: string;
  createdAt: string;
  expiresAt: string;
}

/** A listed confirmation; `argsSummary` is absent for a card the poll named
 * as already held (`known`) — a stored summary never changes. */
export type ListedApproval = Omit<PendingApproval, "argsSummary"> &
  Partial<Pick<PendingApproval, "argsSummary">>;

export function fetchPendingApprovals(
  known: readonly string[] = []
): Promise<{ approvals: ListedApproval[] }> {
  // Bounded like the route's read of it: an unbounded list could grow the
  // request line past what a proxy accepts, and fail the poll outright.
  const named = known.slice(0, MAX_KNOWN_APPROVALS);
  const query = named.length > 0 ? `?known=${named.map(encodeURIComponent).join(",")}` : "";
  return apiGet<{ approvals: ListedApproval[] }>(`/api/approvals${query}`);
}

export interface DecisionResult {
  ok: true;
  status: string;
  /** Whether the decision reached the call OpenClaw parked for it. False means
   * the row is settled but the run was never told — the tool will not run
   * (#1132), which the user has to hear rather than a success toast. */
  resumed: boolean;
  resumeError?: string;
}

export function submitApprovalDecision(id: string, body: DecisionBody): Promise<DecisionResult> {
  return apiPost<DecisionResult, DecisionBody>(`/api/approvals/${id}/decision`, body);
}
