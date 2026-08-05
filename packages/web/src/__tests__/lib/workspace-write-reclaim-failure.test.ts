import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The reclaim's failure path, which its sibling file cannot reach.
//
// `workspace-write-reclaim.test.ts` proves the happy path against the real
// filesystem: a file Pinchy may not overwrite gets replaced anyway. This file
// asks the question that decides HOW: what happens when the replacement itself
// cannot be written?
//
// It matters more than it looks. AGENTS.md and SOUL.md have no copy in the
// database — `GET /api/agents/:id/files/:filename` reads the file, so the file
// IS the user's instructions. A reclaim that removes the target first and then
// fails has destroyed them. The window is small but not theoretical: a full
// disk, or the OpenClaw container recreating the bootstrap file root-owned in
// the moment it is missing, both land exactly there.
//
// So the reclaim goes through a same-directory temp file and rename(2).
// `rename` replaces the target on the strength of the DIRECTORY's permissions —
// the same POSIX rule `unlink` follows, which is what makes the reclaim
// possible at all — and is atomic, so the target is never absent. Measured:
//
//   file 0444 in a writable dir:  write → EACCES,  rename over it → OK (mode 644)
//   same file in a 0555 dir:      rename → EACCES, original intact
//
// Failure injection is the one thing mocked here; every filesystem effect below
// is real. A test that mocked `fs` wholesale would be asserting against its own
// model of POSIX, which is the thing actually under test.
let denyWrites = false;

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (denyWrites) {
        const err: NodeJS.ErrnoException = new Error("EACCES: permission denied, open");
        err.code = "EACCES";
        err.errno = -13;
        throw err;
      }
      return actual.writeFileSync(...args);
    },
  };
});

const TEST_ROOT = mkdtempSync(join(tmpdir(), "workspace-reclaim-fail-"));
process.env.WORKSPACE_BASE_PATH = TEST_ROOT;

let workspace: typeof import("@/lib/workspace");
const AGENT_ID = "0d4b2f3a-7c19-4a5e-8b62-1f9e3c7d5a04";
const INSTRUCTIONS = "# The user's instructions, with no copy anywhere else\n";

beforeEach(async () => {
  vi.resetModules();
  workspace = await import("@/lib/workspace");
  denyWrites = false;
  mkdirSync(join(TEST_ROOT, AGENT_ID), { recursive: true });
});

afterEach(() => {
  denyWrites = false;
  rmSync(join(TEST_ROOT, AGENT_ID), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("a reclaim that cannot complete leaves the original alone (#1095)", () => {
  it("keeps AGENTS.md intact when the replacement cannot be written", () => {
    const filePath = join(TEST_ROOT, AGENT_ID, "AGENTS.md");
    writeFileSync(filePath, INSTRUCTIONS, "utf-8");

    denyWrites = true;
    expect(() => workspace.writeWorkspaceFile(AGENT_ID, "AGENTS.md", "# replacement\n")).toThrow();
    denyWrites = false;

    // The assertion the rm-then-write shape fails: it unlinks the target before
    // it knows the new content can be written, so this file would be gone.
    expect(readFileSync(filePath, "utf-8")).toBe(INSTRUCTIONS);
  });

  it("keeps SOUL.md intact too — same absence of a database copy", () => {
    const filePath = join(TEST_ROOT, AGENT_ID, "SOUL.md");
    writeFileSync(filePath, INSTRUCTIONS, "utf-8");

    denyWrites = true;
    expect(() => workspace.writeWorkspaceFile(AGENT_ID, "SOUL.md", "# replacement\n")).toThrow();
    denyWrites = false;

    expect(readFileSync(filePath, "utf-8")).toBe(INSTRUCTIONS);
  });

  it("leaves no temp file behind when the reclaim fails", () => {
    // A stray dotfile in the workspace is not inert: OpenClaw reads this
    // directory, and a leftover would accumulate one entry per failed save.
    const filePath = join(TEST_ROOT, AGENT_ID, "AGENTS.md");
    writeFileSync(filePath, INSTRUCTIONS, "utf-8");

    denyWrites = true;
    expect(() => workspace.writeWorkspaceFile(AGENT_ID, "AGENTS.md", "# replacement\n")).toThrow();
    denyWrites = false;

    expect(readdirSync(join(TEST_ROOT, AGENT_ID))).toEqual(["AGENTS.md"]);
  });

  it("propagates the original cause rather than a cleanup error", () => {
    // The caller renders this text — the route puts it in the 500 body. A
    // cleanup failure masking the real reason would restore #1095's core
    // problem: a failure that does not say why.
    const filePath = join(TEST_ROOT, AGENT_ID, "TOOLS.md");
    writeFileSync(filePath, "# placeholder\n", "utf-8");

    denyWrites = true;
    try {
      workspace.writeToolsFile(AGENT_ID, [
        { address: "a@example.com", label: "a@example.com", operations: ["read"] },
      ]);
      expect.unreachable("writeToolsFile should have thrown");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
    } finally {
      denyWrites = false;
    }
  });
});
