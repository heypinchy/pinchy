"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import {
  fetchPendingApprovals,
  submitApprovalDecision,
  type PendingApproval,
} from "@/lib/approvals/client";

const POLL_MS = 5000;

/**
 * One poller behind every view of the pending confirmations (#1132).
 *
 * The same confirmation is now rendered in two places — inline in its own
 * thread, in the corner when that thread is not open — and each view filters
 * the list differently. Two independent pollers would drift for up to a poll
 * interval, which is exactly long enough to show one card in both places, so
 * the list is a single shared snapshot instead.
 *
 * Module-level rather than a provider: the two consumers sit on opposite sides
 * of the app layout, and a provider wrapping both would have to live above the
 * sidebar for reasons that have nothing to do with the sidebar.
 */
let snapshot: PendingApproval[] = [];
const EMPTY: PendingApproval[] = [];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

async function poll(): Promise<void> {
  // Every signed-in tab runs this; a hidden tab has nobody to act on a card,
  // so skip the request and catch up on the visibility flip.
  if (document.visibilityState === "hidden") return;
  try {
    const { approvals } = await fetchPendingApprovals();
    snapshot = approvals;
    emit();
  } catch {
    // Background poller — transient failures self-heal on the next tick.
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void poll();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Drop the stale list too: the next subscriber must not render a card
      // from before it mounted and only learn a poll later that it is gone.
      snapshot = EMPTY;
    }
  };
}

export interface PendingApprovalsView {
  approvals: PendingApproval[];
  /** The confirmation currently being submitted, if any. */
  busy: string | null;
  decide: (approval: PendingApproval, decision: "approve" | "deny") => Promise<void>;
}

export function usePendingApprovals(): PendingApprovalsView {
  const approvals = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY
  );
  const [busy, setBusy] = useState<string | null>(null);

  const decide = useCallback(async (approval: PendingApproval, decision: "approve" | "deny") => {
    setBusy(approval.id);
    try {
      const result = await submitApprovalDecision(approval.id, { decision });
      // Off the list either way: the row is settled, so a second click can
      // only 409 — leaving a card that looks actionable would be its own lie.
      snapshot = snapshot.filter((a) => a.id !== approval.id);
      emit();
      if (!result.resumed) {
        toast.error(result.resumeError ?? "Your decision did not reach the agent.");
        return;
      }
      toast.success(
        decision === "approve"
          ? `Approved — ${approval.agentName} is continuing.`
          : "Request denied."
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not submit your decision.");
    } finally {
      setBusy(null);
    }
  }, []);

  return { approvals, busy, decide };
}
