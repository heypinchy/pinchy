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
/**
 * The card the person asked to review. Shared like the list: the thread and
 * the corner are one screen, and together they draw one card's arguments at a
 * time (`openId`).
 */
let chosen: string | null = null;
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
    // A stored summary never changes and may be 0.5–1.5 MB, so the poll
    // names the cards it holds and gets those back without one. The map is
    // taken BEFORE the request: a card decided meanwhile leaves the snapshot,
    // but its summary must still be at hand if the answer lists it again.
    const held = new Map(snapshot.map((approval) => [approval.id, approval.argsSummary]));
    const { approvals } = await fetchPendingApprovals([...held.keys()]);
    snapshot = approvals.flatMap((approval): PendingApproval[] => {
      if (approval.argsSummary !== undefined && approval.argsSummary !== null)
        return [{ ...approval, argsSummary: approval.argsSummary }];
      // Never render a card without the arguments it would approve: one whose
      // summary did not come back — or came back `null`, which is what a card
      // settled mid-request carries — keeps the one it holds, or waits for the
      // next poll, which asks for it.
      const summary = held.get(approval.id);
      return summary ? [{ ...approval, argsSummary: summary }] : [];
    });
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
      chosen = null;
    }
  };
}

function choose(id: string): void {
  chosen = id;
  emit();
}

export interface PendingApprovalsView {
  approvals: PendingApproval[];
  /**
   * The one card whose arguments and Approve/Deny are drawn; every other card
   * is a line with a button to review it. The card the person chose while it
   * waits, else the first listed — the newest. One card's body is bounded (DRAW_BUDGET),
   * a stack of them is not: a person may have dozens waiting across agents,
   * and twenty at that bound took Chromium 1.7–1.8 s to draw and WebKit 3.5–3.7 s.
   * Nothing can be approved unseen — only the open card has the buttons.
   */
  openId: string | null;
  open: (id: string) => void;
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
  const picked = useSyncExternalStore(
    subscribe,
    () => chosen,
    () => null
  );
  const openId = approvals.some((a) => a.id === picked) ? picked : (approvals[0]?.id ?? null);
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

  return { approvals, openId, open: choose, busy, decide };
}
