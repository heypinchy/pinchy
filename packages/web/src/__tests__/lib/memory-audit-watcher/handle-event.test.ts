import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMemoryFileEvent } from "@/lib/memory-audit-watcher/handle-event";

describe("handleMemoryFileEvent", () => {
  const root = "/openclaw-config";
  let snapshots: Map<string, string>;
  let mockAppend: ReturnType<typeof vi.fn>;
  let mockLookupAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    snapshots = new Map();
    mockAppend = vi.fn().mockResolvedValue(undefined);
    mockLookupAgent = vi.fn().mockResolvedValue({ id: "agent-1", name: "Smithers" });
  });

  it("emits audit on first change (file added post-ready)", async () => {
    await handleMemoryFileEvent(
      {
        kind: "add",
        absolutePath: "/openclaw-config/agents/agent-1/MEMORY.md",
        newContent: "hello\n",
      },
      {
        root,
        snapshots,
        lookupAgent: mockLookupAgent,
        appendAuditLog: mockAppend,
        readyState: "ready",
      }
    );

    expect(mockAppend).toHaveBeenCalledWith({
      actorType: "agent",
      actorId: "agent-1",
      eventType: "agent.memory_changed",
      resource: "agent:agent-1",
      outcome: "success",
      detail: {
        agent: { id: "agent-1", name: "Smithers" },
        file: "MEMORY.md",
        addedLines: 1,
        removedLines: 0,
        byteSize: 6,
      },
    });
    expect(snapshots.get("/openclaw-config/agents/agent-1/MEMORY.md")).toBe("hello\n");
  });

  it("does NOT emit audit during initial scan (readyState='scanning')", async () => {
    await handleMemoryFileEvent(
      {
        kind: "add",
        absolutePath: "/openclaw-config/agents/agent-1/MEMORY.md",
        newContent: "hello\n",
      },
      {
        root,
        snapshots,
        lookupAgent: mockLookupAgent,
        appendAuditLog: mockAppend,
        readyState: "scanning",
      }
    );
    expect(mockAppend).not.toHaveBeenCalled();
    expect(snapshots.get("/openclaw-config/agents/agent-1/MEMORY.md")).toBe("hello\n");
  });

  it("emits added+removed counts on modify", async () => {
    snapshots.set("/openclaw-config/agents/agent-1/memory/foo.md", "a\nb\nc\n");
    await handleMemoryFileEvent(
      {
        kind: "change",
        absolutePath: "/openclaw-config/agents/agent-1/memory/foo.md",
        newContent: "a\nX\nc\n",
      },
      {
        root,
        snapshots,
        lookupAgent: mockLookupAgent,
        appendAuditLog: mockAppend,
        readyState: "ready",
      }
    );
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "agent.memory_changed",
        resource: "agent:agent-1",
        detail: expect.objectContaining({
          file: "memory/foo.md",
          addedLines: 1,
          removedLines: 1,
          byteSize: 6,
        }),
      })
    );
  });

  it("emits a deletion (byteSize 0, removedLines = previous line count)", async () => {
    snapshots.set("/openclaw-config/agents/agent-1/MEMORY.md", "a\nb\n");
    await handleMemoryFileEvent(
      { kind: "unlink", absolutePath: "/openclaw-config/agents/agent-1/MEMORY.md" },
      {
        root,
        snapshots,
        lookupAgent: mockLookupAgent,
        appendAuditLog: mockAppend,
        readyState: "ready",
      }
    );
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          file: "MEMORY.md",
          addedLines: 0,
          removedLines: 2,
          byteSize: 0,
        }),
      })
    );
    expect(snapshots.has("/openclaw-config/agents/agent-1/MEMORY.md")).toBe(false);
  });

  it("ignores paths outside agents/<id>/MEMORY.md|memory/", async () => {
    await handleMemoryFileEvent(
      { kind: "change", absolutePath: "/openclaw-config/openclaw.json", newContent: "{}" },
      {
        root,
        snapshots,
        lookupAgent: mockLookupAgent,
        appendAuditLog: mockAppend,
        readyState: "ready",
      }
    );
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("skips emission if agent is not found in DB (orphan file)", async () => {
    mockLookupAgent.mockResolvedValueOnce(null);
    await handleMemoryFileEvent(
      { kind: "add", absolutePath: "/openclaw-config/agents/ghost/MEMORY.md", newContent: "x\n" },
      {
        root,
        snapshots,
        lookupAgent: mockLookupAgent,
        appendAuditLog: mockAppend,
        readyState: "ready",
      }
    );
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("uses recordAuditFailure when appendAuditLog throws (does not rethrow)", async () => {
    const failure = new Error("DB unreachable");
    mockAppend.mockRejectedValueOnce(failure);
    const mockRecordFailure = vi.fn();
    await handleMemoryFileEvent(
      {
        kind: "add",
        absolutePath: "/openclaw-config/agents/agent-1/MEMORY.md",
        newContent: "hi\n",
      },
      {
        root,
        snapshots,
        lookupAgent: mockLookupAgent,
        appendAuditLog: mockAppend,
        recordAuditFailure: mockRecordFailure,
        readyState: "ready",
      }
    );
    expect(mockRecordFailure).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        eventType: "agent.memory_changed",
      })
    );
  });
});
