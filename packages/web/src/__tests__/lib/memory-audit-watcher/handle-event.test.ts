import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMemoryFileEvent } from "@/lib/memory-audit-watcher/handle-event";

describe("handleMemoryFileEvent", () => {
  const root = "/openclaw-config";
  let snapshots: Map<string, string>;
  let inflight: Map<string, Promise<void>>;
  let mockAppend: ReturnType<typeof vi.fn>;
  let mockLookupAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    snapshots = new Map();
    inflight = new Map();
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
        inflight,
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
        inflight,
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
        inflight,
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
        inflight,
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
        inflight,
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
        inflight,
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
        inflight,
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

  it("rethrows when appendAuditLog throws and recordAuditFailure is not supplied", async () => {
    const failure = new Error("DB unreachable");
    mockAppend.mockRejectedValueOnce(failure);
    await expect(
      handleMemoryFileEvent(
        {
          kind: "add",
          absolutePath: "/openclaw-config/agents/agent-1/MEMORY.md",
          newContent: "hi\n",
        },
        {
          root,
          snapshots,
          inflight,
          lookupAgent: mockLookupAgent,
          appendAuditLog: mockAppend,
          readyState: "ready",
        }
      )
    ).rejects.toThrow("DB unreachable");
  });

  it("serializes concurrent events for the same path (no TOCTOU on snapshots)", async () => {
    // Build a deferred appendAuditLog: the first call returns a promise the test
    // resolves manually so we can fire a second event while the first is still
    // mid-flight. Subsequent calls resolve immediately.
    let firstResolve: (() => void) | undefined;
    const firstAppendPromise = new Promise<void>((resolve) => {
      firstResolve = () => resolve();
    });
    mockAppend.mockImplementationOnce(() => firstAppendPromise).mockResolvedValue(undefined);

    const absolutePath = "/openclaw-config/agents/agent-1/MEMORY.md";
    // Seed: snapshot starts empty (file did not exist before).

    const deps = {
      root,
      snapshots,
      inflight,
      lookupAgent: mockLookupAgent,
      appendAuditLog: mockAppend,
      readyState: "ready" as const,
    };

    // Fire two events back-to-back for the SAME path. Do not await the first.
    const p1 = handleMemoryFileEvent({ kind: "change", absolutePath, newContent: "first\n" }, deps);
    const p2 = handleMemoryFileEvent(
      { kind: "change", absolutePath, newContent: "first\nsecond\n" },
      deps
    );

    // Resolve the first append so the second invocation can proceed.
    firstResolve!();
    await Promise.all([p1, p2]);

    // Both events must emit; nothing is swallowed.
    expect(mockAppend).toHaveBeenCalledTimes(2);

    // First call diff: baseline "" -> "first\n" => 1 added, 0 removed.
    const firstCallEntry = mockAppend.mock.calls[0][0];
    expect(firstCallEntry.detail).toMatchObject({
      file: "MEMORY.md",
      addedLines: 1,
      removedLines: 0,
    });

    // Second call MUST see the first event's newContent as its baseline.
    // baseline "first\n" -> "first\nsecond\n" => 1 added, 0 removed.
    // (Without serialization the old code would diff "" -> "first\nsecond\n",
    // producing addedLines: 2 — that's the bug we're fixing.)
    const secondCallEntry = mockAppend.mock.calls[1][0];
    expect(secondCallEntry.detail).toMatchObject({
      file: "MEMORY.md",
      addedLines: 1,
      removedLines: 0,
    });

    // Final snapshot reflects the second event.
    expect(snapshots.get(absolutePath)).toBe("first\nsecond\n");

    // Inflight map is fully drained.
    expect(inflight.has(absolutePath)).toBe(false);
  });
});
