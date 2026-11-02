/**
 * The one door every knowledge-base source read goes through after discovery.
 *
 * Real filesystem, real links: the property under test is what the kernel does
 * with a path someone swapped, and a mocked `fs` would only test the mock.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  identityOf,
  isAtPath,
  openVerifiedSource,
  writePrivateCopy,
  type ExpectedSource,
} from "@/lib/knowledge/verified-source";

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

/** What discovery records for a file it listed. */
function discovered(path: string): ExpectedSource {
  return { realPath: path, identity: identityOf(lstatSync(path, { bigint: true })) };
}

async function readVerified(expected: ExpectedSource): Promise<string> {
  const { handle } = await openVerifiedSource(expected);
  try {
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function refusal(expected: ExpectedSource): Promise<string> {
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

    const { handle, stat } = await openVerifiedSource(discovered(report));
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
    const seen = discovered(report);

    rmSync(report);
    symlinkSync(secret, report);

    expect(await refusal(seen)).toBe("link");
  });

  it("refuses a link even when the caller has no discovery identity to compare (request-time reads)", async () => {
    const secret = join(elsewhere, "board.pdf");
    writeFileSync(secret, "TOP SECRET merger terms");
    const report = join(share, "report.pdf");
    symlinkSync(secret, report);

    expect(await refusal({ realPath: report })).toBe("link");
  });

  it("refuses a parent directory swapped for a link — the component O_NOFOLLOW cannot see", async () => {
    // Discovery listed team-a/sub/report.pdf. Then the author of team-a moves
    // `sub` aside and puts a link to another team's folder in its place, which
    // holds a file of the same name.
    const sub = join(share, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "report.pdf"), "harmless report");
    writeFileSync(join(elsewhere, "report.pdf"), "TOP SECRET merger terms");
    const seen = discovered(join(sub, "report.pdf"));

    renameSync(sub, join(share, "sub-aside"));
    symlinkSync(elsewhere, sub);

    // Refused on two independent grounds — the inode is not the one discovery
    // saw, and the descriptor is not at the expected path. Either is enough.
    expect(["replaced", "moved"]).toContain(await refusal(seen));
    // And with no identity to lean on, the path check alone still refuses it.
    expect(await refusal({ realPath: seen.realPath })).toBe("moved");
  });

  it("refuses a parent swapped DURING discovery, when the inode recorded is already the wrong one", async () => {
    // The walk read `sub` as a directory, then the swap landed before it
    // listed `sub`'s entries: discovery recorded the other team's inode under
    // team-a's name. Only the where-is-the-descriptor check can see that.
    const sub = join(share, "sub");
    writeFileSync(join(elsewhere, "report.pdf"), "TOP SECRET merger terms");
    symlinkSync(elsewhere, sub);
    const expected: ExpectedSource = {
      realPath: join(sub, "report.pdf"),
      identity: identityOf(lstatSync(join(elsewhere, "report.pdf"), { bigint: true })),
    };

    expect(await refusal(expected)).toBe("moved");
  });

  it("refuses a different regular file put in place of the one discovery found", async () => {
    const report = join(share, "report.pdf");
    writeFileSync(report, "v1");
    const seen = discovered(report);
    rmSync(report);
    writeFileSync(join(share, "staged.pdf"), "v2");
    renameSync(join(share, "staged.pdf"), report);

    expect(await refusal(seen)).toBe("replaced");
  });

  it("refuses a FIFO without blocking on it", async () => {
    const report = join(share, "report.pdf");
    writeFileSync(report, "v1");
    const seen = discovered(report);
    rmSync(report);
    execFileSync("mkfifo", [report]);

    // Without O_NONBLOCK this open would wait for a writer that never comes,
    // and the test (like the indexer) would hang rather than fail.
    expect(await refusal(seen)).toBe("not_a_file");
  });

  it("passes ordinary errors through unchanged — a vanished file is not a refusal", async () => {
    const gone = join(share, "gone.pdf");
    await expect(openVerifiedSource({ realPath: gone })).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("isAtPath — the portable fallback, where there is no /proc", () => {
  it("answers yes for the descriptor of the file at the path", async () => {
    const report = join(share, "report.pdf");
    writeFileSync(report, "harmless");
    const { handle, stat } = await openVerifiedSource({ realPath: report });
    try {
      expect(await isAtPath(handle, stat, report, null)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("answers no when a parent was swapped after the descriptor was opened", async () => {
    const sub = join(share, "sub");
    mkdirSync(sub);
    const report = join(sub, "report.pdf");
    writeFileSync(report, "harmless");
    writeFileSync(join(elsewhere, "report.pdf"), "TOP SECRET");

    const { handle, stat } = await openVerifiedSource({ realPath: report });
    try {
      renameSync(sub, join(share, "sub-aside"));
      symlinkSync(elsewhere, sub);
      expect(await isAtPath(handle, stat, report, null)).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("answers no when the descriptor is a different inode from the file now at the path", async () => {
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
      const stat = await handle.stat({ bigint: true });
      rmSync(sub);
      renameSync(join(share, "sub-aside"), sub);
      expect(await isAtPath(handle, stat, report, null)).toBe(false);
    } finally {
      await handle.close();
    }
  });
});

describe("writePrivateCopy", () => {
  it("copies the bytes under the source's basename into a directory only this process can enter", async () => {
    const copy = await writePrivateCopy(Buffer.from("bytes"), join(share, "Rechnung.doc"));
    try {
      expect(copy.path.endsWith("/Rechnung.doc")).toBe(true);
      expect(copy.path.startsWith(share)).toBe(false);
      expect(readFileSync(copy.path, "utf8")).toBe("bytes");
      expect(statSync(dirname(copy.path)).mode & 0o777).toBe(0o700);
    } finally {
      await copy.dispose();
    }
    expect(() => statSync(dirname(copy.path))).toThrow();
  });
});

it("reads through a root that is itself a link, because the expected path is the real one", async () => {
  // An admin may grant /data while /data is a link to the real mount. The
  // expected path is resolved from the root once, so the link is never in it.
  const report = join(share, "report.pdf");
  writeFileSync(report, "harmless report");
  const linkedRoot = join(base, "linked-data");
  symlinkSync(join(base, "data"), linkedRoot);

  expect(
    await readVerified(discovered(realpathSync(join(linkedRoot, "team-a", "report.pdf"))))
  ).toBe("harmless report");
});
