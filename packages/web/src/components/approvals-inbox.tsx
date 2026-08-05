"use client";

import { useParams } from "next/navigation";
import { ApprovalCard } from "@/components/approval-card";
import { usePendingApprovals } from "@/hooks/use-pending-approvals";

/**
 * Pending confirmations for agents whose chat is NOT currently open (#124 Tier
 * 2, placement per #1132).
 *
 * The open agent's confirmations render inline in its thread, where the action
 * stands. This is the fallback for everything else: a run parked in a chat the
 * user has left is held for at most 10 minutes, so dropping its card would let
 * it time out with nobody ever seeing it.
 *
 * The open agent is read from the route (`/chat/[agentId]`) rather than passed
 * down — this sits above the chat in the tree, so there is no context to read.
 */
export function ApprovalsInbox() {
  const params = useParams<{ agentId?: string }>();
  const openAgentId = params?.agentId;
  const { approvals, busy, decide } = usePendingApprovals();

  const elsewhere = approvals.filter((a) => a.agentId !== openAgentId);
  if (elsewhere.length === 0) return null;

  return (
    <div
      // Scrollable and height-bounded: the server caps how many confirmations
      // one person can have open, but that cap is a wall of cards, not one —
      // and an unbounded stack here covers the app it is asking about, with the
      // oldest card pushed off-screen and unreachable.
      className="fixed bottom-4 right-4 z-50 flex max-h-[calc(100vh-2rem)] w-80 flex-col gap-2 overflow-y-auto"
      role="region"
      aria-label="Pending approvals"
    >
      {elsewhere.map((a) => (
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
