"use client";

import { useCallback, useState, type ReactNode } from "react";
import { apiGet } from "@/lib/api-client";
import { DuplicateRetryConfirm } from "@/components/chat/duplicate-retry-confirm";

/**
 * Retry, gated behind a duplicate-write confirmation when the failed run had
 * already executed a tool — with the gate decided at CLICK time (#1013).
 *
 * The `sideEffects` prop is what the failure already claimed: the live error
 * frame's flag, or the durable banner's row. It is provisional. OpenClaw fires
 * its `after_tool_call` hook without awaiting it, so `pinchy-audit`'s `tool.*`
 * row is ordered against nothing and can still be in flight when Pinchy derives
 * that flag. A `false` there is not evidence of a read-only run — it may simply
 * be an answer that arrived before the truth did, and it opens an unguarded
 * Retry on a run that already booked an invoice.
 *
 * So a `false` is re-checked against the server, which by now can see the row.
 * A `true` is taken at face value: the gate is monotonic (nothing un-runs a
 * tool), and a user looking at a warned failure should not wait on a fetch.
 *
 * Failing to check fails CLOSED. A needless confirm costs one click; a missing
 * one costs a duplicate.
 *
 * `children` receives the trigger's `onClick` plus a `pending` flag for the
 * window where the check is in flight — a controlled dialog rather than an
 * `asChild` trigger, so it works with any control regardless of ref forwarding.
 */
export function GatedRetry({
  agentId,
  chatId,
  agentName,
  sideEffects,
  onRetry,
  children,
}: {
  agentId?: string;
  chatId?: string | null;
  agentName?: string;
  /** What the failure frame or durable row already reported. Provisional. */
  sideEffects: boolean;
  onRetry: () => void;
  children: (start: () => void, pending: boolean) => ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const start = useCallback(() => {
    if (sideEffects) {
      setConfirming(true);
      return;
    }
    // No agent to ask about is a context-wiring bug, not evidence the run wrote
    // something. Gating every retry on it would train users to click through
    // the confirm that matters.
    if (!agentId) {
      onRetry();
      return;
    }
    // One check per click-through. Callers also disable their control while
    // `pending`, so this only has to survive the gap before that lands.
    if (pending) return;
    setPending(true);

    const url = chatId
      ? `/api/agents/${agentId}/retry-gate?chatId=${encodeURIComponent(chatId)}`
      : `/api/agents/${agentId}/retry-gate`;

    apiGet<{ sideEffects: boolean }>(url)
      .then((res) => {
        if (res.sideEffects) setConfirming(true);
        else onRetry();
      })
      .catch(() => setConfirming(true))
      .finally(() => setPending(false));
  }, [agentId, chatId, sideEffects, onRetry, pending]);

  return (
    <DuplicateRetryConfirm
      agentName={agentName}
      open={confirming}
      onOpenChange={setConfirming}
      onConfirm={onRetry}
    >
      {children(start, pending)}
    </DuplicateRetryConfirm>
  );
}
