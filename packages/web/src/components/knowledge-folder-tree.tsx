"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronRight, Folder, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiGet } from "@/lib/api-client";
import { cn } from "@/lib/utils";
// Types only — erased at build time, so the server-side module never reaches the client bundle.
import type { FolderState } from "@/lib/knowledge/folder-plan";
import type {
  FileFilter,
  FileScope,
  FileState,
  FolderFilesResult,
  FolderStatus,
  FolderStatusResult,
  RootFolderStatus,
} from "@/lib/knowledge/index-status";

export interface KnowledgeFolderTreeProps {
  agentId: string;
  /** Changes when the index state has moved on (a run started or finished), to re-read the tree. */
  reloadKey?: string;
  /** How often to re-read while a run is in flight. */
  pollIntervalMs?: number;
  /** Page size of a folder's file list. */
  pageSize?: number;
}

const FOLDER_STATE: Record<FolderState, { label: string; className: string }> = {
  indexing: {
    label: "Indexing now",
    className: "border-blue-500/40 text-blue-700 dark:text-blue-300",
  },
  queued: { label: "Queued", className: "text-muted-foreground" },
  searchable: {
    label: "Searchable",
    className: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  },
  has_errors: {
    label: "Needs attention",
    className: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  },
  not_indexed: { label: "Not indexed yet", className: "text-muted-foreground" },
  empty: { label: "No files", className: "text-muted-foreground" },
};

const FILE_STATE: Record<FileState, { label: string; attention: boolean }> = {
  searchable: { label: "Searchable", attention: false },
  changed: { label: "Changed since it was indexed", attention: false },
  no_text: { label: "No searchable text", attention: true },
  awaiting_conversion: { label: "Waiting to be converted again", attention: true },
  pending: { label: "Queued", attention: false },
  failed: { label: "Not indexed", attention: true },
  new: { label: "Added since the last run", attention: false },
  unsupported: { label: "File type not supported yet", attention: false },
  // Not a document (#1410): skipped on purpose, named so nothing is hidden.
  ignored: { label: "Not a document — skipped", attention: false },
};

/**
 * What a Knowledge Base agent can search, folder by folder (#1386).
 *
 * One row per granted folder and per subfolder directly below it: a state, how
 * many of its files search can use, and when it was last indexed. Any row opens
 * the folder's file list, which is where "why doesn't it know about X?" gets its
 * answer. Read-only on purpose — the same tree serves an admin in the agent's
 * settings and a member from the chat, and neither changes anything here.
 */
export function KnowledgeFolderTree({
  agentId,
  reloadKey,
  pollIntervalMs = 5000,
  pageSize = 50,
}: KnowledgeFolderTreeProps) {
  const [result, setResult] = useState<FolderStatusResult | null>(null);
  const [failed, setFailed] = useState(false);
  const url = `/api/agents/${agentId}/knowledge/folders`;

  // Newest read wins, as in the reindex section: a slow early answer must not
  // overwrite a later one.
  const fetchSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const res = await apiGet<FolderStatusResult>(url);
      if (seq === fetchSeq.current) {
        setResult(res);
        setFailed(false);
      }
    } catch {
      // Keep the last answer. Only a tree that never had one says it failed.
      if (seq === fetchSeq.current) setFailed(true);
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const active = result?.job?.status === "pending" || result?.job?.status === "running";
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void load(), pollIntervalMs);
    return () => clearInterval(id);
  }, [active, load, pollIntervalMs]);

  if (!result) {
    if (!failed) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>We couldn&apos;t load the folders.</span>
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  if (result.folders.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">This agent has no folders to search yet.</p>
    );
  }

  return (
    <ul className="divide-y rounded-md border" aria-label="Folders this agent searches">
      {result.folders.map((root) => (
        <RootRow key={root.path} agentId={agentId} root={root} pageSize={pageSize} />
      ))}
    </ul>
  );
}

function RootRow({
  agentId,
  root,
  pageSize,
}: {
  agentId: string;
  root: RootFolderStatus;
  pageSize: number;
}) {
  const [open, setOpen] = useState(false);
  const childrenId = useId();
  const hasChildren = root.children.length > 0;

  return (
    <li>
      <FolderRow
        agentId={agentId}
        folder={root}
        pageSize={pageSize}
        title={root.path}
        scope="direct"
        toggle={
          hasChildren ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-expanded={open}
              aria-controls={childrenId}
              aria-label={`${open ? "Hide" : "Show"} subfolders of ${root.path}`}
              onClick={() => setOpen((o) => !o)}
            >
              <ChevronRight
                className={cn(
                  "size-4 transition-transform motion-reduce:transition-none",
                  open && "rotate-90"
                )}
                aria-hidden="true"
              />
            </Button>
          ) : (
            <span className="size-7 shrink-0" aria-hidden="true" />
          )
        }
      />
      {hasChildren && open && (
        <ul id={childrenId} className="divide-y border-t bg-muted/20">
          {root.children.map((child) => (
            <li key={child.path} className="pl-6">
              <FolderRow
                agentId={agentId}
                folder={child}
                pageSize={pageSize}
                title={child.name}
                scope="tree"
                toggle={<span className="size-7 shrink-0" aria-hidden="true" />}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function FolderRow({
  agentId,
  folder,
  pageSize,
  title,
  toggle,
  scope,
}: {
  agentId: string;
  folder: FolderStatus;
  pageSize: number;
  title: string;
  toggle: React.ReactNode;
  /**
   * Which files the row's list holds. A root row lists only its own files,
   * since each subfolder has a row and a list of its own; a subfolder row lists
   * its whole subtree, as its counts do — even when it is also a granted root.
   */
  scope: FileScope;
}) {
  const [showFiles, setShowFiles] = useState(false);
  const filesId = useId();
  const state = FOLDER_STATE[folder.state];

  return (
    <div>
      {/* The name's box starts at its text width and the row wraps, so the
          metadata moves below the name before the name is cut (#1401). */}
      <div className="flex flex-col gap-1 px-2 py-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
        <div className="flex min-w-0 max-w-full grow items-center gap-1">
          {toggle}
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate font-mono text-xs" title={folder.path}>
            {title}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-8 text-xs text-muted-foreground sm:pl-0">
          <Badge variant="outline" className={state.className}>
            {state.label}
          </Badge>
          <span>{countText(folder)}</span>
          {folder.lastIndexedAt && (
            <span>
              Indexed{" "}
              <time dateTime={folder.lastIndexedAt}>{formatDate(folder.lastIndexedAt)}</time>
            </span>
          )}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            aria-expanded={showFiles}
            aria-controls={filesId}
            aria-label={`${showFiles ? "Hide" : "Show"} files in ${folder.path}`}
            onClick={() => setShowFiles((s) => !s)}
          >
            {showFiles ? "Hide files" : "Files"}
          </Button>
        </div>
      </div>
      {showFiles && (
        <div id={filesId} className="border-t px-3 py-3">
          <FolderFiles agentId={agentId} folder={folder.path} pageSize={pageSize} scope={scope} />
        </div>
      )}
    </div>
  );
}

/** "12 of 40 files searchable", against what the last run found when it recorded that. */
export function countText(folder: FolderStatus): string {
  if (folder.state === "indexing" || folder.state === "queued") {
    // Nothing pending while queued means the new run has not listed its files
    // yet: `expected` is still the last run's count, so "N of N done" would lie.
    if (folder.expected !== null && (folder.pending > 0 || folder.state === "indexing")) {
      // A run reads archived subfolders last (#1405): count the current files,
      // and the archive apart — unless archive is all the folder holds.
      const current = folder.expected - folder.expectedArchived;
      if (current === 0) {
        const done = Math.max(0, folder.expected - folder.pending);
        return `${done} of ${folder.expected} archived ${plural(folder.expected, "file")} done`;
      }
      const done = Math.max(0, current - (folder.pending - folder.pendingArchived));
      const text = `${done} of ${current} ${plural(current, "file")} done`;
      const archive = folder.pendingArchived;
      return archive === 0
        ? text
        : `${text} · ${archive} archived ${plural(archive, "file")} queued`;
    }
    return "Waiting for the run to list its files";
  }
  // A run reads archived subfolders last (#1405). With only archive left, the
  // state speaks for the current files: count them alone, and the archive
  // apart — whatever of it the index already holds from an earlier run.
  const archive = folder.pendingArchived;
  const current = archive > 0;
  const of =
    folder.expected === null
      ? folder.indexed
      : folder.expected - (current ? folder.expectedArchived : 0);
  if (of === 0) return folder.state === "empty" ? "Nothing to index here" : "No files indexed yet";
  const searchableDocs = folder.searchable - (current ? folder.archivedSearchable : 0);
  const failing = folder.notSearchable - (current ? folder.archivedNotSearchable : 0);
  // Documents of files deleted since the last run stay in the index until a
  // run succeeds, so the index can hold more than the folder does. Count down
  // from the folder by what fails here instead.
  const done = Math.max(0, Math.min(searchableDocs, of - failing));
  const searchable = `${done} of ${of} ${plural(of, "file")} searchable`;
  if (archive === 0) return searchable;
  if (folder.indexingArchive) return `${searchable} · indexing archived files, ${archive} left`;
  return `${searchable} · ${archive} archived ${plural(archive, "file")} queued`;
}

function FolderFiles({
  agentId,
  folder,
  pageSize,
  scope,
}: {
  agentId: string;
  folder: string;
  pageSize: number;
  scope: FileScope;
}) {
  const [filter, setFilter] = useState<FileFilter>("all");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState<FolderFilesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const searchId = useId();
  const fetchSeq = useRef(0);

  // A short pause before searching, so typing a name is one request, not one per key.
  useEffect(() => {
    const id = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const fetchPage = useCallback(
    async (offset: number) => {
      const seq = ++fetchSeq.current;
      const params = new URLSearchParams({
        folder,
        filter,
        offset: String(offset),
        limit: String(pageSize),
        scope,
      });
      if (q) params.set("q", q);
      try {
        const res = await apiGet<FolderFilesResult>(
          `/api/agents/${agentId}/knowledge/files?${params.toString()}`
        );
        if (seq === fetchSeq.current) {
          setPage((prev) =>
            offset > 0 && prev ? { ...res, files: [...prev.files, ...res.files] } : res
          );
          setFailed(false);
          setLoading(false);
        }
      } catch {
        if (seq === fetchSeq.current) {
          setFailed(true);
          setLoading(false);
        }
      }
    },
    [agentId, folder, filter, q, pageSize, scope]
  );

  useEffect(() => {
    // Deferred past the effect body (react-hooks/set-state-in-effect) — same
    // pattern as connected-apps.tsx. A stale answer is dropped by `fetchSeq`.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void fetchPage(0);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <label htmlFor={searchId} className="sr-only">
            Search files by name
          </label>
          <Input
            id={searchId}
            type="search"
            placeholder="Search by name"
            className="h-8 pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div role="group" aria-label="Show" className="flex gap-1">
          <Button
            size="sm"
            variant={filter === "all" ? "secondary" : "ghost"}
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All
          </Button>
          <Button
            size="sm"
            variant={filter === "not_searchable" ? "secondary" : "ghost"}
            aria-pressed={filter === "not_searchable"}
            onClick={() => setFilter("not_searchable")}
          >
            Not yet searchable
          </Button>
        </div>
      </div>

      {failed && !page ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>We couldn&apos;t load the files.</span>
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void fetchPage(0)}>
            Try again
          </Button>
        </div>
      ) : page ? (
        <>
          <p className="text-xs text-muted-foreground" role="status">
            {scope === "direct" && "Directly in this folder: "}
            {page.totals.searchable} of {page.totals.all} {plural(page.totals.all, "file")}{" "}
            searchable
            {outsideIndexText(page.totals)}
            {page.truncated &&
              " — this folder is too large to list in full, so counts cover part of it"}
            .
          </p>
          {page.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {q || filter !== "all"
                ? "No files match."
                : scope === "direct"
                  ? "No files directly in this folder. Open a subfolder to see its files."
                  : "No files in this folder."}
            </p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {page.files.map((file) => {
                const state = FILE_STATE[file.state];
                return (
                  <li
                    key={file.path}
                    className="flex flex-col gap-0.5 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
                  >
                    <span className="min-w-0 font-mono text-xs break-all">{file.name}</span>
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        state.attention
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-muted-foreground"
                      )}
                    >
                      {state.label}
                      {file.archived && " · archived"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {page.files.length < page.total && (
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => {
                  setLoading(true);
                  void fetchPage(page.files.length);
                }}
              >
                Show more
              </Button>
              <span className="text-xs text-muted-foreground">
                Showing {page.files.length} of {page.total}
              </span>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/**
 * The files a listing found but the index leaves out, documents it cannot read
 * yet apart from files that are not documents at all (#1410).
 */
function outsideIndexText(totals: { unsupported: number; ignored: number }): string {
  const parts: string[] = [];
  if (totals.unsupported > 0) {
    parts.push(
      `${totals.unsupported} ${plural(totals.unsupported, "file")} the index can't read yet`
    );
  }
  if (totals.ignored > 0) {
    parts.push(
      totals.ignored === 1
        ? "1 file skipped because it isn't a document"
        : `${totals.ignored} files skipped because they aren't documents`
    );
  }
  return parts.length > 0 ? `, plus ${parts.join(" and ")}` : "";
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
