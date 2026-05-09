"use client";

import { AlertTriangle, Clock, WifiOff } from "lucide-react";
import Link from "next/link";
import { useState, type FC, type ReactNode } from "react";
import { PROVIDER_SETTINGS_HINT } from "@/server/error-hints";
import { ReportIssueLink } from "@/components/report-issue-link";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import type { ModelUnavailableError } from "@/lib/schemas/chat-frames";

export interface ChatError {
  agentName?: string;
  providerError?: string;
  hint?: string | null;
  message?: string;
  disconnected?: true;
  timedOut?: true;
  payloadTooLarge?: true;
  modelUnavailable?: ModelUnavailableError;
}

export const ChatErrorMessage: FC<{
  error: ChatError;
  agentId: string;
  actionSlot?: ReactNode;
}> = ({ error, agentId, actionSlot }) => {
  const [isOpen, setIsOpen] = useState(false);

  const wrapperClass =
    "rounded-md border border-destructive bg-destructive/10 p-3 text-sm dark:bg-destructive/5";

  if (error.payloadTooLarge) {
    return (
      <div role="alert" className={wrapperClass}>
        <div className="flex items-center gap-2 font-medium text-destructive dark:text-red-200">
          <AlertTriangle className="size-4 shrink-0" data-testid="too-large-icon" />
          <span className="flex-1">Image too large</span>
          {actionSlot}
        </div>
        <p className="mt-1.5 text-destructive/90 dark:text-red-300/90">
          {error.message ?? "The image you attached is too large to send."}
        </p>
      </div>
    );
  }

  if (error.disconnected) {
    return (
      <div role="alert" className={wrapperClass}>
        <div className="flex items-center gap-2 font-medium text-destructive dark:text-red-200">
          <WifiOff className="size-4 shrink-0" data-testid="disconnect-icon" />
          <span className="flex-1">Connection lost</span>
          {actionSlot}
        </div>
        <p className="mt-1.5 text-destructive/90 dark:text-red-300/90">
          The connection was interrupted. Your last message may not have been processed.
        </p>
        <p className="mt-1.5 text-destructive/75 dark:text-red-300/75">
          <ReportIssueLink error="Connection lost during active stream" />
        </p>
      </div>
    );
  }

  if (error.timedOut) {
    return (
      <div role="alert" className={wrapperClass}>
        <div className="flex items-center gap-2 font-medium text-destructive dark:text-red-200">
          <Clock className="size-4 shrink-0" data-testid="timeout-icon" />
          <span className="flex-1">No response</span>
          {actionSlot}
        </div>
        <p className="mt-1.5 text-destructive/90 dark:text-red-300/90">
          The agent didn&apos;t respond within 60 seconds. It may be overloaded or stuck.
        </p>
        <p className="mt-1.5 text-destructive/75 dark:text-red-300/75">
          You can send your message again to retry.{" "}
          <ReportIssueLink error="Agent timed out — no response after 60 seconds" />
        </p>
      </div>
    );
  }

  if (error.modelUnavailable) {
    return (
      <div role="alert" className={wrapperClass}>
        <div className="flex items-center gap-2 font-medium text-destructive dark:text-red-200">
          <AlertTriangle className="size-4 shrink-0" data-testid="error-warning-icon" />
          <span className="flex-1">{`${error.agentName ?? "The agent"} couldn't respond`}</span>
          {actionSlot}
        </div>
        <p className="mt-1.5 text-destructive/90 dark:text-red-300/90">
          The model <code className="font-mono text-xs">{error.modelUnavailable.model}</code>{" "}
          returned an error from its provider. This is usually transient — try again in a moment.
        </p>
        <p className="mt-1 text-destructive/75 dark:text-red-300/75">
          If it keeps failing, the model may no longer be available.
        </p>
        {agentId && (
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href={`/chat/${agentId}/settings?tab=general#model`}>Switch model →</Link>
          </Button>
        )}
        <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mt-3">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="text-xs">
              Technical details
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1 text-xs text-destructive/75 dark:text-red-300/75 whitespace-pre-wrap break-words">
              {error.providerError}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  }

  const isProviderError = !!error.providerError;
  const agentLabel = error.agentName ?? "The assistant";

  return (
    <div role="alert" className={wrapperClass}>
      {isProviderError ? (
        <>
          <div className="flex items-center gap-2 font-medium text-destructive dark:text-red-200">
            <AlertTriangle className="size-4 shrink-0" data-testid="error-warning-icon" />
            <span className="flex-1">{`${agentLabel} couldn't respond`}</span>
            {actionSlot}
          </div>
          <p className="mt-1.5 text-destructive/90 dark:text-red-300/90">{error.providerError}</p>
          {error.hint && (
            <p className="mt-1.5 text-destructive/75 dark:text-red-300/75" data-testid="error-hint">
              {error.hint === PROVIDER_SETTINGS_HINT ? (
                <>
                  Go to{" "}
                  <Link
                    href="/settings?tab=provider"
                    className="underline underline-offset-2 hover:opacity-80"
                  >
                    Settings &gt; Providers
                  </Link>{" "}
                  to check your API configuration.
                </>
              ) : (
                error.hint
              )}
            </p>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2 text-destructive dark:text-red-200">
          <AlertTriangle className="size-4 shrink-0" data-testid="error-warning-icon" />
          <span className="flex-1">{error.message}</span>
          {actionSlot}
        </div>
      )}
    </div>
  );
};
