import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatLockRecord,
  parseLockRecord,
  decideLockAction,
  shouldBypassLock,
  MAX_LOCK_AGE_MS,
  MAX_WAIT_MS,
} from "./test-lock.mjs";

const WRAPPER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "with-test-lock.mjs",
);

const HOLDER = { pid: 4242, startedAtMs: 1_000_000, label: "issue-951" };
const alive = () => true;
const dead = () => false;

/** decideLockAction with the boring arguments already filled in. */
function decide(overrides = {}) {
  return decideLockAction({
    lockExists: true,
    record: HOLDER,
    now: HOLDER.startedAtMs + 1_000,
    isAlive: alive,
    waitedMs: 0,
    ...overrides,
  });
}

describe("the lock record — a holder must survive a round trip", () => {
  test("round-trips pid, start time and label", () => {
    const parsed = parseLockRecord(formatLockRecord(HOLDER));
    assert.deepEqual(parsed, HOLDER);
  });

  test("tolerates a trailing newline", () => {
    const parsed = parseLockRecord(`${formatLockRecord(HOLDER)}\n\n`);
    assert.deepEqual(parsed, HOLDER);
  });

  test("survives a label containing spaces and punctuation", () => {
    const holder = { ...HOLDER, label: "claude/fix-odoo m2o (rebase)" };
    assert.deepEqual(parseLockRecord(formatLockRecord(holder)), holder);
  });

  // A record we cannot read is not a reason to block someone's test run — but
  // it must not read as a VALID holder either, or a corrupt file would park
  // every session behind a lock nobody holds.
  for (const [name, input] of [
    ["null", null],
    ["a non-string", 17],
    ["empty", ""],
    ["whitespace", "   \n "],
    ["a non-numeric pid", "not-a-pid\t1000000\tlabel"],
    ["a missing start time", "4242"],
  ]) {
    test(`refuses ${name}`, () => {
      assert.equal(parseLockRecord(input), null);
    });
  }
});

describe("deciding what to do about an existing lock", () => {
  test("acquires when nothing holds it", () => {
    assert.equal(decide({ lockExists: false, record: null }).action, "acquire");
  });

  /**
   * "There is a lock, and it names nobody" is a DIFFERENT state from "there is
   * no lock", and conflating the two is a hang rather than a wrong answer: the
   * caller only asks this question after its own mkdir lost to an existing
   * directory, so answering "acquire" sends it back to a mkdir that will lose
   * again, forever, at 100% CPU. A lock nobody owns must be cleared.
   */
  test("clears a lock whose owner record is unreadable", () => {
    const { action, reason } = decide({ lockExists: true, record: null });
    assert.equal(action, "steal");
    assert.match(reason, /owner/i);
  });

  test("an unreadable lock is cleared even after a long wait", () => {
    // Same reasoning as the dead-holder case below: stealing keeps the NEXT
    // session serialized where proceeding unlocked restarts the pile-up.
    assert.equal(
      decide({ lockExists: true, record: null, waitedMs: MAX_WAIT_MS + 1 })
        .action,
      "steal",
    );
  });

  test("waits while a live holder is still inside its allowance", () => {
    assert.equal(decide().action, "wait");
  });

  test("steals from a holder whose process is gone", () => {
    // The common case by far: a session killed mid-run, or a machine that slept.
    const { action, reason } = decide({ isAlive: dead });
    assert.equal(action, "steal");
    assert.match(reason, /no longer running/i);
  });

  // PID reuse is the reason age matters at all. `kill(pid, 0)` only proves SOME
  // process owns that number, not that it is still OUR test run — so a lock that
  // outlives any plausible test run is stale regardless of what isAlive says.
  test("steals from a live pid once the lock outlives any real test run", () => {
    const { action, reason } = decide({
      now: HOLDER.startedAtMs + MAX_LOCK_AGE_MS + 1,
      isAlive: alive,
    });
    assert.equal(action, "steal");
    assert.match(reason, /older than/i);
  });

  test("keeps waiting right up to the age limit", () => {
    assert.equal(
      decide({ now: HOLDER.startedAtMs + MAX_LOCK_AGE_MS - 1 }).action,
      "wait",
    );
  });

  // Fail open, exactly like the pre-push gate: the worst outcome of this whole
  // mechanism must be a slow test run, never a test run that cannot happen.
  test("gives up waiting and proceeds unlocked rather than blocking forever", () => {
    const { action, reason } = decide({ waitedMs: MAX_WAIT_MS + 1 });
    assert.equal(action, "proceed");
    assert.match(reason, /waited/i);
  });

  test("a dead holder is stolen from even after a long wait", () => {
    // "steal" beats "proceed": taking the lock keeps the NEXT session serialized,
    // where proceeding unlocked would let the pile-up resume.
    assert.equal(
      decide({ isAlive: dead, waitedMs: MAX_WAIT_MS + 1 }).action,
      "steal",
    );
  });

  test("a clock that jumped backwards does not read as an ancient lock", () => {
    // Age is a duration, and a negative one is not "very old".
    assert.equal(decide({ now: HOLDER.startedAtMs - 60_000 }).action, "wait");
  });
});

describe("bypass — the lock must not deadlock against itself", () => {
  test("bypasses when the environment says we already hold it", () => {
    assert.equal(shouldBypassLock({ PINCHY_TEST_LOCK_HELD: "1" }), true);
  });

  test("does not bypass on an unrelated environment", () => {
    assert.equal(shouldBypassLock({}), false);
    assert.equal(shouldBypassLock({ PINCHY_TEST_LOCK_HELD: "" }), false);
  });

  // CI runs one job per runner: there is nothing to serialize against, and a
  // stale lock in a container image must never cost a CI minute.
  test("bypasses in CI", () => {
    assert.equal(shouldBypassLock({ CI: "true" }), true);
  });
});

/**
 * The wiring tests above are the cheap half. These run the real wrapper as a
 * real process, because the properties that matter — a red suite staying red,
 * two runs actually taking turns — live in the parts no unit test reaches.
 *
 * Each probe gets its own throwaway lock path via PINCHY_TEST_LOCK_DIR, so the
 * suite never contends with a genuine `pnpm test` on the same machine. CI is
 * stripped from the environment on purpose: with it set the wrapper bypasses
 * the lock entirely, and every serialization assertion below would pass by
 * doing nothing.
 */
describe("the wrapper, run for real", () => {
  const { CI, PINCHY_TEST_LOCK_HELD, ...cleanEnv } = process.env;

  function runWrapper(lockDir, args, extraEnv = {}) {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [WRAPPER, ...args],
        { env: { ...cleanEnv, PINCHY_TEST_LOCK_DIR: lockDir, ...extraEnv } },
        (err, stdout, stderr) =>
          resolve({ code: err?.code ?? 0, stdout, stderr }),
      );
    });
  }

  function freshLockPath() {
    return join(mkdtempSync(join(tmpdir(), "pinchy-lock-probe-")), "lock.d");
  }

  /** Must match OWNER_FILE in with-test-lock.mjs — these probes seed it directly. */
  const OWNER = "owner";

  /**
   * Every probe that could regress into a WAIT needs a bound. node:test has no
   * default timeout, so a reintroduced hang would stall the whole scripts gate
   * instead of failing it — and a gate that hangs gets killed and rerun rather
   * than read. Generous enough for a loaded machine, far below any real queue.
   */
  const PROBE = { timeout: 60_000 };

  /**
   * Appends a marker on entry and on exit. Two of these under a working lock
   * read in+out+in+out; overlapping runs interleave to in+in+out+out.
   */
  const overlapProbe = [
    process.execPath,
    "-e",
    `const {appendFileSync}=require("fs");
     appendFileSync(process.env.PROBE_LOG,"in\\n");
     setTimeout(()=>{appendFileSync(process.env.PROBE_LOG,"out\\n")},700);`,
  ];

  test("passes a successful command's exit code through", async () => {
    const { code } = await runWrapper(freshLockPath(), ["true"]);
    assert.equal(code, 0);
  });

  // The single most important property here. A lock that swallowed a failure
  // would turn every red suite green and be worse than no lock at all.
  test("a failing command still fails", async () => {
    const { code } = await runWrapper(freshLockPath(), [
      process.execPath,
      "-e",
      "process.exit(17)",
    ]);
    assert.equal(code, 17);
  });

  test("releases the lock when the command finishes", async () => {
    const lock = freshLockPath();
    await runWrapper(lock, ["true"]);
    assert.equal(existsSync(lock), false);
  });

  test("two runs take turns instead of overlapping", PROBE, async () => {
    const lock = freshLockPath();
    const log = join(mkdtempSync(join(tmpdir(), "pinchy-probe-log-")), "seq");
    writeFileSync(log, "");

    await Promise.all([
      runWrapper(lock, overlapProbe, { PROBE_LOG: log }),
      runWrapper(lock, overlapProbe, { PROBE_LOG: log }),
    ]);

    const sequence = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(sequence, ["in", "out", "in", "out"]);
  });

  test("waiting prints the test:related alternative", PROBE, async () => {
    const lock = freshLockPath();
    const slow = [process.execPath, "-e", "setTimeout(()=>{},600)"];
    const both = await Promise.all([
      runWrapper(lock, slow),
      runWrapper(lock, ["true"]),
    ]);
    // Which of the two wins the mkdir is a race, so assert on the pair: exactly
    // one of them waited, and whichever it was must have been told what to do
    // with the wait instead of just being told to sit still.
    assert.match(both.map((r) => r.stderr).join(""), /test:related/);
  });

  test("does not queue behind a lock whose owner is gone", PROBE, async () => {
    const lock = freshLockPath();
    mkdirSync(lock, { recursive: true });
    // pid 0x7FFFFFFF is beyond any real pid on macOS/Linux, so liveness fails.
    writeFileSync(
      join(lock, "owner"),
      formatLockRecord({
        pid: 2147483647,
        startedAtMs: Date.now(),
        label: "a session that died",
      }),
    );

    const started = Date.now();
    const { code, stderr } = await runWrapper(lock, ["true"]);
    assert.equal(code, 0);
    assert.match(stderr, /stale/i);
    assert.ok(
      Date.now() - started < 10_000,
      "should have cleared the stale lock immediately, not waited it out",
    );
    rmSync(lock, { recursive: true, force: true });
  });

  /**
   * A lock directory with no usable owner inside it is the most likely broken
   * state there is: mkdir and the owner write are two syscalls, and a session
   * killed between them (or a truncated write) leaves exactly this. It must be
   * cleared, not waited on — and above all not spun on, which is what a
   * decision layer that reads "no owner" as "free" produces, because the caller
   * is only asking after its own mkdir already lost.
   */
  for (const [name, seed] of [
    ["no owner file at all", () => {}],
    [
      "a corrupt owner file",
      (lock) => writeFileSync(join(lock, OWNER), "??\n"),
    ],
    ["an empty owner file", (lock) => writeFileSync(join(lock, OWNER), "")],
  ]) {
    // An explicit timeout, because the regression this guards against is a
    // HANG: node:test waits forever by default, so without it a reintroduced
    // spin would stall `pnpm test:scripts` rather than fail it.
    test(`runs promptly against a lock with ${name}`, PROBE, async () => {
      const lock = freshLockPath();
      mkdirSync(lock, { recursive: true });
      seed(lock);

      const started = Date.now();
      const { code } = await runWrapper(lock, ["true"]);
      assert.equal(code, 0);
      assert.ok(
        Date.now() - started < 10_000,
        "should have cleared the unowned lock immediately",
      );
      rmSync(lock, { recursive: true, force: true });
    });
  }

  /**
   * Two sessions queued behind ONE dead holder is the ordinary case — a killed
   * session leaves a lock and every waiting session sees it. If they clear it by
   * "delete, then mkdir", both delete and both mkdir, and both then run: the
   * pile-up this whole mechanism exists to prevent, arriving through its own
   * recovery path. Taking over has to be atomic, exactly like taking the lock is.
   */
  test("two runs facing one dead holder still take turns", PROBE, async () => {
    const lock = freshLockPath();
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, OWNER),
      formatLockRecord({
        pid: 2147483647,
        startedAtMs: Date.now(),
        label: "a session that died",
      }),
    );

    const log = join(mkdtempSync(join(tmpdir(), "pinchy-probe-log-")), "seq");
    writeFileSync(log, "");
    await Promise.all([
      runWrapper(lock, overlapProbe, { PROBE_LOG: log }),
      runWrapper(lock, overlapProbe, { PROBE_LOG: log }),
    ]);

    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "in",
      "out",
      "in",
      "out",
    ]);
    rmSync(lock, { recursive: true, force: true });
  });

  /**
   * The mirror image of the race above: once another run holds the lock, our
   * release must not delete it. A blind `rm -rf` on the way out hands the next
   * session a free lock while the current holder is still running, and every
   * later release does the same — the serialization degrades permanently, and
   * nothing about it looks broken.
   */
  test(
    "does not release a lock that another run has taken over",
    PROBE,
    async () => {
      const lock = freshLockPath();
      const hijack = [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(process.env.OWNER_PATH,
         "999999\\t" + Date.now() + "\\tanother session\\n")`,
      ];

      const { code } = await runWrapper(lock, hijack, {
        OWNER_PATH: join(lock, OWNER),
      });

      assert.equal(code, 0);
      assert.equal(
        existsSync(lock),
        true,
        "the successor's lock must survive our release",
      );
      rmSync(lock, { recursive: true, force: true });
    },
  );

  test(
    "bypasses the lock when the parent already holds it",
    PROBE,
    async () => {
      const lock = freshLockPath();
      mkdirSync(lock, { recursive: true });
      writeFileSync(
        join(lock, "owner"),
        formatLockRecord({
          pid: process.pid,
          startedAtMs: Date.now(),
          label: "this very test",
        }),
      );

      // A live holder — without the bypass this call would queue for 20 minutes.
      const started = Date.now();
      const { code } = await runWrapper(lock, ["true"], {
        PINCHY_TEST_LOCK_HELD: "1",
      });
      assert.equal(code, 0);
      assert.ok(Date.now() - started < 10_000, "should not have queued at all");
      rmSync(lock, { recursive: true, force: true });
    },
  );
});
