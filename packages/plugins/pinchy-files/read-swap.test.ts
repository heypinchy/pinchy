// @vitest-environment node
/**
 * pinchy_read — a file swapped for a link after the access check.
 *
 * The tool realpaths the requested path and validates the RESULT, so a link
 * already in place resolves to its target and is judged there. What that check
 * cannot see is a link put in place AFTER it: the read below it used to reopen
 * the path and follow the new link to a file outside the agent's paths. The
 * swap is injected exactly there — inside `validateAccess`, after the realpath,
 * before the read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { open } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const testCacheDir = mkdtempSync(join(tmpdir(), "pinchy-files-swap-cache-"));
process.env.PINCHY_PDF_CACHE_DIR = testCacheDir;

const hooks = vi.hoisted(() => ({ afterAccessCheck: null as null | (() => void) }));
vi.mock("./validate", async (importOriginal) => {
  const original = await importOriginal<typeof import("./validate")>();
  return {
    ...original,
    // The fixtures are not under /data/, so the lexical root check is passed
    // through — what is under test is what happens AFTER it.
    validateAccess: vi.fn((_config: unknown, requestedPath: string) => {
      hooks.afterAccessCheck?.();
      hooks.afterAccessCheck = null;
      return requestedPath;
    }),
  };
});

const mockRegisterTool = vi.fn();

async function readTool() {
  const { default: plugin } = await import("./index");
  plugin.register({
    id: "pinchy-files",
    name: "Pinchy Files",
    source: "test",
    config: {},
    pluginConfig: { agents: { "agent-1": { allowed_paths: [share + "/"] } } },
    runtime: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool: mockRegisterTool,
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn(),
  } as never);
  const factory = mockRegisterTool.mock.calls.find((call) => call[1]?.name === "pinchy_read")?.[0];
  return factory({ agentId: "agent-1" });
}

const SECRET = "TOP SECRET merger terms for another team";
const FIXTURES = join(import.meta.dirname, "test-fixtures");

let base: string;
let share: string;
let otherTeam: string;

beforeEach(() => {
  vi.clearAllMocks();
  hooks.afterAccessCheck = null;
  // realpath'd: the tool reads a realpath'd path (the mock below skips that
  // step), and macOS's tmpdir sits behind a /var -> /private/var link.
  base = realpathSync(mkdtempSync(join(tmpdir(), "pinchy-files-swap-")));
  share = join(base, "team-a");
  otherTeam = join(base, "team-b");
  mkdirSync(share);
  mkdirSync(otherTeam);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function swapAfterCheck(path: string, target: string) {
  hooks.afterAccessCheck = () => {
    rmSync(path);
    symlinkSync(target, path);
  };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

describe("pinchy_read and a file swapped for a link after the access check", () => {
  it("refuses a text file swapped for a link instead of reading its target", async () => {
    const report = join(share, "report.md");
    writeFileSync(report, "harmless report");
    writeFileSync(join(otherTeam, "board.md"), SECRET);
    swapAfterCheck(report, join(otherTeam, "board.md"));

    const result = await (await readTool()).execute("call-1", { path: report });

    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain(SECRET);
    expect(text(result)).toMatch(/symbolic link/);
  });

  it("refuses a PDF swapped for a link instead of reading its target", async () => {
    const report = join(share, "report.pdf");
    writeFileSync(report, readFileSync(join(FIXTURES, "text-only.pdf")));
    // Another PDF entirely, so a read of it would return its text.
    const secret = join(otherTeam, "roster.pdf");
    writeFileSync(secret, readFileSync(join(FIXTURES, "with-tables.pdf")));
    swapAfterCheck(report, secret);

    const result = await (await readTool()).execute("call-1", { path: report });

    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("Engineering Department Roster");
    expect(text(result)).toMatch(/symbolic link/);
  });

  it("refuses a file reached through a folder swapped for a link", async () => {
    const sub = join(share, "projects");
    mkdirSync(sub);
    const report = join(sub, "report.md");
    writeFileSync(report, "harmless report");
    writeFileSync(join(otherTeam, "report.md"), SECRET);
    hooks.afterAccessCheck = () => {
      rmSync(sub, { recursive: true });
      symlinkSync(otherTeam, sub);
    };

    const result = await (await readTool()).execute("call-1", { path: report });

    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain(SECRET);
  });

  it("still reads an ordinary file", async () => {
    const report = join(share, "report.md");
    writeFileSync(report, "harmless report");

    const result = await (await readTool()).execute("call-1", { path: report });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe("harmless report");
  });
});

describe("openVerified — where the descriptor really is", () => {
  it("never returns the other folder's file while a parent folder keeps flipping to a link and back", async () => {
    // The parent is a link while the file is opened and a folder again while
    // it is checked. A check that walks the path a second time (realpath, then
    // stat) is answered by the folder, while the descriptor holds the other
    // team's file — 16,942 of 20,000 reads on macOS before the fallback went.
    const { openVerified } = await import("./verified-open");
    const sub = join(share, "projects");
    const aside = join(share, "projects-aside");
    mkdirSync(sub);
    writeFileSync(join(sub, "report.md"), "harmless report");
    writeFileSync(join(otherTeam, "report.md"), SECRET);

    let flipping = true;
    const flipper = (async () => {
      while (flipping) {
        try {
          renameSync(sub, aside);
          symlinkSync(otherTeam, sub);
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
          const { handle } = await openVerified(join(sub, "report.md"));
          try {
            read.push((await handle.readFile()).toString("utf8"));
          } finally {
            await handle.close();
          }
        } catch {
          // Refused, or caught mid-flip with nothing at the path: not a read.
        }
      }
    } finally {
      flipping = false;
      await flipper;
    }

    expect(read).not.toContain(SECRET);
  });

  it("refuses rather than guesses when the descriptor's location cannot be read", async () => {
    // No procfs: there is no sound portable answer (see verified-open.ts), so
    // there is no answer — the read is refused.
    const { isAtPath, RefusedReadError } = await import("./verified-open");
    const report = join(share, "report.md");
    writeFileSync(report, "harmless report");
    const handle = await open(report, "r");
    try {
      await expect(isAtPath(handle, report, join(base, "no-procfs-here"))).rejects.toBeInstanceOf(
        RefusedReadError
      );
    } finally {
      await handle.close();
    }
  });

  // Linux only: the answer comes from procfs; macOS proves it in the open.
  it.skipIf(!existsSync("/proc/self/fd"))(
    "answers yes for the descriptor of the file at the path",
    async () => {
      const { isAtPath } = await import("./verified-open");
      const report = join(share, "report.md");
      writeFileSync(report, "harmless report");
      const handle = await open(report, "r");
      try {
        expect(await isAtPath(handle, report)).toBe(true);
      } finally {
        await handle.close();
      }
    }
  );
});
