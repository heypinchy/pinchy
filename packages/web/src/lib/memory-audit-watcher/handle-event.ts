import type { AuditLogEntry } from "@/lib/audit";
import { computeLineDiff } from "./compute-diff";
import { parseAgentMemoryPath } from "./parse-path";

export type MemoryFileEvent =
  | { kind: "add" | "change"; absolutePath: string; newContent: string }
  | { kind: "unlink"; absolutePath: string };

export type HandleMemoryEventDeps = {
  root: string;
  snapshots: Map<string, string>;
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
  if (!agent) return;

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
