import type { AuditLogEntry } from "@/lib/audit";
import { computeLineDiff } from "./compute-diff";
import { parseAgentMemoryPath } from "./parse-path";

export type MemoryFileEvent =
  | { kind: "add" | "change"; absolutePath: string; newContent: string }
  | { kind: "unlink"; absolutePath: string };

export type HandleMemoryEventDeps = {
  root: string;
  snapshots: Map<string, string>;
  // Per-path promise queue. Serializes concurrent events for the SAME path so
  // the snapshots Map cannot be read-then-written racily across two flushes
  // (chokidar can fire `change` twice in quick succession during a compaction).
  // Different paths still run concurrently because each path has its own entry.
  inflight: Map<string, Promise<void>>;
  lookupAgent: (agentId: string) => Promise<{ id: string; name: string } | null>;
  appendAuditLog: (entry: AuditLogEntry) => Promise<void>;
  recordAuditFailure?: (err: unknown, entry: AuditLogEntry) => void;
  readyState: "scanning" | "ready";
};

export async function handleMemoryFileEvent(
  event: MemoryFileEvent,
  deps: HandleMemoryEventDeps
): Promise<void> {
  const parsed = parseAgentMemoryPath(deps.root, event.absolutePath);
  if (!parsed) return;

  // Chain onto whatever is currently in flight for this path (if anything),
  // then store the new work. The chain ensures `doHandle` for the second event
  // doesn't read `snapshots` until the first event has written to it.
  const prev = deps.inflight.get(event.absolutePath) ?? Promise.resolve();
  const work: Promise<void> = prev
    .catch(() => {
      // Swallow prior errors here so this invocation still runs. The prior
      // invocation already surfaced its error to its own caller.
    })
    .then(() => doHandle(event, parsed, deps))
    .finally(() => {
      // Only delete if our promise is still the head — otherwise a newer event
      // has chained on us and owns the slot now.
      if (deps.inflight.get(event.absolutePath) === work) {
        deps.inflight.delete(event.absolutePath);
      }
    });
  deps.inflight.set(event.absolutePath, work);
  return work;
}

async function doHandle(
  event: MemoryFileEvent,
  parsed: { agentId: string; file: string },
  deps: HandleMemoryEventDeps
): Promise<void> {
  // During chokidar's initial scan we only populate the snapshot store; we never
  // emit audit entries, because those files predate Pinchy's process lifecycle
  // and are not state changes the user/agent just made.
  if (deps.readyState === "scanning") {
    if (event.kind !== "unlink") {
      deps.snapshots.set(event.absolutePath, event.newContent);
    }
    return;
  }

  const agent = await deps.lookupAgent(parsed.agentId);
  if (!agent) {
    // Orphan file: the agent has no DB row (e.g. it was deleted but its memory
    // directory was not). Skip BOTH the audit (we have no agent name to snapshot)
    // AND the snapshot store (don't grow unbounded with files we'll never audit).
    // If the agent row is re-created later, the next write looks like a fresh
    // `add` against an empty snapshot — correct behavior.
    return;
  }

  const oldContent = deps.snapshots.get(event.absolutePath) ?? "";
  const newContent = event.kind === "unlink" ? "" : event.newContent;
  const { addedLines, removedLines } = computeLineDiff(oldContent, newContent);

  const entry: AuditLogEntry = {
    actorType: "agent",
    actorId: agent.id,
    eventType: "agent.memory_changed",
    resource: `agent:${agent.id}`,
    outcome: "success",
    detail: {
      agent: { id: agent.id, name: agent.name },
      file: parsed.file,
      addedLines,
      removedLines,
      // For kind: "unlink" we set newContent = "" above, so byteSize === 0.
      byteSize: Buffer.byteLength(newContent, "utf8"),
    },
  };

  try {
    await deps.appendAuditLog(entry);
  } catch (err) {
    if (deps.recordAuditFailure) {
      deps.recordAuditFailure(err, entry);
    } else {
      throw err;
    }
  }

  if (event.kind === "unlink") {
    deps.snapshots.delete(event.absolutePath);
  } else {
    deps.snapshots.set(event.absolutePath, event.newContent);
  }
}
