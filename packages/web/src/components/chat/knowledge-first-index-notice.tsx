"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { apiGet } from "@/lib/api-client";
import type { FirstIndexStatus } from "@/lib/knowledge/first-index-status";

/** How often a chat asks again while the first index is still to come. */
export const FIRST_INDEX_POLL_MS = 5_000;

function message(status: Exclude<FirstIndexStatus, { state: "none" }>): string {
  if (status.state === "queued") {
    return "Indexing hasn't started yet — another run is ahead of it. Until it's done, this agent can't find anything in its documents.";
  }
  if (status.total === null) {
    return "Reading this agent's documents for the first time — finding them all…";
  }
  return `Reading this agent's documents for the first time — ${status.processed.toLocaleString()} of ${status.total.toLocaleString()} done. Until it's finished, answers may miss documents.`;
}

/** Anything this component does not recognise reads as "nothing to report", never as a notice with blanks in it. */
function readStatus(raw: unknown): FirstIndexStatus {
  const value = raw as Partial<{ state: string; processed: unknown; total: unknown }> | null;
  if (value?.state === "queued") return { state: "queued" };
  if (
    value?.state === "indexing" &&
    typeof value.processed === "number" &&
    (typeof value.total === "number" || value.total === null)
  ) {
    return { state: "indexing", processed: value.processed, total: value.total };
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
      } catch {
        // Retried on the next round, if there is one.
      }
      if (cancelled) return;
      if (next) setStatus(next);
      const pending = next ? next.state !== "none" : keepGoing;
      if (pending) timer = setTimeout(() => void poll(true), FIRST_INDEX_POLL_MS);
    }

    void poll(false);
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
