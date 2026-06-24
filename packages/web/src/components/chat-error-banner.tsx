"use client";

import { useEffect, useState } from "react";
import { apiGet, apiDelete } from "@/lib/api-client";
import { ChatErrorMessage, type ChatError } from "@/components/assistant-ui/chat-error-message";
import type { TransientReason } from "@/lib/schemas/chat-frames";
import { Button } from "@/components/ui/button";
import { DuplicateRetryConfirm } from "@/components/chat/duplicate-retry-confirm";

interface ActiveError {
  id: string;
  agentName: string;
  model: string | null;
  errorClass: string;
  transientReason: string | null;
  providerError: string;
  sideEffects: boolean;
  clientMessageId: string | null;
  createdAt: string;
  /** Role-gated guidance computed server-side from providerError (#584). */
  hint: string | null;
}

const TRANSIENT_REASONS: TransientReason[] = ["rate_limit", "overloaded", "timeout", "unavailable"];

function toChatError(error: ActiveError): ChatError {
  if (error.errorClass === "transient") {
    const reason = TRANSIENT_REASONS.includes(error.transientReason as TransientReason)
      ? (error.transientReason as TransientReason)
      : "unavailable";
    return {
      agentName: error.agentName,
      providerError: error.providerError,
      transientError: {
        kind: "transient",
        reason,
        sideEffects: error.sideEffects,
        model: error.model ?? undefined,
      },
    };
  }
  return {
    agentName: error.agentName,
    providerError: error.providerError,
    hint: error.hint,
  };
}

/**
 * Durable "paused" banner (Concern 1). On mount it asks the server for the
 * session's latest un-resolved agent error and re-surfaces it — so a rate-limit
 * (or any agent error) the live bubble lost to a reload/reconnect is still
 * visible when the user comes back. Dismiss clears it server-side; Retry resends
 * the last user message, gated behind a duplicate-write confirmation when the
 * failed run had already executed a tool.
 */
export function ChatErrorBanner({
  agentId,
  chatId,
  onRetry,
}: {
  agentId: string;
  chatId?: string | null;
  onRetry: () => void;
}) {
  const [error, setError] = useState<ActiveError | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = chatId
      ? `/api/agents/${agentId}/active-error?chatId=${encodeURIComponent(chatId)}`
      : `/api/agents/${agentId}/active-error`;
    apiGet<{ error: ActiveError | null }>(url)
      .then((res) => {
        if (!cancelled) setError(res.error);
      })
      .catch(() => {
        // Banner is best-effort context; a failed fetch just shows nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, chatId]);

  if (!error) return null;

  const handleDismiss = () => {
    const id = error.id;
    setError(null);
    void apiDelete(`/api/agents/${agentId}/active-error?id=${encodeURIComponent(id)}`).catch(
      () => {}
    );
  };

  const handleRetry = () => {
    setError(null);
    onRetry();
  };

  const retryControl = error.sideEffects ? (
    <DuplicateRetryConfirm agentName={error.agentName} onConfirm={handleRetry}>
      {(open) => (
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={open}>
          Retry
        </Button>
      )}
    </DuplicateRetryConfirm>
  ) : (
    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleRetry}>
      Retry
    </Button>
  );

  return (
    <div className="border-t px-4 py-2">
      <ChatErrorMessage
        error={toChatError(error)}
        agentId={agentId}
        historical
        onDismiss={handleDismiss}
        actionSlot={retryControl}
      />
    </div>
  );
}
