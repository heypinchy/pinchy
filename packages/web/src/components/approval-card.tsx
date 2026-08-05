"use client";

import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/lib/approvals/client";

function summarize(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

/** One pending confirmation, rendered the same whether it sits in the thread
 * that raised it or in the corner (#1132). Only the container differs. */
export function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: PendingApproval;
  busy: boolean;
  onDecide: (approval: PendingApproval, decision: "approve" | "deny") => void;
}) {
  return (
    <div className="rounded-lg border bg-background p-3 shadow-lg">
      <p className="text-sm font-medium">{approval.agentName} needs your confirmation</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Run <span className="font-mono">{approval.toolName}</span>
        {approval.argsSummary && Object.keys(approval.argsSummary).length > 0 ? (
          <> with {summarize(approval.argsSummary)}</>
        ) : null}
        ?
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onDecide(approval, "deny")}
        >
          Deny
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onDecide(approval, "approve")}>
          Approve
        </Button>
      </div>
    </div>
  );
}
