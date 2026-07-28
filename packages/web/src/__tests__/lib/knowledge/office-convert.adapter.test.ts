/**
 * The production adapters, driven against STUB binaries.
 *
 * office-convert.test.ts fakes the subprocess entirely and proves what the
 * module concludes; office-convert.libreoffice.test.ts drives the real
 * LibreOffice but is gated on a 422 MB package almost no machine has, so it
 * never runs in CI. That left `runSoffice` itself — the argv, the private
 * profile, what the child inherits, and what a timeout actually kills —
 * covered nowhere a pull request can see.
 *
 * A stub closes that gap: everything here is about how we SPAWN, which needs a
 * process, not LibreOffice. It runs on every PR.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runSoffice, runTextOracle } from "@/lib/knowledge/office-convert";

let tmpRoot: string;
let outDir: string;
let profileDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-adapter-test-"));
  outDir = join(tmpRoot, "out");
  profileDir = join(tmpRoot, "profile");
  process.env.KB_SOFFICE_BIN = stub("soffice-noop", "exit 0\n");
});

afterEach(() => {
  delete process.env.KB_SOFFICE_BIN;
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Writes an executable stand-in and returns its path. The script gets no
 * arguments and no environment from us on purpose: anything it needs to know
 * (like where to record what it saw) is baked into its text, so the recording
 * still works when we assert that the child's environment was stripped.
 */
function stub(name: string, body: string): string {
  const path = join(tmpRoot, name);
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

function run(overrides: Partial<Parameters<typeof runSoffice>[0]> = {}) {
  return runSoffice({ inputs: [], outDir, profileDir, timeoutMs: 10_000, ...overrides });
}

describe("runSoffice", () => {
  it("asks for a PDF, into our outdir, with a private profile", async () => {
    const record = join(tmpRoot, "argv");
    process.env.KB_SOFFICE_BIN = stub("soffice-argv", `printf '%s\\n' "$@" > ${record}\n`);

    await run({ inputs: [join(tmpRoot, "0.doc"), join(tmpRoot, "1.pptx")] });

    const argv = (await readFile(record, "utf8")).trim().split("\n");
    expect(argv).toContain("--headless");
    expect(argv).toContain("--convert-to");
    expect(argv[argv.indexOf("--convert-to") + 1]).toBe("pdf");
    expect(argv[argv.indexOf("--outdir") + 1]).toBe(outDir);
    // A private user installation, or a second converter run (a concurrent
    // reindex, a leftover process) silently reuses the first one's state.
    expect(argv).toContain(`-env:UserInstallation=file://${profileDir}`);
    // The inputs come last, in order — that is what makes `<index>.pdf` in the
    // outdir attributable back to a source.
    expect(argv.slice(-2)).toEqual([join(tmpRoot, "0.doc"), join(tmpRoot, "1.pptx")]);
  });

  it("hands the converter a minimal environment, not the server's secrets", async () => {
    // LibreOffice parses attacker-supplied legacy binary formats — a format
    // family with a long history of memory-safety bugs. It has no business
    // holding the database URL or the key that encrypts provider credentials,
    // so the child gets an allow-list rather than a copy of process.env.
    // Verified against the real binary: PATH + HOME is enough to convert, with
    // Central/Eastern European diacritics intact.
    const record = join(tmpRoot, "env");
    process.env.KB_SOFFICE_BIN = stub("soffice-env", `env > ${record}\n`);
    process.env.ENCRYPTION_KEY = "test-encryption-key";
    process.env.DATABASE_URL = "postgresql://pinchy:hunter2@db:5432/pinchy";

    try {
      await run();
    } finally {
      delete process.env.ENCRYPTION_KEY;
      delete process.env.DATABASE_URL;
    }

    const env = Object.fromEntries(
      (await readFile(record, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
    );
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PATH).toBeTruthy();
    // HOME must match the private profile: LibreOffice writes into $HOME too,
    // and pointing it anywhere else puts state outside the staging directory.
    expect(env.HOME).toBe(profileDir);
  });

  it("reports the exit code a container OOM kill produces", async () => {
    process.env.KB_SOFFICE_BIN = stub("soffice-oom", "exit 137\n");

    expect(await run()).toMatchObject({ code: 137 });
  });

  it("keeps only a bounded amount of the converter's stderr", async () => {
    // LibreOffice repeats itself per file; a large batch must not build a
    // multi-megabyte string inside the web process.
    process.env.KB_SOFFICE_BIN = stub(
      "soffice-loud",
      "i=0; while [ $i -lt 400 ]; do i=$((i+1)); " +
        'printf "Error: source file could not be loaded padding padding padding padding\\n" >&2; ' +
        "done\n"
    );

    const result = await run();

    expect(result.stderr.length).toBeLessThan(64 * 1024);
    expect(result.stderr).toContain("could not be loaded");
  });

  it("rejects rather than resolving when the binary is missing", async () => {
    process.env.KB_SOFFICE_BIN = join(tmpRoot, "not-installed");

    // The caller turns this into `infrastructure`: a missing converter says
    // nothing about the documents.
    await expect(run()).rejects.toThrow();
  });

  describe("timeout", () => {
    it("kills the converter's whole process tree, not just the process we spawned", async () => {
      // Verified against the real binary: `soffice` execs `oosplash`, which
      // FORKS `soffice.bin`. Killing the process we spawned leaves the real
      // converter running — still holding the memory the timeout was meant to
      // reclaim, still writing into a staging directory we are about to
      // delete. Under memory pressure that turns one timeout into a cascade,
      // because the orphan is still resident when the next batch starts.
      const pidFile = join(tmpRoot, "grandchild.pid");
      process.env.KB_SOFFICE_BIN = stub(
        "soffice-forks",
        `sleep 30 &\nprintf '%s' "$!" > ${pidFile}\nwait\n`
      );

      // Long enough that a loaded machine has certainly reached the fork —
      // a tighter budget races the scheduler, not the code under test.
      const result = await run({ timeoutMs: 2_000 });

      expect(result.timedOut).toBe(true);
      const grandchild = Number(await readFile(pidFile, "utf8"));
      expect(grandchild).toBeGreaterThan(0);
      expect(await isGone(grandchild)).toBe(true);
    }, 15_000);

    it("does not fire for a converter that finishes in time", async () => {
      process.env.KB_SOFFICE_BIN = stub("soffice-quick", "exit 0\n");

      expect(await run({ timeoutMs: 10_000 })).toMatchObject({ timedOut: false, code: 0 });
    });
  });
});

describe("runTextOracle", () => {
  it("counts the words the extractor printed", async () => {
    const bin = stub("oracle-ok", "printf 'one two three\\n'\n");

    expect(await runTextOracle(bin, "/data/a.doc")).toBe(3);
  });

  it("answers null for a missing binary, rather than failing the document", async () => {
    // Local dev has no catdoc. A missing oracle removes the tripwire for one
    // file; it must never be mistaken for a conversion problem.
    expect(await runTextOracle(join(tmpRoot, "not-installed"), "/data/a.doc")).toBeNull();
  });

  it("answers null when the extractor exits non-zero", async () => {
    const bin = stub("oracle-angry", "printf 'partial\\n'\nexit 2\n");

    expect(await runTextOracle(bin, "/data/a.doc")).toBeNull();
  });

  it("stops reading a runaway extractor instead of buffering it all", async () => {
    // catdoc parses the same hostile legacy binaries LibreOffice does. A
    // document that makes it emit without end must not take the web process
    // down with it — the word count is a tripwire, not a reason to hold
    // hundreds of megabytes of a string.
    const bin = stub(
      "oracle-runaway",
      "while true; do printf 'word word word word word word word word\\n'; done\n"
    );

    const words = await runTextOracle(bin, "/data/a.doc");

    expect(words).toBeNull();
  }, 20_000);
});

/** Polls until `pid` is gone (or gives up), because a SIGKILL is not instant. */
async function isGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
