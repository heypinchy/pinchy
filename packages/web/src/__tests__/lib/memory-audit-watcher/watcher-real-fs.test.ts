// Linux-only end-to-end smoke for `startMemoryAuditWatcher`.
//
// The sibling file `watcher.test.ts` mocks chokidar entirely so the assertions
// stay deterministic under vitest's parallel-test load (fsevents on macOS was
// the 33% flake source — see f3051365f). That refactor protected against the
// flake but opened a coverage gap: nothing in the test suite exercised real
// chokidar → real fs → audit-emit end-to-end anymore.
//
// This file closes that gap on Linux. CI is Linux and uses inotify, which is
// delivered from the kernel and is immune to JS event-loop starvation; the
// original flake was specifically a macOS-fsevents-under-load problem. macOS
// keeps using the mocked suite because we can't afford to re-introduce the
// dev-loop flake.
//
// IMPORTANT: this file deliberately does NOT call `vi.mock("chokidar", ...)`.
// `vi.mock` is file-scoped, so the watcher.test.ts mock does not bleed into
// this file. Both files run under the same vitest pool but with separate
// module graphs per-file.
//
// Tracks #433.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMemoryAuditWatcher } from "@/lib/memory-audit-watcher";

// `describe.skipIf(condition)` is one of the two patterns the
// "no untracked test skips" guard explicitly allows (conditional gates
// driven by OS / env), so no `#NNN` issue link is required here. See
// AGENTS.md § "No Untracked Test Skips".
describe.skipIf(process.platform !== "linux")(
  "startMemoryAuditWatcher (real fs, Linux smoke)",
  { timeout: 15000 },
  () => {
    let root: string;
    let appended: Array<Record<string, unknown>>;
    let stop: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      // Start the watcher BEFORE creating MEMORY.md. Earlier versions
      // pre-created the file and then modified it in the test body, but
      // that races: chokidar's initial-scan "add" event captures
      // readyState="scanning" synchronously, then runs `await readFile()`
      // asynchronously. If the test body's modification lands before
      // the detached readFile completes, the snapshot ends up storing
      // the NEW content — making the subsequent diff degenerate to
      // addedLines=0. Run 26291361464 hit exactly that on Linux.
      //
      // Instead: empty agents/ at startup, then create MEMORY.md after
      // the watcher is ready. The "add" event now fires in "ready"
      // state and emits an audit directly with no scan-phase snapshot
      // to race against.
      root = mkdtempSync(join(tmpdir(), "pinchy-memwatch-realfs-"));
      mkdirSync(join(root, "agents"), { recursive: true });
      appended = [];

      // `usePolling: false` → inotify on Linux. We deliberately do NOT use
      // the production polling default here: under vitest's parallel-worker
      // load the polling timer gets starved (see f3051365f and PR #403
      // history). inotify delivers from the kernel so it's load-immune.
      stop = await startMemoryAuditWatcher({
        root,
        lookupAgent: async (id) => (id === "agent-1" ? { id, name: "Smithers" } : null),
        appendAuditLog: async (entry) => {
          appended.push(entry as Record<string, unknown>);
        },
        recordAuditFailure: () => {},
        usePolling: false,
        stabilityThreshold: 100,
      });
    });

    afterEach(async () => {
      if (stop) await stop();
      rmSync(root, { recursive: true, force: true });
    });

    it("emits one agent.memory_changed when MEMORY.md is created post-ready", async () => {
      // Create the agent dir + MEMORY.md AFTER the watcher signalled ready.
      // The "add" event for the new file fires in "ready" state, so it
      // becomes a real audit emission with a clean diff: empty snapshot
      // → 2 added lines.
      mkdirSync(join(root, "agents", "agent-1"), { recursive: true });
      writeFileSync(join(root, "agents", "agent-1", "MEMORY.md"), "initial\nadded line\n", "utf8");

      // Poll for the event rather than sleeping a fixed amount — inotify is
      // usually sub-100 ms but the stability-threshold window has to elapse
      // before chokidar fires.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && appended.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(
        appended.length,
        `expected 1 audit entry within 5 s; got ${appended.length}. ` +
          `inotify is supposed to deliver immediately — if this fails on Linux ` +
          `CI, real chokidar+inotify wiring is broken and the mocked suite ` +
          `in watcher.test.ts would not catch it.`
      ).toBe(1);

      expect(appended[0]).toMatchObject({
        eventType: "agent.memory_changed",
        resource: "agent:agent-1",
        detail: { file: "MEMORY.md", addedLines: 2, removedLines: 0 },
      });
    });
  }
);
