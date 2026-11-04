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
let scratchDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-adapter-test-"));
  outDir = join(tmpRoot, "out");
  profileDir = join(tmpRoot, "profile");
  scratchDir = join(tmpRoot, "tmp");
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
  return runSoffice({
    inputs: [],
    outDir,
    profileDir,
    tmpDir: scratchDir,
    timeoutMs: 10_000,
    ...overrides,
  });
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
    // And its scratch space goes into the batch too: left
    // to the OS temp dir, a load that runs out of room there looks exactly
    // like a document LibreOffice cannot read, on a volume nothing checks.
    expect(env.TMPDIR).toBe(scratchDir);
  });

  describe("the locked-down profile", () => {
    // Each key below was found by CANARY, not by name: a crafted document with
    // an external picture link, converted by the real binary against a local
    // listener (see office-convert.libreoffice.test.ts). Only
    // BlockUntrustedRefererLinks stopped http AND file:// on its own; the
    // others are belts. This test pins that the profile is WRITTEN, before the
    // converter starts, into the user installation the child is pointed at.
    async function profileAtStart(): Promise<string> {
      const record = join(tmpRoot, "xcu-at-start");
      process.env.KB_SOFFICE_BIN = stub(
        "soffice-xcu",
        `cat ${profileDir}/user/registrymodifications.xcu > ${record}\n`
      );
      await run();
      return readFile(record, "utf8");
    }

    it("is in place before the converter starts", async () => {
      expect(await profileAtStart()).toContain("<oor:items");
    });

    it("refuses to follow links from documents it did not write", async () => {
      expect(await profileAtStart()).toMatch(
        /oor:path="\/org\.openoffice\.Office\.Common\/Security\/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true<\/value>/
      );
    });

    it("never updates links on load, and routes any network access to a dead proxy", async () => {
      const xcu = await profileAtStart();
      expect(xcu).toMatch(/oor:name="Link" oor:op="fuse"><value>2<\/value>/);
      expect(xcu).toMatch(/oor:name="ooInetProxyType" oor:op="fuse"><value>2<\/value>/);
      expect(xcu).toMatch(
        /oor:name="ooInetHTTPProxyName" oor:op="fuse"><value>127\.0\.0\.1<\/value>/
      );
      expect(xcu).toMatch(
        /oor:name="ooInetHTTPSProxyName" oor:op="fuse"><value>127\.0\.0\.1<\/value>/
      );
      expect(xcu).toMatch(/oor:name="ooInetNoProxy" oor:op="fuse"><value><\/value>/);
    });

    it("keeps its scratch space in TMPDIR, whatever the build's default", async () => {
      // LibreOffice unpacks a package into its Temp path, which defaults to
      // $(temp) — TMPDIR — on Linux but to the profile's own temp directory
      // on macOS builds (measured, LibreOffice 26.2). Pinned, the scratch is
      // where the batch's TMPDIR says on every build.
      expect(await profileAtStart()).toContain(
        `<item oor:path="/org.openoffice.Office.Paths/Paths/org.openoffice.Office.Paths:NamedPath['Temp']"><prop oor:name="WritePath" oor:op="fuse"><value>$(temp)</value></prop></item>`
      );
    });

    it("fails closed: if the profile cannot be written, the converter does not run", async () => {
      const ran = join(tmpRoot, "ran");
      process.env.KB_SOFFICE_BIN = stub("soffice-ran", `touch ${ran}\n`);
      // A FILE where the profile directory must go.
      writeFileSync(profileDir, "in the way");

      await expect(run()).rejects.toThrow();
      await expect(readFile(ran)).rejects.toThrow();
    });
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
      "i=0; while [ $i -lt 1200 ]; do i=$((i+1)); " +
        'printf "Error: source file could not be loaded padding padding padding padding\\n" >&2; ' +
        "done\n"
    );

    const result = await run();

    expect(result.stderr.length).toBeLessThan(64 * 1024);
    expect(result.stderr).toContain("could not be loaded");
  });

  it("keeps enough stderr for every file of a full batch whose PDFs did not fit", async () => {
    // The per-file `impl_store … failed` line is what the operator is shown
    // for a PDF a full volume did not take (the volume itself decides that).
    // At production staging-path lengths a batch of 20 prints
    // ~9 KB of them; the last file must not lose its line to the cap.
    const dir = `/app/kb-artifacts/staging/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;
    process.env.KB_SOFFICE_BIN = stub(
      "soffice-full",
      'printf "Warning: failed to launch javaldx - java may not function correctly\\n" >&2; ' +
        "i=0; while [ $i -lt 20 ]; do " +
        `printf "convert ${dir}/in/$i.pptx -> ${dir}/out/$i.pdf using filter : impress_pdf_Export\\n" >&2; ` +
        `printf "Error: Please verify input parameters... (SfxBaseModel::impl_store <file://${dir}/out/$i.pdf> failed: 0x507(Error Area:Io Class:Access Code:7) at ./sfx2/source/doc/sfxbasemodel.cxx:3207 at ./sfx2/source/doc/sfxbasemodel.cxx:1783)\\n" >&2; ` +
        "i=$((i+1)); done\n"
    );

    const result = await run();

    expect(result.stderr).toContain(`impl_store <file://${dir}/out/19.pdf> failed`);
  });

  it("caps stderr at exactly 32 KB, however large the chunk it arrives in", async () => {
    // A pipe read can deliver 64 KB at once; the cap has to hold for the
    // chunk that crosses it, or the answer outgrows what the web side reads.
    const big = join(tmpRoot, "big");
    writeFileSync(big, "\u0001".repeat(200_000));
    process.env.KB_SOFFICE_BIN = stub("soffice-burst", `cat ${big} >&2\n`);

    const result = await run();

    expect(result.stderr.length).toBe(32 * 1024);
    // Even escaped six-fold, as JSON does with control characters, the
    // answer stays under the 256 KB the web side accepts.
    expect(JSON.stringify(result).length).toBeLessThan(256 * 1024);
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

    it("answers once the converter has exited, even when something it started still holds its stderr", async () => {
      // 'close' waits for every holder of the stderr pipe. A process the
      // converter left behind must not keep the batch from answering — the
      // sidecar's leftover check needs the answer to run at all.
      const pidFile = join(tmpRoot, "holder.pid");
      process.env.KB_SOFFICE_BIN = stub(
        "soffice-leaves-holder",
        `sleep 30 &\nprintf '%s' "$!" > ${pidFile}\nexit 0\n`
      );
      const started = Date.now();

      const result = await run({ timeoutMs: 60_000 });

      expect(result).toMatchObject({ code: 0, timedOut: false });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await isGone(Number(await readFile(pidFile, "utf8")))).toBe(true);
    }, 30_000);

    it("does not call a converter that exited in time timed out while its stderr drains", async () => {
      // It exits before the budget; something it started holds stderr past
      // the budget. The batch finished — its PDFs are written — and must not
      // be booked as "exceeded its time budget".
      const pidFile = join(tmpRoot, "late-holder.pid");
      process.env.KB_SOFFICE_BIN = stub(
        "soffice-exits-in-time",
        `sleep 30 &\nprintf '%s' "$!" > ${pidFile}\nsleep 2\nexit 0\n`
      );

      // Exits at ~2 s; the budget ends at 3.5 s, inside the 2 s drain that
      // follows — with room for a slow start on a loaded machine.
      const result = await run({ timeoutMs: 3_500 });

      expect(result).toMatchObject({ code: 0, timedOut: false });
      expect(await isGone(Number(await readFile(pidFile, "utf8")))).toBe(true);
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
