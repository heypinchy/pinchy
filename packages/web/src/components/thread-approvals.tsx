"use client";

import { useContext } from "react";
import { AgentIdContext } from "@/components/chat";
import { ApprovalCard } from "@/components/approval-card";
import { usePendingApprovals } from "@/hooks/use-pending-approvals";

/**
 * The open agent's pending confirmations, in the conversation that raised them
 * (#1132).
 *
 * A confirmation is about something the agent said it was going to do, and the
 * corner card it replaces was spatially divorced from that message. This sits
 * at the end of the thread — where the run actually stands — and scrolls with
 * the conversation like any other turn.
 *
 * Confirmations for OTHER agents deliberately do not appear here; the corner
 * inbox keeps showing those, so a run parked in a chat the user has left is
 * still visible. The two filters are complements: shown in both places is a
 * duplicate, shown in neither is a run that times out unseen.
 */
export function ThreadApprovals() {
  const agentId = useContext(AgentIdContext);
  const { approvals, busy, decide } = usePendingApprovals();

  const mine = agentId ? approvals.filter((a) => a.agentId === agentId) : [];
  if (mine.length === 0) return null;

  return (
    <div
      className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-2 py-4"
      role="region"
      aria-label="Pending approvals"
    >
      {mine.map((a) => (
        <ApprovalCard
          key={a.id}
          approval={a}
          busy={busy === a.id}
          onDecide={(approval, decision) => void decide(approval, decision)}
        />
      ))}
    </div>
  );
}
