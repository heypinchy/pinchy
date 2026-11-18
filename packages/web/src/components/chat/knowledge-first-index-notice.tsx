"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ApiError, apiGet } from "@/lib/api-client";
import type { FirstIndexStatus } from "@/lib/knowledge/first-index-status";

/** How often a chat asks again while the first index is still to come. */
export const FIRST_INDEX_POLL_MS = 5_000;

function message(status: Exclude<FirstIndexStatus, { state: "none" }>): string {
  // `partial`: the agent answers from its other folders meanwhile, so only
  // the new documents are missing — never "it can't find anything".
  const what = status.partial ? "the newly added folders" : "this agent's documents";
  const until = status.partial
    ? "Until it's done, answers won't include them."
    : "Until it's done, it can't find anything in them.";
  if (status.state === "queued") return `Indexing ${what} starts in a moment. ${until}`;
  if (status.state === "waiting") {
    return `Indexing ${what} waits for the run that's going now. ${until}`;
  }
  if (status.total === null) {
    return `Reading ${what} for the first time — finding them all… ${until}`;
  }
  return `Reading ${what} for the first time — ${status.processed.toLocaleString()} of ${status.total.toLocaleString()} done. ${until}`;
}

/** Anything this component does not recognise reads as "nothing to report", never as a notice with blanks in it. */
function readStatus(raw: unknown): FirstIndexStatus {
  const value = raw as Partial<{
    state: string;
    processed: unknown;
    total: unknown;
    partial: unknown;
  }> | null;
  const partial = value?.partial === true;
  if (value?.state === "queued") return { state: "queued", partial };
  if (value?.state === "waiting") return { state: "waiting", partial };
  if (
    value?.state === "indexing" &&
    typeof value.processed === "number" &&
    (typeof value.total === "number" || value.total === null)
  ) {
    return { state: "indexing", processed: value.processed, total: value.total, partial };
  }
  return { state: "none" };
}

/**
 * Tells whoever opens a Knowledge Base agent's chat that its documents are
 * still being read for the first time (#1280). Without it a fresh agent
 * answers "nothing found", and that reads as a broken agent rather than one
 * that is still indexing.
 *
 * Asks once on open; keeps asking only while there is something to report,
 * so an ordinary chat costs one request. A failed request is retried on the
 * next round rather than ending the notice: a dropped connection is not the
 * index finishing.
 */
export function KnowledgeFirstIndexNotice({ agentId }: { agentId: string }) {
  const [status, setStatus] = useState<FirstIndexStatus>({ state: "none" });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    async function poll(keepGoing: boolean) {
      let next: FirstIndexStatus | null = null;
      try {
        next = readStatus(
          await apiGet(`/api/agents/${agentId}/knowledge/first-index`, {
            signal: controller.signal,
          })
        );
      } catch (err) {
        // A refusal (the agent is gone, or not ours to see) will not change
        // by asking again; anything else — a dropped connection — might.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) return;
      }
      if (cancelled) return;
      if (next) setStatus(next);
      const pending = next ? next.state !== "none" : keepGoing;
      if (pending) timer = setTimeout(() => void poll(true), FIRST_INDEX_POLL_MS);
    }

    // A first request that fails is asked again, like any other: until an
    // answer arrives, nothing says there is nothing to report.
    void poll(true);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [agentId]);

  if (status.state === "none") return null;

  return (
    <div
      role="status"
      className="mx-auto flex w-full items-center gap-2 rounded-2xl border bg-muted/50 px-4 py-2 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
      <span>{message(status)}</span>
    </div>
  );
}
