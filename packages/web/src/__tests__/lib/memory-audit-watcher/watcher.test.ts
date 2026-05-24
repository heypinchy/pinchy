import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMemoryAuditWatcher } from "@/lib/memory-audit-watcher";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mockable chokidar handle. The "(chokidar wiring)" block below mocks
// chokidar to drive events deterministically — the alternative (real
// chokidar against a real tmpdir) is flaky under vitest's parallel load on
// macOS, and what we want to test here is the WIRING (Pinchy reacts to
// each event type correctly), not OS-level event delivery.
//
// End-to-end real-chokidar coverage lives in the sibling file
// `watcher-real-fs.test.ts`. That file is gated to Linux (inotify is
// kernel-delivered and immune to JS event-loop pressure) so it doesn't
// re-introduce the macOS flake.
type FakeListener = (...args: unknown[]) => void;
class FakeChokidarWatcher {
  private listeners = new Map<string, FakeListener[]>();
  on(event: string, listener: FakeListener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }
  async close(): Promise<void> {}
}

// Records the last FakeChokidarWatcher returned by `chokidar.watch(...)`
// so tests can drive events directly. Reset per test via `setupMockState`.
let lastFakeWatcher: FakeChokidarWatcher | null = null;
// When true (default), the mock walks the watched path on startup and emits
// "add" for every existing file before "ready" — matching chokidar's real
// initial-scan semantics, which the watcher relies on to seed snapshots.
// Individual tests can set this false to drive the scan→ready transition
// manually (see the "scanning" branch test).
//
// NOTE: module-level mutable state. Every `beforeEach` MUST call
// `setupMockState()` so a previous test's override doesn't leak into the
// next test's setup and produce deceptive failures.
let mockInitialScan = true;

/**
 * Reset every piece of module-level mock state. Call this at the top of
 * EVERY `beforeEach` in this file so the reset is structural, not a
 * per-block convention that's easy to forget when adding a new describe.
 */
function setupMockState(): void {
  lastFakeWatcher = null;
  mockInitialScan = true;
}

function walkAndEmitAdds(w: FakeChokidarWatcher, dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const s = statSync(full);
      if (s.isDirectory()) walkAndEmitAdds(w, full);
      else w.emit("add", full);
    } catch {
      // Race or permission error during scan — chokidar would just skip and
      // continue.
    }
  }
}

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn((watchPath: string) => {
      const w = new FakeChokidarWatcher();
      lastFakeWatcher = w;
      // Defer to next microtask so the watcher's .on(...) listeners are
      // attached before events fire.
      queueMicrotask(() => {
        if (mockInitialScan) {
          walkAndEmitAdds(w, watchPath);
        }
        w.emit("ready");
      });
      return w;
    }),
  },
}));

describe("startMemoryAuditWatcher (chokidar wiring)", () => {
  let root: string;
  let appended: Array<Record<string, unknown>>;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    // Real tmpdir + real files: the watcher's handler reads file content
    // via `readFile(absolutePath, "utf8")`, so the file must exist on disk
    // for that read to succeed. We only mock chokidar's event source.
    setupMockState();
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
    if (!lastFakeWatcher) throw new Error("chokidar mock did not register a watcher");
    // The mock's initial-scan emits "add" events synchronously before
    // "ready", but the watcher's listeners detach the readFile +
    // handleMemoryFileEvent work with .catch(). Wait one tick so those
    // detached chains finish populating the snapshot map before tests
    // start firing "change" / "unlink" events that diff against it.
    await wait(20);
  });

  afterEach(async () => {
    await stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("captures readyState='scanning' for events that fire before 'ready'", async () => {
    // chokidar's real initial-scan emits "add" for every existing file
    // BEFORE "ready". Pinchy must NOT audit those (otherwise restart would
    // generate a flood of fake audits for every pre-existing memory file).
    // The default mock setup just verified above: beforeEach wrote a file
    // on disk, the mock's initial scan emitted "add" for it, and yet
    // `appended` stays empty.
    expect(appended).toHaveLength(0);
  });

  it("routes a 'change' event into an audit-log append", async () => {
    writeFileSync(join(root, "agents", "agent-1", "MEMORY.md"), "initial\nadded line\n", "utf8");
    lastFakeWatcher!.emit("change", join(root, "agents", "agent-1", "MEMORY.md"));
    await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 2000 });
    expect(appended[0]).toMatchObject({
      eventType: "agent.memory_changed",
      resource: "agent:agent-1",
      detail: { file: "MEMORY.md", addedLines: 1, removedLines: 0 },
    });
  });

  it("routes an 'add' event (post-ready) into an audit-log append", async () => {
    writeFileSync(
      join(root, "agents", "agent-1", "memory", "facts.md"),
      "fact 1\nfact 2\n",
      "utf8"
    );
    lastFakeWatcher!.emit("add", join(root, "agents", "agent-1", "memory", "facts.md"));
    await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 2000 });
    expect(appended[0]).toMatchObject({
      detail: { file: "memory/facts.md", addedLines: 2, removedLines: 0 },
    });
  });

  it("routes an 'unlink' event into a deletion audit-log append", async () => {
    // Seed a known-good snapshot first by firing an "add" with content on disk.
    const target = join(root, "agents", "agent-1", "memory", "fact.md");
    writeFileSync(target, "x\ny\n", "utf8");
    lastFakeWatcher!.emit("add", target);
    await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 2000 });
    appended.length = 0;

    // Now delete and fire unlink — the watcher should emit a deletion audit
    // using the snapshot it captured on add.
    rmSync(target);
    lastFakeWatcher!.emit("unlink", target);
    await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 2000 });
    expect(appended[0]).toMatchObject({
      detail: { file: "memory/fact.md", removedLines: 2, byteSize: 0 },
    });
  });
});

// The `usePolling` knob exists because production runs the watcher against
// a Docker bind-mounted directory where native fs.watch is unreliable, while
// some callers (tests, future non-bind-mount deployments) may want native
// event delivery. We need to know the option is plumbed through; whether
// chokidar's native vs polling path actually behaves correctly is chokidar's
// own contract, not Pinchy's to assert.
describe("startMemoryAuditWatcher (usePolling option)", () => {
  it("passes usePolling: false through to chokidar.watch", async () => {
    const chokidar = (await import("chokidar")).default;
    (chokidar.watch as ReturnType<typeof vi.fn>).mockClear();

    const root = mkdtempSync(join(tmpdir(), "pinchy-memwatch-poll-"));
    mkdirSync(join(root, "agents"), { recursive: true });
    try {
      const stop = await startMemoryAuditWatcher({
        root,
        lookupAgent: async () => null,
        appendAuditLog: async () => {},
        recordAuditFailure: vi.fn(),
        usePolling: false,
      });
      expect(chokidar.watch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ usePolling: false })
      );
      await stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults to usePolling: true when the caller omits it (production cadence)", async () => {
    const chokidar = (await import("chokidar")).default;
    (chokidar.watch as ReturnType<typeof vi.fn>).mockClear();

    const root = mkdtempSync(join(tmpdir(), "pinchy-memwatch-poll-default-"));
    mkdirSync(join(root, "agents"), { recursive: true });
    try {
      const stop = await startMemoryAuditWatcher({
        root,
        lookupAgent: async () => null,
        appendAuditLog: async () => {},
        recordAuditFailure: vi.fn(),
      });
      expect(chokidar.watch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ usePolling: true })
      );
      await stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("startMemoryAuditWatcher (handler error resilience)", () => {
  // Verifies that lookupAgent throwing inside the void-detached handler
  // chain does NOT raise unhandledRejection — the watcher's .catch wrapper
  // must swallow it and keep the watcher alive.
  let root: string;
  let appended: Array<Record<string, unknown>>;
  let stop: () => Promise<void>;
  let unhandled: unknown[];
  let unhandledHandler: (reason: unknown) => void;
  let lookupShouldThrow: boolean;

  beforeEach(async () => {
    setupMockState();
    root = mkdtempSync(join(tmpdir(), "pinchy-memwatch-err-"));
    mkdirSync(join(root, "agents", "agent-1", "memory"), { recursive: true });
    writeFileSync(join(root, "agents", "agent-1", "MEMORY.md"), "first write\n", "utf8");
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
    });
    if (!lastFakeWatcher) throw new Error("chokidar mock did not register a watcher");
  });

  afterEach(async () => {
    process.off("unhandledRejection", unhandledHandler);
    await stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not raise unhandledRejection when lookupAgent throws, and recovers on next event", async () => {
    // Fire a change event while lookup throws — the void-detached handler
    // would surface an unhandledRejection without the watcher's catch
    // wrapper.
    lastFakeWatcher!.emit("change", join(root, "agents", "agent-1", "MEMORY.md"));
    // Yield enough microtasks for the async chain (readFile, lookupAgent,
    // .catch) to settle.
    await wait(50);
    expect(unhandled).toEqual([]);
    expect(appended).toHaveLength(0); // lookup threw, no audit emitted

    // Watcher must still be alive: fix lookup, fire another event, expect
    // the audit to come through this time.
    lookupShouldThrow = false;
    writeFileSync(
      join(root, "agents", "agent-1", "MEMORY.md"),
      "first write\nsecond write\n",
      "utf8"
    );
    lastFakeWatcher!.emit("change", join(root, "agents", "agent-1", "MEMORY.md"));
    await vi.waitFor(() => expect(appended.length).toBe(1), { timeout: 2000 });
    expect(unhandled).toEqual([]);
  });
});
