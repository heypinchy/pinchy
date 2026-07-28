"use client";

import { useEffect, useRef, useState } from "react";

import { apiGet } from "@/lib/api-client";

/** One document the index holds but cannot search. Mirrors the route's projection. */
interface UnsearchableDocument {
  sourcePath: string;
  status: "active" | "archived";
}

interface UnsearchableResponse {
  documents: UnsearchableDocument[];
  /** The untruncated count — `documents` may be capped by the route. */
  total: number;
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

  return (
    <div className="space-y-2">
      {/* "in this agent's folders" is load-bearing, not padding. The counts
          directly above are per-RUN — a document unchanged since the last index
          is `skipped`, not recounted as unsearchable — while this number covers
          everything in scope. So "4 unsearchable" over "25 documents…" is the
          normal case, and without the scope named it reads as a contradiction. */}
      <p className="text-sm text-amber-600 dark:text-amber-500">
        {result.total === 1
          ? "1 document in this agent's folders is indexed but holds no searchable text"
          : `${result.total} documents in this agent's folders are indexed but hold no searchable text`}{" "}
        — nearly always scans. Your agent won&apos;t find anything in them, so it will answer that
        it found nothing. Reading text from scans is on the roadmap.
      </p>
      <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
        {result.documents.map((doc) => (
          <li key={doc.sourcePath} className="flex items-baseline gap-2 text-sm">
            {/* The full path, not the basename: two folders can hold the same
                filename, and the path is what lets an admin go and look. */}
            <span className="font-mono text-xs break-all">{doc.sourcePath}</span>
            {doc.status === "archived" && (
              <span className="text-muted-foreground shrink-0 text-xs">archived</span>
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
