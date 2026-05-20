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
  /** Polling interval in ms (default: 250). Lower values increase responsiveness at the cost of more FS I/O. */
  pollingInterval?: number;
  /** Write stabilization threshold in ms (default: 200). Events fire only after the file hasn't changed for this long. */
  stabilityThreshold?: number;
  /**
   * Whether chokidar should use fs.stat polling (default: `true`) or native
   * fs.watch (inotify on Linux, fsevents on macOS). Production keeps polling
   * because the watch root is typically a Docker bind-mounted directory
   * where fs.watch is unreliable. Integration tests pass `false` because
   * polling is at the mercy of the JS event loop — under vitest's parallel-
   * test load on slow CI runners, the polling timer gets starved and events
   * miss their 5 s budget. Native fs.watch is delivered from the kernel and
   * is immune to event-loop pressure.
   */
  usePolling?: boolean;
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
    // Polling rather than fs.watch / fsevents. The watch root is typically a
    // Docker bind-mounted directory (production `/openclaw-config`, integration
    // `/tmp/pinchy-integration-openclaw`). Native fs.watch on macOS does not
    // reliably propagate events for files created from inside a container into
    // host watchers, so a dir created by OpenClaw is silently missed and any
    // later host-side write to that dir never fires either. Polling every
    // 250 ms is well within budget for a watch tree of a few dozen agents and
    // makes the watcher behave identically across all host/container setups.
    // Tests override via `usePolling: false` so events come from inotify/
    // fsevents and aren't subject to event-loop starvation under parallel
    // vitest load (see PR #403 CI flake history).
    usePolling: deps.usePolling ?? true,
    interval: deps.pollingInterval ?? 250,
    // Wait for writes to settle before firing add/change — prevents emitting
    // on partial writes during editor saves or atomic-replace flows.
    awaitWriteFinish: { stabilityThreshold: deps.stabilityThreshold ?? 200, pollInterval: 50 },
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

  // We detach handler invocations from the chokidar event loop with `.catch`
  // wrappers. Without them, any uncaught rejection (e.g. lookupAgent throws
  // because the DB is momentarily down) becomes an unhandledRejection and
  // can crash the host process under Node's --unhandled-rejections=strict
  // mode. Catch and log so the watcher stays up — the alternative would be
  // losing all future memory-audit coverage after a single transient blip.
  const logWatcherError = (err: unknown, absolutePath: string) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "memory_audit_watcher_handler_failed",
        path: absolutePath,
        error: err instanceof Error ? err.message : String(err),
      })
    );
  };

  watcher.on("add", (p) => {
    onFileEvent("add", p, readyState).catch((err) => logWatcherError(err, p));
  });
  watcher.on("change", (p) => {
    onFileEvent("change", p, readyState).catch((err) => logWatcherError(err, p));
  });
  watcher.on("unlink", (p) => {
    handleMemoryFileEvent(
      { kind: "unlink", absolutePath: p },
      { ...handlerDepsBase, readyState }
    ).catch((err) => logWatcherError(err, p));
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
