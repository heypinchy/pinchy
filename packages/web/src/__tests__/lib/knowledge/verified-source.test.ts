/**
 * The one door every knowledge-base source read goes through after discovery.
 *
 * Real filesystem, real links: the property under test is what the kernel does
 * with a path someone swapped, and a mocked `fs` would only test the mock.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  SourceRefusedError,
  SourceUnverifiableError,
  copyOpenSource,
  copyVerifiedSource,
  hashVerifiedSource,
  isAtPath,
  openVerifiedSource,
} from "@/lib/knowledge/verified-source";
import { SOURCE_CHUNK_BYTES } from "@/lib/knowledge/office-artifacts";

let base: string;
let share: string;
let elsewhere: string;

beforeEach(() => {
  // realpath'd: the expected path is canonical by contract, and macOS's tmpdir
  // sits behind a /var -> /private/var link.
  base = realpathSync(mkdtempSync(join(tmpdir(), "pinchy-verified-source-")));
  share = join(base, "data", "team-a");
  elsewhere = join(base, "workspaces", "other-agent");
  mkdirSync(share, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function readVerified(expected: string): Promise<string> {
  const { handle } = await openVerifiedSource(expected);
  try {
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function refusal(expected: string): Promise<string> {
  const err = await openVerifiedSource(expected).then(
    async ({ handle }) => {
      await handle.close();
      return null;
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(SourceRefusedError);
  return (err as SourceRefusedError).refusal;
}

describe("openVerifiedSource", () => {
  it("reads the regular file discovery found, and stats the descriptor rather than the path", async () => {
    const report = join(share, "report.pdf");
    writeFileSync(report, "harmless report");

    const { handle, stat } = await openVerifiedSource(report);
    try {
      expect((await handle.readFile()).toString()).toBe("harmless report");
      expect(stat.size).toBe(BigInt("harmless report".length));
    } finally {
      await handle.close();
    }
  });

  it("refuses a file swapped for a link after discovery, and never reads its target", async () => {
    const secret = join(elsewhere, "board.pdf");
    writeFileSync(secret, "TOP SECRET merger terms");
    const report = join(share, "report.pdf");
    writeFileSync(report, "harmless report");

    rmSync(report);
    symlinkSync(secret, report);

    expect(await refusal(report)).toBe("link");
  });

  it("refuses a link that was already in place (request-time reads)", async () => {
    const secret = join(elsewhere, "board.pdf");
    writeFileSync(secret, "TOP SECRET merger terms");
    const report = join(share, "report.pdf");
    symlinkSync(secret, report);

    expect(await refusal(report)).toBe("link");
  });

  it("refuses a parent directory swapped for a link — the component O_NOFOLLOW cannot see", async () => {
    // Discovery listed team-a/sub/report.pdf. Then the author of team-a moves
    // `sub` aside and puts a link to another team's folder in its place, which
    // holds a file of the same name.
    const sub = join(share, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "report.pdf"), "harmless report");
    writeFileSync(join(elsewhere, "report.pdf"), "TOP SECRET merger terms");

    renameSync(sub, join(share, "sub-aside"));
    symlinkSync(elsewhere, sub);

    expect(await refusal(join(sub, "report.pdf"))).toBe("moved");
  });

  it("reads a file an editor saved by writing a new file and renaming it over the old one", async () => {
    // A new inode at the same place. Nothing about it points outside the
    // folder, so it is the document now — refusing it would leave an
    // ordinary save unindexed until the next run, and forever on a
    // filesystem that hands out a fresh inode number on every lookup.
    const report = join(share, "report.pdf");
    writeFileSync(report, "v1");
    writeFileSync(join(share, ".report.pdf.swp"), "v2");
    renameSync(join(share, ".report.pdf.swp"), report);

    expect(await readVerified(report)).toBe("v2");
  });

  it("reads a file rewritten in place", async () => {
    const report = join(share, "report.pdf");
    writeFileSync(report, "v1");
    writeFileSync(report, "v2, longer than before");

    expect(await readVerified(report)).toBe("v2, longer than before");
  });

  it("refuses a FIFO without blocking on it", async () => {
    const report = join(share, "report.pdf");
    execFileSync("mkfifo", [report]);

    // Without O_NONBLOCK this open would wait for a writer that never comes,
    // and the test (like the indexer) would hang rather than fail.
    expect(await refusal(report)).toBe("not_a_file");
  });

  it("passes ordinary errors through unchanged — a vanished file is not a refusal", async () => {
    const gone = join(share, "gone.pdf");
    await expect(openVerifiedSource(gone)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never returns the other folder's file while a parent folder keeps flipping to a link and back", async () => {
    // The race a one-shot swap cannot show: the parent is a link while the
    // file is opened and a folder again while it is checked. A check that
    // walks the path a second time (realpath, then stat) is answered by the
    // folder, and the descriptor holds the other team's file — measured at
    // 16,942 of 20,000 reads on macOS before the portable fallback was removed.
    const sub = join(share, "sub");
    const aside = join(share, "sub-aside");
    mkdirSync(sub);
    writeFileSync(join(sub, "report.pdf"), "harmless report");
    writeFileSync(join(elsewhere, "report.pdf"), "TOP SECRET merger terms");

    let flipping = true;
    const flipper = (async () => {
      while (flipping) {
        try {
          renameSync(sub, aside);
          symlinkSync(elsewhere, sub);
        } catch {
          // A half-done flip is still a flip.
        }
        await new Promise((resolve) => setImmediate(resolve));
        try {
          rmSync(sub);
          renameSync(aside, sub);
        } catch {
          // Same.
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const read: string[] = [];
    try {
      for (let i = 0; i < 2000; i++) {
        try {
          read.push(await readVerified(join(sub, "report.pdf")));
        } catch {
          // Refused, or caught mid-flip with nothing at the path: not a read.
        }
      }
    } finally {
      flipping = false;
      await flipper;
    }

    expect(read).not.toContain("TOP SECRET merger terms");
  });
});

describe("isAtPath — where the descriptor really is", () => {
  /** isAtPath's verdict, or "refused" where it cannot tell — never a guess. */
  async function verdict(...args: Parameters<typeof isAtPath>): Promise<boolean | "refused"> {
    return isAtPath(...args).catch((err: unknown) => {
      expect(err).toBeInstanceOf(SourceUnverifiableError);
      return "refused" as const;
    });
  }

  // Linux only: the answer comes from procfs, which macOS does not have (it
  // proves the same thing in the open itself — see verified-source.ts).
  it.skipIf(!existsSync("/proc/self/fd"))(
    "answers yes for the descriptor of the file at the path",
    async () => {
      const report = join(share, "report.pdf");
      writeFileSync(report, "harmless");
      const { open } = await import("node:fs/promises");
      const handle = await open(report, "r");
      try {
        expect(await isAtPath(handle, report)).toBe(true);
      } finally {
        await handle.close();
      }
    }
  );

  it("refuses rather than guesses when the descriptor's location cannot be read", async () => {
    // No procfs — another OS, or a container without /proc mounted. The
    // portable answer used to be a second walk of the path (realpath, then
    // stat), which a parent flipping between a folder and a link answers
    // wrongly. There is no sound portable answer, so there is none.
    const report = join(share, "report.pdf");
    writeFileSync(report, "harmless");
    const { open } = await import("node:fs/promises");
    const handle = await open(report, "r");
    try {
      await expect(isAtPath(handle, report, join(base, "no-procfs-here"))).rejects.toBeInstanceOf(
        SourceUnverifiableError
      );
    } finally {
      await handle.close();
    }
  });

  it("never answers yes when a parent was swapped after the descriptor was opened", async () => {
    const sub = join(share, "sub");
    mkdirSync(sub);
    const report = join(sub, "report.pdf");
    writeFileSync(report, "harmless");
    writeFileSync(join(elsewhere, "report.pdf"), "TOP SECRET");

    const { open } = await import("node:fs/promises");
    const handle = await open(report, "r");
    try {
      renameSync(sub, join(share, "sub-aside"));
      symlinkSync(elsewhere, sub);
      expect(await verdict(handle, report)).not.toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("never answers yes for the other folder's file once the path resolves cleanly again", async () => {
    // A parent swapped BEFORE the open and swapped back afterwards: the path
    // resolves cleanly again, but the descriptor holds the other team's file.
    const sub = join(share, "sub");
    mkdirSync(sub);
    const report = join(sub, "report.pdf");
    writeFileSync(report, "harmless");
    writeFileSync(join(elsewhere, "report.pdf"), "TOP SECRET");

    renameSync(sub, join(share, "sub-aside"));
    symlinkSync(elsewhere, sub);
    const { open } = await import("node:fs/promises");
    const handle = await open(report, "r");
    try {
      rmSync(sub);
      renameSync(join(share, "sub-aside"), sub);
      expect(await verdict(handle, report)).not.toBe(true);
    } finally {
      await handle.close();
    }
  });
});

describe("copyVerifiedSource", () => {
  const staging = () => join(base, "kb-artifacts", "staging");

  it("streams the source into a directory only this process can enter, under its basename, hashing exactly the bytes it copied", async () => {
    // Larger than a chunk: the copy is written a chunk at a time from the
    // verified descriptor, and this process never holds the file whole.
    const bytes = "x".repeat(2 * SOURCE_CHUNK_BYTES + 5);
    const source = join(share, "Rechnung.doc");
    writeFileSync(source, bytes);

    const copy = await copyVerifiedSource(source, source, staging());
    try {
      expect(copy.path.endsWith("/Rechnung.doc")).toBe(true);
      expect(copy.path.startsWith(share)).toBe(false);
      // On the artifact volume's staging area, which the index worker clears
      // at start — never the container's /tmp, where a copy a killed run left
      // behind would outlive every restart on the writable layer.
      expect(dirname(dirname(copy.path))).toBe(staging());
      expect(readFileSync(copy.path, "utf8")).toBe(bytes);
      expect(copy.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(copy.size).toBe(bytes.length);
      expect(copy.mtime.getTime()).toBe(statSync(source, { bigint: true }).mtime.getTime());
      expect(statSync(dirname(copy.path)).mode & 0o777).toBe(0o700);
    } finally {
      await copy.dispose();
    }
    expect(() => statSync(dirname(copy.path))).toThrow();
  });

  it("refuses a source swapped for a link, and leaves no copy behind", async () => {
    const source = join(share, "report.pdf");
    writeFileSync(join(elsewhere, "secret.pdf"), "another team's file");
    symlinkSync(join(elsewhere, "secret.pdf"), source);

    await expect(copyVerifiedSource(source, source, staging())).rejects.toBeInstanceOf(
      SourceRefusedError
    );
    expect(existsSync(staging()) ? readdirSync(staging()) : []).toEqual([]);
  });

  it("stops at `maxBytes`, however far the file runs past it", async () => {
    // The preview route checks a workbook's size before it copies it; a file
    // still being written can grow past that check while the copy runs, and
    // the copy must not follow it. One byte past the reader's limit is all the
    // reader needs to refuse it as too large.
    const bytes = "y".repeat(2 * SOURCE_CHUNK_BYTES + 5);
    const path = join(share, "Preise.xlsx");
    writeFileSync(path, bytes);
    const maxBytes = SOURCE_CHUNK_BYTES + 3;

    const source = await openVerifiedSource(path);
    let copy;
    try {
      copy = await copyOpenSource(source, path, staging(), { maxBytes });
    } finally {
      await source.handle.close();
    }
    try {
      expect(copy.size).toBe(maxBytes);
      expect(readFileSync(copy.path, "utf8")).toBe(bytes.slice(0, maxBytes));
      expect(copy.hash).toBe(createHash("sha256").update(bytes.slice(0, maxBytes)).digest("hex"));
    } finally {
      await copy.dispose();
    }
  });
});

describe("hashVerifiedSource", () => {
  it("hashes the source through the verified descriptor, without a copy", async () => {
    const bytes = "y".repeat(SOURCE_CHUNK_BYTES + 1);
    const source = join(share, "report.pdf");
    writeFileSync(source, bytes);

    const { hash, mtime } = await hashVerifiedSource(source);

    expect(hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(mtime.getTime()).toBe(statSync(source, { bigint: true }).mtime.getTime());
  });

  it("refuses a source swapped for a link", async () => {
    const source = join(share, "report.pdf");
    writeFileSync(join(elsewhere, "secret.pdf"), "another team's file");
    symlinkSync(join(elsewhere, "secret.pdf"), source);

    await expect(hashVerifiedSource(source)).rejects.toBeInstanceOf(SourceRefusedError);
  });
});

it("reads through a root that is itself a link, because the expected path is the real one", async () => {
  // An admin may grant /data while /data is a link to the real mount. The
  // expected path is resolved from the root once, so the link is never in it.
  const report = join(share, "report.pdf");
  writeFileSync(report, "harmless report");
  const linkedRoot = join(base, "linked-data");
  symlinkSync(join(base, "data"), linkedRoot);

  expect(await readVerified(realpathSync(join(linkedRoot, "team-a", "report.pdf")))).toBe(
    "harmless report"
  );
});
