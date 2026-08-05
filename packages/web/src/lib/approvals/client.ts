import { apiGet, apiPost } from "@/lib/api-client";
import type { DecisionBody } from "@/lib/schemas/approvals";

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

export function fetchPendingApprovals(): Promise<{ approvals: PendingApproval[] }> {
  return apiGet<{ approvals: PendingApproval[] }>("/api/approvals");
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
