"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api-client";
import {
  fetchPendingApprovals,
  submitApprovalDecision,
  type PendingApproval,
} from "@/lib/approvals/client";

const POLL_MS = 5000;

function summarize(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

/**
 * A lightweight inbox of the acting user's pending tool-call confirmations
 * (#124 Tier 2). It polls the API and lets the user approve or deny their own
 * agent's gated calls in context. After approving, the user asks the agent to
 * proceed and the gate consumes the now-approved ticket.
 */
export function ApprovalsInbox() {
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { approvals } = await fetchPendingApprovals();
      setPending(approvals);
    } catch {
      // Background poller — transient failures self-heal on the next tick.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const decide = async (approval: PendingApproval, decision: "approve" | "deny") => {
    setBusy(approval.id);
    try {
      await submitApprovalDecision(approval.id, { decision });
      setPending((prev) => prev.filter((a) => a.id !== approval.id));
      toast.success(
        decision === "approve"
          ? `Approved — ask ${approval.agentName} to proceed.`
          : "Request denied."
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not submit your decision.");
    } finally {
      setBusy(null);
    }
  };

  if (pending.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 w-80 space-y-2"
      role="region"
      aria-label="Pending approvals"
    >
      {pending.map((a) => (
        <div key={a.id} className="rounded-lg border bg-background p-3 shadow-lg">
          <p className="text-sm font-medium">{a.agentName} needs your confirmation</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Run <span className="font-mono">{a.toolName}</span>
            {a.argsSummary && Object.keys(a.argsSummary).length > 0 ? (
              <> with {summarize(a.argsSummary)}</>
            ) : null}
            ?
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy === a.id}
              onClick={() => decide(a, "deny")}
            >
              Deny
            </Button>
            <Button size="sm" disabled={busy === a.id} onClick={() => decide(a, "approve")}>
              Approve
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
