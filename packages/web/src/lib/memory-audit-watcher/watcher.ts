import chokidar from "chokidar";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type { AuditLogEntry } from "@/lib/audit";
import { handleMemoryFileEvent } from "./handle-event";
import { parseAgentMemoryPath } from "./parse-path";

export type MemoryAuditWatcherDeps = {
  root: string;
  lookupAgent: (agentId: string) => Promise<{ id: string; name: string } | null>;
  appendAuditLog: (entry: AuditLogEntry) => Promise<void>;
  recordAuditFailure: (err: unknown, entry: AuditLogEntry) => void;
};

/**
 * Watches `<root>/agents/*\/MEMORY.md` and `<root>/agents/*\/memory/**\/*.md`
 * and routes filesystem events into `handleMemoryFileEvent`.
 *
 * Chokidar 5 dropped glob support, so we watch the parent `agents/` directory
 * recursively and use an `ignored` matcher backed by `parseAgentMemoryPath`
 * to filter to memory files only. This keeps the path-shape rules in a single
 * tested module.
 */
export async function startMemoryAuditWatcher(
  deps: MemoryAuditWatcherDeps
): Promise<() => Promise<void>> {
  const snapshots = new Map<string, string>();
  const inflight = new Map<string, Promise<void>>();
  // Captured by the wrapper objects below; chokidar's add/change/unlink
  // listeners read the latest value at event dispatch time, so the
  // "scanning" → "ready" transition flips correctly between the initial
  // crawl and steady-state events.
  let readyState: "scanning" | "ready" = "scanning";

  const agentsRoot = path.join(deps.root, "agents");

  const watcher = chokidar.watch(agentsRoot, {
    ignoreInitial: false,
    persistent: true,
    // Wait for writes to settle before firing add/change — prevents emitting
    // on partial writes during editor saves or atomic-replace flows.
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    // Filter to memory files only. The matcher fires for both directories
    // (no stats arg in some chokidar paths) and files (stats present). Return
    // `true` to ignore. We never ignore directories — they need to be walked
    // so we discover nested files under memory/. For files, we ignore unless
    // `parseAgentMemoryPath` recognizes the shape.
    ignored: (filePath: string, stats?: Stats) => {
      // No stats yet: chokidar is about to stat. Don't pre-ignore — let it
      // descend so it can discover memory files.
      if (!stats) return false;
      if (stats.isDirectory()) return false;
      // Only files reach here: ignore unless they parse as a memory path.
      return parseAgentMemoryPath(deps.root, filePath) === null;
    },
  });

  const handlerDepsBase = {
    root: deps.root,
    snapshots,
    inflight,
    lookupAgent: deps.lookupAgent,
    appendAuditLog: deps.appendAuditLog,
    recordAuditFailure: deps.recordAuditFailure,
  };

  // IMPORTANT: capture `readyState` synchronously at the moment chokidar
  // dispatches the event, NOT at the moment the async handler runs.
  // Otherwise initial-scan `add` events whose async work is detached via
  // `void` can outlive the `ready` emit, leak past the snapshotting phase,
  // and emit spurious audits for files that already existed at startup.
  const onFileEvent = async (
    kind: "add" | "change",
    absolutePath: string,
    capturedReadyState: "scanning" | "ready"
  ) => {
    let newContent: string;
    try {
      newContent = await readFile(absolutePath, "utf8");
    } catch (err) {
      // File disappeared between event and read — let a subsequent unlink
      // event drive the audit. Log at warn level so operators can see it
      // without it being treated as a hard failure.
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "memory_audit_read_failed",
          path: absolutePath,
          error: err instanceof Error ? err.message : String(err),
        })
      );
      return;
    }
    await handleMemoryFileEvent(
      { kind, absolutePath, newContent },
      { ...handlerDepsBase, readyState: capturedReadyState }
    );
  };

  watcher.on("add", (p) => {
    void onFileEvent("add", p, readyState);
  });
  watcher.on("change", (p) => {
    void onFileEvent("change", p, readyState);
  });
  watcher.on("unlink", (p) => {
    void handleMemoryFileEvent(
      { kind: "unlink", absolutePath: p },
      { ...handlerDepsBase, readyState }
    );
  });

  await new Promise<void>((resolve) => {
    watcher.on("ready", () => {
      readyState = "ready";
      resolve();
    });
  });

  return async () => {
    await watcher.close();
  };
}
