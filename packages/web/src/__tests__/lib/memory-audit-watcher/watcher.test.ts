import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMemoryAuditWatcher } from "@/lib/memory-audit-watcher";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Each test interacts with the real filesystem. Polling is platform-
// conditional (see beforeEach) — Linux uses inotify, macOS keeps polling.
// 15 s per test stays as a safety margin for vitest workers contending
// for I/O during a parallel run.
describe("startMemoryAuditWatcher (integration)", { timeout: 15000 }, () => {
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
      // Platform-conditional: on Linux CI, polling under vitest's parallel
      // worker load misses the per-test budget (PR #403 flakes — runs
      // 26117628151 / 26120213811). inotify delivers from the kernel and
      // is immune to JS event-loop starvation, so Linux gets native
      // fs.watch. macOS keeps polling because fsevents has known
      // reliability issues for events on freshly-created subdirectories,
      // which would flip the same tests from "flaky on CI" to "flaky on
      // dev-loop macOS" — same problem, different platform. The
      // Docker-bind-mount unreliability that makes production keep
      // polling doesn't apply here; test tmpdirs are on the native FS.
      usePolling: process.platform !== "linux",
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

// Polling-vs-native isn't just a perf detail — it's the root cause of CI
// flakes (PR #403, runs 26117628151 / 26120213811). chokidar's fs.stat
// polling timer is at the mercy of the JS event loop, which gets starved
// under vitest's parallel-test load. Native fs.watch (inotify on Linux,
// fsevents on macOS) delivers events from the kernel and is immune to
// event-loop pressure — but production sticks with polling because the
// watch root there is a Docker bind mount where fs.watch is unreliable.
// This test pins the deps shape so a future refactor can't silently drop
// the knob and re-introduce the CI flake.
describe("startMemoryAuditWatcher (usePolling option)", { timeout: 15000 }, () => {
  let root: string;
  let appended: Array<Record<string, unknown>>;
  // `stop` is only assigned inside the test body — keep it optional so the
  // afterEach is safe even if the only test in this block is skipped (e.g.
  // on non-Linux platforms).
  let stop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pinchy-memwatch-nopoll-"));
    mkdirSync(join(root, "agents", "agent-1", "memory"), { recursive: true });
    writeFileSync(join(root, "agents", "agent-1", "MEMORY.md"), "initial\n", "utf8");
    appended = [];
    stop = undefined;
  });

  afterEach(async () => {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  });

  // Skip on non-Linux: this test runs the watcher with usePolling: false,
  // which on macOS uses fsevents — fine for most cases but with known
  // reliability issues for events on freshly-created subdirectories. The
  // contract we want to pin is "the knob is honored on the platform where
  // we actually use it" (Linux CI), and that's exactly what this test does.
  // On macOS the option is still type-checked + plumbed; we just don't
  // exercise the runtime path that fsevents would flake on.
  it.skipIf(process.platform !== "linux")(
    "accepts usePolling: false and still emits events via native fs.watch",
    async () => {
      stop = await startMemoryAuditWatcher({
        root,
        lookupAgent: async (id) => (id === "agent-1" ? { id, name: "Smithers" } : null),
        appendAuditLog: async (entry) => {
          appended.push(entry as Record<string, unknown>);
        },
        recordAuditFailure: vi.fn(),
        usePolling: false,
      });

      writeFileSync(join(root, "agents", "agent-1", "MEMORY.md"), "initial\ndelta\n", "utf8");
      await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 5000 });
      expect(appended[0]).toMatchObject({
        eventType: "agent.memory_changed",
        resource: "agent:agent-1",
        detail: { file: "MEMORY.md", addedLines: 1, removedLines: 0 },
      });
    }
  );
});

describe("startMemoryAuditWatcher (handler error resilience)", { timeout: 15000 }, () => {
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
