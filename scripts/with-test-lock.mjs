#!/usr/bin/env node
/**
 * Runs the command passed as arguments while holding a machine-wide lock, so
 * that only one full vitest suite runs at a time across all worktrees.
 *
 * See lib/test-lock.mjs for the measurements that motivate this and for the
 * decision logic. This file is the part that touches the world: the lock
 * directory, the child process, and the signal handling.
 *
 * The lock is one FILE, created exclusively (`wx`): that fails when the path
 * exists, which gives us test-and-set in one syscall, and — because the file's
 * existence and its contents arrive together — leaves no moment where a lock
 * exists but names nobody. See tryAcquire for why that second property is not a
 * detail: it is the difference between a waiter recognising a live holder and a
 * waiter clearing it. The enclosing directory is a container and decides nothing.
 *
 * FAIL OPEN, and never spin. Every failure path here ends with the command
 * running — an unwritable /tmp, a lock we cannot read, a lock nobody owns, a
 * wait that ran too long. The command's own exit code is the only thing that
 * decides whether this script succeeds.
 */

import { spawn, execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  linkSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  formatLockRecord,
  parseLockRecord,
  decideLockAction,
  shouldBypassLock,
  MAX_WAIT_MS,
} from "./lib/test-lock.mjs";

// Deliberately a fixed absolute path rather than os.tmpdir(): the whole point is
// that sessions in different worktrees — which have different scratch dirs and
// may have different TMPDIRs — contend for the SAME lock. The override exists so
// this script's own tests can contend over a throwaway path instead of queueing
// behind (or worse, stealing from) a real suite running on the same machine.
const LOCK_DIR =
  process.env.PINCHY_TEST_LOCK_DIR || "/tmp/pinchy-full-test-suite.lock.d";
const OWNER_FILE = "owner";
const OWNER_PATH = join(LOCK_DIR, OWNER_FILE);
const POLL_MS = 2_000;
/** Backoff for a lock that was free but lost to another create — not a wait. */
const RETRY_MS = 50;
/** Takeover attempts a single generation may resist before we give up on it. */
const MAX_CONTESTED = 200;

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

/**
 * The owner file as both raw bytes and a parsed record. `raw: null` means there
 * is no owner file, which — see tryAcquire — means the lock is free.
 *
 * The raw bytes are not decoration: they are the identity a takeover checks
 * against, so that clearing a lock we judged stale cannot clear a DIFFERENT
 * lock that appeared in the meantime.
 */
function readOwner() {
  try {
    const raw = readFileSync(OWNER_PATH, "utf8");
    return { raw, record: parseLockRecord(raw) };
  } catch {
    return { raw: null, record: null };
  }
}

/** The exact owner bytes we wrote, or null while we hold nothing. */
let heldRecord = null;

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

/**
 * @returns {boolean} true when we now hold the lock.
 *
 * THE OWNER FILE IS THE MUTEX, not the directory. `wx` is an exclusive create:
 * it fails if the path exists, so the file's existence and its contents become
 * visible in the same atomic step, and there is no moment where a lock exists
 * and names nobody.
 *
 * Making the DIRECTORY the mutex — mkdir, then write the owner — reads like the
 * same thing and is not, because those are two steps. A waiter landing between
 * them finds a lock with no owner, which is indistinguishable from the genuinely
 * broken lock a killed session leaves behind, so it clears a perfectly live one
 * and both suites run. Measured: 3 of 8 concurrent pairs overlapped that way.
 */
function tryAcquire(label) {
  const record = formatLockRecord({
    pid: process.pid,
    startedAtMs: Date.now(),
    label,
  });
  try {
    // The directory is a container, and creating it must therefore be tolerant
    // of already existing — it decides nothing.
    //
    // Owner-only modes because this lives at a FIXED path in a world-writable
    // /tmp: without them any local user can read the lock, take it over, or park
    // a permanent one there, and this process would obey it (CodeQL
    // js/insecure-temporary-file). The mode is what makes a predictable name
    // safe — and a predictable name is the point, since worktrees have to find
    // the SAME lock. mkdtemp would be the usual answer to this rule and is
    // exactly wrong here.
    //
    // Trade-off, stated because it is a real one: two DIFFERENT users on one
    // machine no longer serialize against each other — the second gets EACCES
    // and falls through to fail-open. That is the behaviour before this lock
    // existed, it needs a genuinely shared machine to matter, and it is the
    // better half of the deal against a lock any local account can seize.
    mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(OWNER_PATH, record, { flag: "wx", mode: 0o600 });
  } catch (err) {
    // EEXIST: somebody holds it. ENOENT: the holder removed the directory from
    // under us as it released — both mean "try again", not "give up".
    if (err.code === "EEXIST" || err.code === "ENOENT") return false;
    throw err; // unwritable /tmp and friends — the caller falls through to fail-open
  }
  // Remembered rather than re-read at exit: release must be able to ask "is the
  // owner file still the one I wrote?", and only the exact bytes answer that.
  heldRecord = record;
  return true;
}

/** Names a generation of the owner file by its exact bytes. */
function fingerprint(raw) {
  return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

/**
 * Removes the owner file — but only while it still holds EXACTLY `judgedRaw`.
 *
 * @returns {"removed"|"contested"|"blocked"}
 *
 * This is the one operation the whole mechanism turns on, and the reason it has
 * to be built this carefully rather than as read-then-remove.
 *
 * Two sessions queued behind ONE dead holder is the ordinary case, not an edge
 * case: a killed session leaves a lock and everybody waiting sees the same one.
 * Deciding on a file and then acting on it reads like one operation and is two,
 * with the whole world free to move in between — so both removed the dead owner,
 * both created their own, and both ran. That is the pile-up this mechanism
 * exists to prevent, arriving through its own recovery path. Measured before
 * this change: 2 of 20 rounds overlapped with two sessions, and CI failed the
 * probe outright.
 *
 * The fix is that the tombstone name is derived from the bytes, and `link`
 * REFUSES a name that exists. So of all the sessions judging one generation
 * exactly one gets to the removal, and it re-reads the bytes through its own
 * link — a question about a private name rather than a guess about a shared one.
 *
 * `link`+read+remove rather than a plain rename, because renaming a FILE
 * overwrites its target without complaint: it would move whatever happens to sit
 * at the owner path at that instant, including a live successor's record, and
 * putting that back leaves the path empty in the meantime — which is exactly the
 * window a third session acquires in. Measured: that variant still overlapped 3
 * of 15 rounds with four sessions. Directory renames report ENOTEMPTY and files
 * do not; `link` is the primitive that says no.
 *
 * Removing is still never what GRANTS the lock — the `wx` create in tryAcquire
 * is, it stays the only such place, and only one caller can win it.
 */
function removeOwnerIf(judgedRaw) {
  const tomb = `${OWNER_PATH}.gen.${fingerprint(judgedRaw)}`;
  try {
    linkSync(OWNER_PATH, tomb);
  } catch {
    // ENOENT: already gone. EEXIST: another session holds this same generation
    // and is removing it. Both mean "look again", never "give up".
    return "contested";
  }
  try {
    // The bytes as they were at the instant we linked them, whatever the shared
    // path says now. Anything else means the lock moved on without us.
    if (readFileSync(tomb, "utf8") !== judgedRaw) return "contested";
    rmSync(OWNER_PATH, { force: true });
    return "removed";
  } catch {
    return "blocked";
  } finally {
    try {
      rmSync(tomb, { force: true });
    } catch {
      // An orphaned tombstone only blocks its own generation, and the loop in
      // acquire() bounds how long it may do so.
    }
  }
}

/**
 * Gives up the lock — but only if it is still OURS.
 *
 * A run that outlives the age limit gets taken over while it is still going, and
 * a blind `rm -rf` on the way out then deletes the successor's lock: a third
 * session acquires immediately while two suites are already running, and every
 * later release repeats it. The serialization degrades permanently and nothing
 * about it looks broken, which is the worst property a guard can have.
 *
 * Same conditional removal as a takeover, with our own record as the condition —
 * so a lock that is no longer ours survives our exit untouched.
 */
function release() {
  if (heldRecord === null) return;
  if (removeOwnerIf(heldRecord) !== "removed") return;
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
  let contested = 0;

  for (;;) {
    try {
      if (tryAcquire(label)) return true;
    } catch (err) {
      console.error(
        `ℹ test lock: cannot use ${LOCK_DIR} (${err.message}) — running unserialized`,
      );
      return false;
    }

    const { raw, record } = readOwner();
    const waitedMs = Date.now() - startedWaitingAt;
    const { action, reason } = decideLockAction({
      // The owner file IS the lock, so its absence means free — and "free" here
      // means the holder released between our create and this read, not that we
      // may skip the create. `record === null` with the file present is the
      // separate, genuinely broken case, and it must be cleared rather than
      // reported free: we only got here because our own create already lost, so
      // calling it free sends us back into a create that loses again, forever.
      lockExists: raw !== null,
      record,
      now: Date.now(),
      isAlive,
      waitedMs,
    });

    if (action === "steal") {
      const outcome = removeOwnerIf(raw);
      if (outcome === "blocked") {
        console.error(
          `ℹ test lock: cannot clear ${OWNER_PATH} — running unserialized`,
        );
        return false;
      }
      if (outcome === "removed") {
        console.error(`ℹ test lock: clearing a stale lock — ${reason}`);
        continue;
      }
      // "contested": somebody else is clearing this same generation, or it
      // changed under us. Look again — but bounded, because a takeover is the
      // one action decideLockAction ranks ABOVE the wait limit, so a generation
      // that stays contested (a tombstone orphaned by a session killed mid-
      // takeover) would otherwise spin here forever at full tilt.
      if (++contested > MAX_CONTESTED) {
        console.error(
          `⚠ test lock: a stale lock resisted ${MAX_CONTESTED} takeover attempts — running anyway rather than blocking`,
        );
        return false;
      }
      await sleep(RETRY_MS);
      continue;
    }
    contested = 0;
    if (action === "proceed") {
      console.error(`⚠ test lock: ${reason}`);
      return false;
    }
    if (action === "acquire") {
      // Freed under us: retry at once rather than sleeping out a poll interval.
      // Bounded all the same — an immediate retry that never progresses is the
      // one remaining way this loop could fail to run the suite at all, which
      // the fail-open rule does not permit.
      if (waitedMs > MAX_WAIT_MS) {
        console.error(
          `⚠ test lock: could not take a free lock in ${Math.round(
            MAX_WAIT_MS / 60000,
          )} minutes — running anyway rather than blocking`,
        );
        return false;
      }
      await sleep(RETRY_MS);
      continue;
    }

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
// The exit code is 128 + the signal number, as a shell-killed process reports:
// answering 130 to a SIGTERM would tell a caller it was interrupted.
for (const [signal, code] of Object.entries({
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
})) {
  process.on(signal, () => {
    child.kill(signal);
    releaseOnce();
    process.exit(code);
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
