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

export function submitApprovalDecision(id: string, body: DecisionBody): Promise<void> {
  return apiPost<void, DecisionBody>(`/api/approvals/${id}/decision`, body);
}
