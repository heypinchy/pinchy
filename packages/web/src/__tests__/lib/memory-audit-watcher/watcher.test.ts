import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMemoryAuditWatcher } from "@/lib/memory-audit-watcher";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startMemoryAuditWatcher (integration)", () => {
  let root: string;
  let appended: Array<Record<string, unknown>>;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "pinchy-memwatch-"));
    mkdirSync(join(root, "agents", "agent-1", "memory"), { recursive: true });
    writeFileSync(join(root, "agents", "agent-1", "MEMORY.md"), "initial\n", "utf8");
    appended = [];

    stop = await startMemoryAuditWatcher({
      root,
      lookupAgent: async (id) => (id === "agent-1" ? { id, name: "Smithers" } : null),
      appendAuditLog: async (entry) => {
        appended.push(entry as Record<string, unknown>);
      },
      recordAuditFailure: vi.fn(),
      // Fast polling so tests complete well within the default 5 s timeout
      // even under CI load. Production uses 250 ms / 200 ms defaults.
      pollingInterval: 50,
      stabilityThreshold: 50,
    });
  });

  afterEach(async () => {
    await stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not emit during initial scan", async () => {
    // After the await-resolved startMemoryAuditWatcher, the initial scan has
    // already completed. The pre-existing MEMORY.md should NOT have been
    // audited.
    expect(appended).toHaveLength(0);
  });

  it("emits when MEMORY.md is modified", async () => {
    writeFileSync(join(root, "agents", "agent-1", "MEMORY.md"), "initial\nadded line\n", "utf8");
    // chokidar polls; give it a moment
    await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 5000 });
    expect(appended[0]).toMatchObject({
      eventType: "agent.memory_changed",
      resource: "agent:agent-1",
      detail: { file: "MEMORY.md", addedLines: 1, removedLines: 0 },
    });
  });

  it("emits when a new file is created under memory/", async () => {
    writeFileSync(
      join(root, "agents", "agent-1", "memory", "facts.md"),
      "fact 1\nfact 2\n",
      "utf8"
    );
    await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 5000 });
    expect(appended[0]).toMatchObject({
      detail: { file: "memory/facts.md", addedLines: 2, removedLines: 0 },
    });
  });

  it("emits when a memory file is deleted", async () => {
    const target = join(root, "agents", "agent-1", "memory", "fact.md");
    writeFileSync(target, "x\ny\n", "utf8");
    await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 5000 });
    appended.length = 0;
    rmSync(target);
    await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 5000 });
    expect(appended[0]).toMatchObject({
      detail: { file: "memory/fact.md", removedLines: 2, byteSize: 0 },
    });
  });

  it("ignores non-memory files in the agent directory", async () => {
    writeFileSync(join(root, "agents", "agent-1", "openclaw.json"), "{}", "utf8");
    writeFileSync(join(root, "agents", "agent-1", "notes.txt"), "x\n", "utf8");
    await wait(500); // no audit expected; cannot waitFor a negative
    expect(appended).toHaveLength(0);
  });
});

describe("startMemoryAuditWatcher (handler error resilience)", () => {
  // Separate describe block: we replace lookupAgent with a throwing one and
  // need to verify the watcher survives without raising unhandledRejection.
  let root: string;
  let appended: Array<Record<string, unknown>>;
  let stop: () => Promise<void>;
  let unhandled: unknown[];
  let unhandledHandler: (reason: unknown) => void;
  let lookupShouldThrow: boolean;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "pinchy-memwatch-err-"));
    mkdirSync(join(root, "agents", "agent-1", "memory"), { recursive: true });
    appended = [];
    unhandled = [];
    lookupShouldThrow = true;

    unhandledHandler = (reason) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", unhandledHandler);

    stop = await startMemoryAuditWatcher({
      root,
      lookupAgent: async (id) => {
        if (lookupShouldThrow) throw new Error("DB unreachable");
        return id === "agent-1" ? { id, name: "Smithers" } : null;
      },
      appendAuditLog: async (entry) => {
        appended.push(entry as Record<string, unknown>);
      },
      recordAuditFailure: vi.fn(),
      pollingInterval: 50,
      stabilityThreshold: 50,
    });
  });

  afterEach(async () => {
    process.off("unhandledRejection", unhandledHandler);
    await stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not raise unhandledRejection when lookupAgent throws, and recovers on next event", async () => {
    // Fire a write while lookup throws — the void-detached handler would
    // surface an unhandledRejection without the watcher's catch wrapper.
    writeFileSync(join(root, "agents", "agent-1", "MEMORY.md"), "first write\n", "utf8");
    // Give chokidar + the handler time to fire and reject.
    await wait(800);
    expect(unhandled).toEqual([]);
    expect(appended).toHaveLength(0); // lookup threw, no audit emitted

    // Watcher must still be alive: fix lookup, write again, expect audit.
    lookupShouldThrow = false;
    writeFileSync(
      join(root, "agents", "agent-1", "MEMORY.md"),
      "first write\nsecond write\n",
      "utf8"
    );
    await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 5000 });
    expect(unhandled).toEqual([]);
  });
});
