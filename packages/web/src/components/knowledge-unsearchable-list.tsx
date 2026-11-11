"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

import { apiGet } from "@/lib/api-client";
// Types only: the module itself queries the database and must never reach the
// client bundle.
import type {
  NoTextCause,
  UnsearchableDocumentsResult,
  UnsearchableGroup,
  UnsearchableSummary,
} from "@/lib/knowledge/unsearchable";

/** The route's summary answer. */
interface SummaryResponse extends UnsearchableSummary {
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
  /** Called with the number of documents that have no readable text, so the section's badge can agree with this list. */
  onNoTextCount?: (count: number) => void;
}

/**
 * The documents in this agent's scope that carry no searchable text (#935).
 *
 * The reindex summary counts them; this names them. A count nobody can expand
 * is the silent half of a known gap — the agent answers "I found nothing" and
 * the reader hears a statement about the world rather than about the index.
 *
 * A corpus can hold thousands of them (#1364), so the list is read the way an
 * admin works through it: the count first, the folders behind it, one folder's
 * files at a time, and the whole list as a CSV download.
 */
export function KnowledgeUnsearchableList({
  agentId,
  announceNone,
  reloadKey,
  onNoTextCount,
}: KnowledgeUnsearchableListProps) {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const url = `/api/agents/${agentId}/knowledge/unsearchable`;

  // Monotonic ticket, same reasoning as the reindex section's status reads: a
  // reload issued on a finished run must not be overwritten by a slower read
  // from before it.
  const fetchSeq = useRef(0);

  useEffect(() => {
    const seq = ++fetchSeq.current;
    void (async () => {
      try {
        const res = await apiGet<SummaryResponse>(url);
        if (seq === fetchSeq.current) {
          setSummary(res);
          onNoTextCount?.(res.totals.no_text);
        }
      } catch {
        // A failed read stays silent rather than claiming an all-clear. No
        // toast either: this panel is a detail beside the reindex control, and
        // an unreachable API already surfaces there.
      }
    })();
    // onNoTextCount is a state setter in practice; re-reading on its identity
    // would be a request per parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, reloadKey]);

  if (!summary) return null;

  if (summary.total === 0) {
    if (!announceNone) return null;
    return (
      <p className="text-sm text-muted-foreground">
        Every document in this agent&apos;s folders came back with searchable text.
      </p>
    );
  }

  const noText = summary.totals.no_text;
  const awaiting = summary.totals.awaiting_conversion;
  const them = awaiting === 1 ? "it" : "them";
  const documentsWord = summary.total === 1 ? "the document" : `the ${summary.total} documents`;
  const multiRoot = new Set(summary.groups.map((g) => g.root)).size > 1;

  return (
    <div className="space-y-2">
      {/* "in this agent's folders" is load-bearing, not padding. The counts
          directly above are per-RUN — a document unchanged since the last index
          is `skipped`, not recounted as unsearchable — while this number covers
          everything in scope. So "4 unsearchable" over "25 documents…" is the
          normal case, and without the scope named it reads as a contradiction. */}
      {noText > 0 && (
        <div className="space-y-1 text-sm text-amber-700 dark:text-amber-400">
          <p>
            {noText === 1
              ? "1 document in this agent's folders is indexed but holds no searchable text"
              : `${noText} documents in this agent's folders are indexed but hold no searchable text`}{" "}
            — nearly always scans. Your agent won&apos;t find anything in them, so it will answer
            that it found nothing.
          </p>
          {/* Why, per cause, as the server measured it (#1362). "No vision
              model" is the wrong advice when reading scans is switched off:
              a model would change nothing until it is switched on. */}
          {CAUSE_ORDER.map((cause) => {
            const count = summary.causes[cause];
            return count > 0 ? (
              <CauseSentence key={cause} cause={cause} count={count} of={noText} />
            ) : null;
          })}
        </div>
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
          {summary.searchesIndex
            ? `Pinchy converts ${them} again on its own.`
            : `A reindex converts ${them}.`}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-4"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
        >
          {open
            ? `Hide ${summary.total === 1 ? "the document" : "the documents"}`
            : `Show ${documentsWord}`}
        </button>
        <a
          href={`${url}/csv`}
          download
          className="font-medium text-foreground underline underline-offset-4"
        >
          Download the list
        </a>
      </div>
      {open && (
        <div id={listId} className="space-y-1">
          {summary.groups.length === 1 ? (
            // One folder: its name adds nothing the rows don't already say.
            <GroupDocuments
              url={url}
              group={summary.groups[0]}
              multiRoot={multiRoot}
              reloadKey={reloadKey}
            />
          ) : (
            summary.groups.map((group) => (
              <GroupSection
                key={`${group.root}\u0000${group.folder ?? ""}`}
                url={url}
                group={group}
                multiRoot={multiRoot}
                reloadKey={reloadKey}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** The order the causes are explained in: what an admin can change first. */
const CAUSE_ORDER: readonly NoTextCause[] = [
  "ocr_off",
  "no_vision_model",
  "read_next_run",
  "read_failed",
  "read_blank",
];

function CauseSentence({ cause, count, of }: { cause: NoTextCause; count: number; of: number }) {
  // "It"/"They" when one cause covers every no-text document; "N of them"
  // when they differ, so the shares add up in front of the reader.
  const subject = count === of ? (count === 1 ? "It" : "They") : `${count} of them`;
  const one = count === 1;
  const them = one ? "it" : "them";

  switch (cause) {
    case "ocr_off":
      return (
        <p>
          {subject} can&apos;t be read yet: reading scans is switched off on this server (
          <code className="font-mono text-xs">PINCHY_KB_OCR</code>). Once it&apos;s switched on, the
          next run reads {them}.
        </p>
      );
    case "no_vision_model":
      return (
        <p>
          {subject} can&apos;t be read yet: no vision model is available to read scans. Make one
          available and the next run reads {them}.
        </p>
      );
    case "read_next_run":
      return (
        <p>
          {subject} will be read on the next run: a vision model can read {them} now, or the last
          attempt didn&apos;t finish.
        </p>
      );
    case "read_failed":
      return (
        <p>
          {subject} couldn&apos;t be read: the file was refused — too large, damaged, or not what
          its name says — or every attempt to read {them} failed. The server log names each file and
          the reason. A file that&apos;s replaced is read again on the next run.
        </p>
      );
    case "read_blank":
      return (
        <p>
          {subject} {one ? "was" : "were"} read in full by a vision model and{" "}
          {one ? "holds" : "hold"} no text — a blank page, a picture without words, or a scan too
          faint to make out.
        </p>
      );
  }
}

/** The last segment of a granted directory: `/data/certs` → `certs`. */
function rootName(root: string): string {
  return root.split("/").filter(Boolean).pop() ?? root;
}

function groupLabel(group: UnsearchableGroup, multiRoot: boolean): string {
  if (group.folder === null) return `Directly in ${rootName(group.root)}`;
  // Two grants can hold folders of the same name.
  return multiRoot ? `${rootName(group.root)}/${group.folder}` : group.folder;
}

interface GroupProps {
  url: string;
  group: UnsearchableGroup;
  multiRoot: boolean;
  reloadKey?: string;
}

function GroupSection(props: GroupProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { group, multiRoot } = props;

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-sm py-0.5 text-left text-sm hover:bg-muted/50"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          aria-hidden="true"
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="font-medium break-all">{groupLabel(group, multiRoot)}</span>{" "}
        <span className="text-muted-foreground tabular-nums">{group.count}</span>
      </button>
      {open && (
        <div id={panelId} className="pl-5">
          <GroupDocuments {...props} />
        </div>
      )}
    </div>
  );
}

/** One group's documents, fetched when it is shown and again after each finished run. */
function GroupDocuments({ url, group, multiRoot, reloadKey }: GroupProps) {
  const [page, setPage] = useState<UnsearchableDocumentsResult | null>(null);
  const [failed, setFailed] = useState(false);
  const fetchSeq = useRef(0);

  const query = `?root=${encodeURIComponent(group.root)}${
    group.folder === null ? "" : `&folder=${encodeURIComponent(group.folder)}`
  }`;

  useEffect(() => {
    const seq = ++fetchSeq.current;
    void (async () => {
      try {
        const res = await apiGet<UnsearchableDocumentsResult>(url + query);
        if (seq === fetchSeq.current) {
          setPage(res);
          setFailed(false);
        }
      } catch {
        if (seq === fetchSeq.current) setFailed(true);
      }
    })();
  }, [url, query, reloadKey]);

  // A folder that failed to load must not read as an empty one.
  if (failed && !page) {
    return <p className="text-sm text-muted-foreground">Couldn&apos;t load these documents.</p>;
  }
  if (!page) return null;

  return (
    <div className="space-y-1">
      <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
        {page.documents.map((doc) => {
          // The path below the grant, never the mount point: it is what an
          // admin finds the file by.
          const folder = multiRoot
            ? [rootName(doc.root), doc.folder].filter(Boolean).join("/")
            : doc.folder;
          return (
            <li key={doc.sourcePath} className="text-sm">
              <span className="font-medium break-all">{doc.name}</span>
              {folder && (
                <span className="ml-2 text-xs text-muted-foreground break-all">{folder}</span>
              )}
              {doc.status === "archived" && (
                <span className="ml-2 text-xs text-muted-foreground">archived</span>
              )}
              {doc.reason === "awaiting_conversion" && (
                <span className="ml-2 text-xs text-muted-foreground">
                  waiting to be converted again
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {page.total > page.documents.length && (
        <p className="text-sm text-muted-foreground">
          Showing {page.documents.length} of {page.total} — the download has all of them.
        </p>
      )}
    </div>
  );
}
