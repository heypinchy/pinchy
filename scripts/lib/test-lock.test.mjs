import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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
  POLL_MS,
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

  /**
   * Every scratch directory this suite makes, removed when it finishes.
   *
   * Each probe used to leak the mkdtemp PARENT of its lock: the cleanups all
   * name the `lock.d` inside it and nothing removed the directory holding that.
   * Measured before this hook existed — 1089 empty `pinchy-lock-probe-*`
   * directories, the oldest twelve days old, in a temp dir macOS sweeps only on
   * reboot. Registering at CREATION is what keeps this true for the next probe;
   * a list of paths to clean at the bottom is the thing that drifts.
   */
  const scratchDirs = [];
  after(() => {
    for (const dir of scratchDirs)
      rmSync(dir, { recursive: true, force: true });
  });

  function freshScratchDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  function freshLockPath() {
    return join(freshScratchDir("pinchy-lock-probe-"), "lock.d");
  }

  /** Must match OWNER_FILE in with-test-lock.mjs — these probes seed it directly. */
  const OWNER = "owner";

  /**
   * Writes the owner file a live holder would have written.
   *
   * One place, because the alternative was four hand-rolled copies of it and two
   * had already drifted to a literal "owner" instead of the constant above — so
   * renaming OWNER_FILE would have broken those two silently while the constant
   * that exists to prevent exactly that stayed correct. The modes mirror
   * tryAcquire's: a probe should seed the lock the wrapper actually makes.
   */
  function seedOwner(lock, { pid, label }) {
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(lock, OWNER),
      formatLockRecord({ pid, startedAtMs: Date.now(), label }),
      { mode: 0o600 },
    );
  }

  /**
   * Every probe that could regress into a WAIT needs a bound. node:test has no
   * default timeout, so a reintroduced hang would stall the whole scripts gate
   * instead of failing it — and a gate that hangs gets killed and rerun rather
   * than read. Generous enough for a loaded machine, far below any real queue.
   */
  const PROBE = { timeout: 60_000 };

  /**
   * How long a probe may wait on the wrapper itself before killing it.
   *
   * A regression that stops announcing would otherwise queue for MAX_WAIT_MS —
   * twenty minutes of a leaked process, because node:test fails a test at PROBE's
   * timeout but does not kill what that test spawned — and the probe would fail
   * by timing out rather than by naming what went wrong.
   *
   * A MULTIPLE of the poll interval, because that is the real constraint: the
   * healthy path is announce, sleep one poll, acquire, run, exit, so any bound
   * below POLL_MS would kill a passing run mid-sleep. The factor is slack for a
   * node boot on a loaded runner — generous on purpose, since firing early is a
   * false red while firing late costs seconds we only pay when it is red.
   */
  const GIVE_UP_MS = POLL_MS * 10;

  /**
   * That bound is only a BETTER failure than the runner timeout while it fires
   * FIRST, and its two numbers now live in different files. Raise POLL_MS to 10s
   * — a plausible edit for a lock nobody wants polling hard — and the bound lands
   * at 100s against a 60s timeout: node:test kills the test first, and there is
   * no message, no signal, and the leaked wrapper back again, with the guard
   * still in place and still looking intact.
   */
  test("the give-up bound fires before the runner's own timeout", () => {
    assert.ok(
      GIVE_UP_MS < PROBE.timeout,
      `a ${GIVE_UP_MS}ms give-up bound is useless against a ${PROBE.timeout}ms test timeout`,
    );
  });

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

  /**
   * The lock sits at a FIXED path in a world-writable /tmp, because worktrees
   * have to find the same one — so the modes are what keep a predictable name
   * from being an invitation. Without them any local account can read the lock,
   * take it over, or park a permanent one there and be obeyed (CodeQL
   * js/insecure-temporary-file). `mode:` is one word to drop in a refactor and
   * nothing else in this file would notice, so assert it on the real artefact
   * rather than trusting the call site.
   */
  test("creates the lock unreadable to other users", async () => {
    const lock = freshLockPath();
    const modes = [
      process.execPath,
      "-e",
      `const {statSync}=require("fs");
       const d=process.env.PINCHY_TEST_LOCK_DIR;
       console.log((statSync(d).mode & 0o777).toString(8),
                   (statSync(d+"/owner").mode & 0o777).toString(8));`,
    ];

    const { stdout } = await runWrapper(lock, modes);

    assert.equal(stdout.trim(), "700 600");
  });

  test("two runs take turns instead of overlapping", PROBE, async () => {
    const lock = freshLockPath();
    const log = join(freshScratchDir("pinchy-probe-log-"), "seq");
    writeFileSync(log, "");

    await Promise.all([
      runWrapper(lock, overlapProbe, { PROBE_LOG: log }),
      runWrapper(lock, overlapProbe, { PROBE_LOG: log }),
    ]);

    const sequence = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(sequence, ["in", "out", "in", "out"]);
  });

  /**
   * The waiter is seeded rather than raced for. Two wrappers started together
   * and one of them holding briefly LOOKS like contention and is not: whichever
   * boots first takes the lock, so the run that is supposed to wait only ever
   * waits if it arrives while the other still holds — two process spawns and two
   * node boots inside that window. Locally that is ~100ms and it passes; on a CI
   * runner also running vitest it does not, nobody waits, nothing is printed,
   * and the assertion sees the empty string. Observed on PR #1201, on a step
   * whose PR cannot reach this wrapper at all.
   *
   * Seeding an owner that is unambiguously alive — this test process — removes
   * the window: the owner file exists before the wrapper starts, so its `wx`
   * create cannot win, and which process boots first stops deciding whether
   * anything is announced at all. What stays timing-dependent is the second
   * half, and only loosely: once the lock frees, the waiter has GIVE_UP_MS to
   * notice and finish.
   *
   * It costs one real POLL_MS of wall clock (~2.3s), deliberately. The cheaper
   * shape is an env override for the poll interval — ~2s per PR, against a
   * production knob that would exist only for this test, and a probe that no
   * longer exercises the interval the wrapper actually sleeps.
   */
  test("waiting prints the test:related alternative", PROBE, async () => {
    const lock = freshLockPath();
    seedOwner(lock, { pid: process.pid, label: "the probe itself" });

    // stdout is DROPPED rather than piped: nothing here would drain it, and a
    // full stdout pipe stops `close` from ever firing. Measured — a child
    // writing 500KB to an unread pipe never closes, where the same child writing
    // 100 bytes does. `true` is silent today, but the wrapper hands its own
    // stdio to the command it runs, so a probe command's output lands here.
    const waiter = spawn(process.execPath, [WRAPPER, "true"], {
      env: { ...cleanEnv, PINCHY_TEST_LOCK_DIR: lock },
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Decoded as a stream rather than per chunk: the announcement opens with a
    // three-byte `ℹ`, and a chunk boundary inside it would put U+FFFD into the
    // one diagnostic a failing run has to offer.
    waiter.stderr.setEncoding("utf8");

    let stderr = "";
    let released = false;
    const startedAt = Date.now();
    const giveUp = setTimeout(() => waiter.kill("SIGKILL"), GIVE_UP_MS);
    let closed;
    try {
      closed = await new Promise((resolve, reject) => {
        waiter.stderr.on("data", (chunk) => {
          stderr += chunk;
          // Release the moment the hint lands, so the waiter finishes on its
          // next poll instead of sitting out the whole allowance. LATCHED: an
          // unlatched check re-fires on every later chunk, and one arriving
          // after the waiter has acquired would delete the waiter's OWN owner
          // file — which its release then declines to clean up, and which a
          // third session would be free to take while the run is still inside.
          if (!released && /test:related/.test(stderr)) {
            released = true;
            rmSync(join(lock, OWNER), { force: true });
          }
        });
        waiter.on("error", reject);
        waiter.on("close", (code, signal) => resolve({ code, signal }));
      });
    } finally {
      clearTimeout(giveUp);
      rmSync(lock, { recursive: true, force: true });
    }

    assert.match(stderr, /test:related/);
    // Asserted apart from the exit code, because `close` reports a killed
    // process as code null — so asserting on the code alone says `null !== 0`,
    // which is the uninformative failure the give-up bound exists to replace.
    assert.equal(
      closed.signal,
      null,
      `the waiter never finished — killed at the ${GIVE_UP_MS}ms give-up bound`,
    );
    // The wait must also END when the lock frees. A hint printed by a run that
    // then never proceeds is not the behaviour this promises, and asserting only
    // on the text cannot tell the two apart.
    assert.equal(closed.code, 0);
    // Nor can it tell a real queue from a wrapper that announced and then FAILED
    // OPEN, running unserialized — the very pile-up this lock exists to prevent.
    // Both exit 0 with the hint on stderr; only the clock separates them, since
    // a genuine wait sleeps a whole poll before it looks again.
    const waited = Date.now() - startedAt;
    assert.ok(
      waited >= POLL_MS,
      `finished in ${waited}ms, less than one ${POLL_MS}ms poll — it never queued`,
    );
  });

  test("does not queue behind a lock whose owner is gone", PROBE, async () => {
    const lock = freshLockPath();
    // pid 0x7FFFFFFF is beyond any real pid on macOS/Linux, so liveness fails.
    seedOwner(lock, { pid: 2147483647, label: "a session that died" });

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
   * Sessions queued behind ONE dead holder is the ordinary case — a killed
   * session leaves a lock and every waiting session sees it. If they clear it by
   * "delete, then mkdir", both delete and both mkdir, and both then run: the
   * pile-up this whole mechanism exists to prevent, arriving through its own
   * recovery path. Taking over has to be atomic, exactly like taking the lock is.
   *
   * FOUR sessions, not two, and the count is the point. A takeover that removes
   * the owner file and puts it back if it guessed wrong leaves the path empty in
   * between — which two sessions cannot exploit (the one that guesses wrong is
   * the one that would have to acquire) and a third can, by acquiring in exactly
   * that gap. Measured on the way to fixing this: the two-session probe passed
   * 40 rounds against an implementation the four-session one failed 3 of 15.
   * Real machines run more than two agent sessions, so the probe should too.
   */
  test("runs facing one dead holder still take turns", PROBE, async () => {
    const lock = freshLockPath();
    seedOwner(lock, { pid: 2147483647, label: "a session that died" });

    const log = join(freshScratchDir("pinchy-probe-log-"), "seq");
    writeFileSync(log, "");
    await Promise.all(
      Array.from({ length: 4 }, () =>
        runWrapper(lock, overlapProbe, { PROBE_LOG: log }),
      ),
    );

    // Depth rather than a literal sequence: the property is "never two inside at
    // once", and stating it that way keeps the assertion readable as the runner
    // count grows — and names the actual failure when it breaks.
    const sequence = readFileSync(log, "utf8").trim().split("\n");
    let depth = 0;
    for (const marker of sequence) {
      depth += marker === "in" ? 1 : -1;
      assert.ok(
        depth <= 1,
        `two runs were inside the lock at once: ${sequence.join(",")}`,
      );
    }
    assert.equal(sequence.length, 8, `every run must report in and out`);
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
      seedOwner(lock, { pid: process.pid, label: "this very test" });

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
