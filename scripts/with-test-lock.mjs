#!/usr/bin/env node
/**
 * Runs the command passed as arguments while holding a machine-wide lock, so
 * that only one full vitest suite runs at a time across all worktrees.
 *
 * See lib/test-lock.mjs for the measurements that motivate this and for the
 * decision logic. This file is the part that touches the world: the lock
 * directory, the child process, and the signal handling.
 *
 * The lock is a DIRECTORY, not a file. `mkdir` is atomic on POSIX and fails when
 * the target exists, which gives us test-and-set in one syscall; the same thing
 * built from exists()-then-write() has a window where two sessions both win.
 *
 * FAIL OPEN. Every failure path here runs the command anyway — an unwritable
 * /tmp, a lock we cannot read, a wait that ran too long. The command's own exit
 * code is the only thing that decides whether this script succeeds.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  formatLockRecord,
  parseLockRecord,
  decideLockAction,
  shouldBypassLock,
} from "./lib/test-lock.mjs";

// Deliberately a fixed absolute path rather than os.tmpdir(): the whole point is
// that sessions in different worktrees — which have different scratch dirs and
// may have different TMPDIRs — contend for the SAME lock. The override exists so
// this script's own tests can contend over a throwaway path instead of queueing
// behind (or worse, stealing from) a real suite running on the same machine.
const LOCK_DIR =
  process.env.PINCHY_TEST_LOCK_DIR || "/tmp/pinchy-full-test-suite.lock.d";
const OWNER_FILE = "owner";
const POLL_MS = 2_000;

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: with-test-lock.mjs <command> [args...]");
  process.exit(2);
}

/** Which worktree is holding things up — a bare pid tells the waiter nothing. */
function currentLabel() {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch || "unknown branch";
  } catch {
    return "unknown branch";
  }
}

function readHolder() {
  try {
    return parseLockRecord(readFileSync(join(LOCK_DIR, OWNER_FILE), "utf8"));
  } catch {
    // No owner file inside an existing lock dir means a run died between mkdir
    // and the write. Reporting "nobody" lets the age/liveness rules clear it.
    return null;
  }
}

function isAlive(pid) {
  try {
    // Signal 0 performs the permission and existence checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — alive for our purpose.
    return err.code === "EPERM";
  }
}

/** @returns {boolean} true when we now hold the lock. */
function tryAcquire(label) {
  try {
    mkdirSync(LOCK_DIR);
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err; // unwritable /tmp and friends — the caller falls through to fail-open
  }
  writeFileSync(
    join(LOCK_DIR, OWNER_FILE),
    formatLockRecord({ pid: process.pid, startedAtMs: Date.now(), label }),
  );
  return true;
}

function release() {
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // A lock we cannot remove is cleared by the age rule within 20 minutes.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns {Promise<boolean>} whether we hold the lock (false = fail open, run
 *   the command unlocked)
 */
async function acquire(label) {
  const startedWaitingAt = Date.now();
  let announced = false;

  for (;;) {
    try {
      if (tryAcquire(label)) return true;
    } catch (err) {
      console.error(
        `ℹ test lock: cannot use ${LOCK_DIR} (${err.message}) — running unserialized`,
      );
      return false;
    }

    const { action, reason } = decideLockAction({
      record: readHolder(),
      now: Date.now(),
      isAlive,
      waitedMs: Date.now() - startedWaitingAt,
    });

    if (action === "steal") {
      console.error(`ℹ test lock: clearing a stale lock — ${reason}`);
      release();
      continue;
    }
    if (action === "proceed") {
      console.error(`⚠ test lock: ${reason}`);
      return false;
    }
    if (action === "acquire") continue; // it was freed between our two checks

    if (!announced) {
      announced = true;
      console.error(
        [
          `ℹ test lock: waiting — ${reason}.`,
          `  Two full suites on one machine measured 10 GB and did not finish in 10 minutes;`,
          `  serialized they cost about a minute each. Waiting is the faster path.`,
          ``,
          `  For an inner-loop check you do not need the full suite:`,
          `    pnpm test:related`,
          `  With no arguments it takes your own change set from git and runs only the`,
          `  tests that import it. It takes no lock. It is not a verification gate —`,
          `  run the full suite before you push.`,
          ``,
        ].join("\n"),
      );
    }
    await sleep(POLL_MS);
  }
}

const held = shouldBypassLock(process.env)
  ? false
  : await acquire(currentLabel());

let released = false;
function releaseOnce() {
  if (held && !released) {
    released = true;
    release();
  }
}

const child = spawn(command, args, {
  stdio: "inherit",
  // Marks the subtree as already holding the lock, so a suite that shells out to
  // another test command cannot queue behind itself forever.
  env: { ...process.env, PINCHY_TEST_LOCK_HELD: "1" },
});

// A lock that outlives its owner is exactly the stale case we then have to
// detect and clean up, so give the common exits a chance to release properly.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    child.kill(signal);
    releaseOnce();
    process.exit(130);
  });
}
process.on("exit", releaseOnce);

child.on("error", (err) => {
  console.error(`test lock: could not start ${command}: ${err.message}`);
  releaseOnce();
  process.exit(127);
});

child.on("close", (code, signal) => {
  releaseOnce();
  // Pass the suite's own verdict through untouched — a lock must never turn a
  // red suite green.
  process.exit(signal ? 128 : (code ?? 1));
});
