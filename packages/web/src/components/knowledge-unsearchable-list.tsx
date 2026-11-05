"use client";

import { useEffect, useRef, useState } from "react";

import { apiGet } from "@/lib/api-client";

/** One document the index holds but cannot search. Mirrors the route's projection. */
interface UnsearchableDocument {
  sourcePath: string;
  status: "active" | "archived";
  /** `awaiting_conversion`: a Word or PowerPoint file search leaves out until it is converted again. */
  reason: "no_text" | "awaiting_conversion";
}

interface UnsearchableResponse {
  documents: UnsearchableDocument[];
  /** The untruncated count — `documents` may be capped by the route. */
  total: number;
  /** `total` per reason, untruncated as well: the shown rows can hold one reason while the scope holds both. */
  totals: Record<UnsearchableDocument["reason"], number>;
  /** Whether the agent has `knowledge_search`. Only then does Pinchy convert waiting files again on its own. */
  searchesIndex: boolean;
}

export interface KnowledgeUnsearchableListProps {
  agentId: string;
  /**
   * Whether "none" is worth saying out loud. Before any run has finished,
   * "every document has searchable text" is trivially true of an empty index
   * and would sit directly under "Not yet indexed" — a reassurance about
   * nothing. Documents that DO exist are always listed, run or no run: the
   * index is corpus-wide, so another agent's run can have filled this agent's
   * scope.
   */
  announceNone: boolean;
  /**
   * Changes when the underlying index state has moved on (a finished run), to
   * re-read the list. A plain value rather than a callback, so the parent
   * doesn't have to hold a ref to this component.
   */
  reloadKey?: string;
}

/**
 * The documents in this agent's scope that carry no searchable text (#935).
 *
 * The reindex summary counts them; this names them. A count nobody can expand
 * is the silent half of a known gap — the agent answers "I found nothing" and
 * the reader hears a statement about the world rather than about the index. On
 * the corpus that motivated this, 19 of 25 such documents were certifications:
 * exactly what a technical-sales team asks about all day.
 */
export function KnowledgeUnsearchableList({
  agentId,
  announceNone,
  reloadKey,
}: KnowledgeUnsearchableListProps) {
  const [result, setResult] = useState<UnsearchableResponse | null>(null);
  const url = `/api/agents/${agentId}/knowledge/unsearchable`;

  // Monotonic ticket, same reasoning as the reindex section's status reads: a
  // reload issued on a finished run must not be overwritten by a slower read
  // from before it.
  const fetchSeq = useRef(0);

  useEffect(() => {
    const seq = ++fetchSeq.current;
    void (async () => {
      try {
        const res = await apiGet<UnsearchableResponse>(url);
        if (seq === fetchSeq.current) setResult(res);
      } catch {
        // A failed read stays silent rather than claiming an all-clear. No
        // toast either: this panel is a detail beside the reindex control, and
        // an unreachable API already surfaces there.
      }
    })();
  }, [url, reloadKey]);

  if (!result) return null;

  if (result.total === 0) {
    if (!announceNone) return null;
    return (
      <p className="text-sm text-muted-foreground">
        Every document in this agent&apos;s folders came back with searchable text.
      </p>
    );
  }

  const hidden = result.total - result.documents.length;
  const noText = result.totals.no_text;
  const awaiting = result.totals.awaiting_conversion;
  const them = awaiting === 1 ? "it" : "them";

  return (
    <div className="space-y-2">
      {/* "in this agent's folders" is load-bearing, not padding. The counts
          directly above are per-RUN — a document unchanged since the last index
          is `skipped`, not recounted as unsearchable — while this number covers
          everything in scope. So "4 unsearchable" over "25 documents…" is the
          normal case, and without the scope named it reads as a contradiction. */}
      {noText > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-500">
          {noText === 1
            ? "1 document in this agent's folders is indexed but holds no searchable text"
            : `${noText} documents in this agent's folders are indexed but hold no searchable text`}{" "}
          — nearly always scans. Your agent won&apos;t find anything in them, so it will answer that
          it found nothing. A scan lands here when no vision model was available to read it; make
          one available and the next run reads it again.
        </p>
      )}
      {awaiting > 0 && (
        <p className="text-sm text-muted-foreground">
          {awaiting === 1
            ? "1 Word or PowerPoint file in this agent's folders is waiting to be converted again."
            : `${awaiting} Word or PowerPoint files in this agent's folders are waiting to be converted again.`}{" "}
          An update to Pinchy changed how such files are converted, and search leaves {them} out
          until then.{" "}
          {/* Pinchy queues that run itself only for agents that search the
              index (office-format-upgrade.ts). For any other agent, nothing
              runs until somebody reindexes. */}
          {result.searchesIndex
            ? `Pinchy converts ${them} again on its own.`
            : `A reindex converts ${them}.`}
        </p>
      )}
      <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
        {result.documents.map((doc) => (
          <li key={doc.sourcePath} className="flex items-baseline gap-2 text-sm">
            {/* The full path, not the basename: two folders can hold the same
                filename, and the path is what lets an admin go and look. */}
            <span className="font-mono text-xs break-all">{doc.sourcePath}</span>
            {doc.status === "archived" && (
              <span className="text-muted-foreground shrink-0 text-xs">archived</span>
            )}
            {doc.reason === "awaiting_conversion" && (
              <span className="text-muted-foreground shrink-0 text-xs">
                waiting to be converted again
              </span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-muted-foreground text-sm">
          Showing {result.documents.length} of {result.total}.
        </p>
      )}
    </div>
  );
}
