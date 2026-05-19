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
