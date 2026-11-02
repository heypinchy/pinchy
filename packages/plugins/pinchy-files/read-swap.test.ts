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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
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
  base = mkdtempSync(join(tmpdir(), "pinchy-files-swap-"));
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
