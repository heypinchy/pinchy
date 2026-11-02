/**
 * GET /api/agents/[agentId]/workspace-file — a source swapped for a link after
 * the containment check.
 *
 * `resolveAllowedFile` realpaths the request and checks the RESULT against the
 * agent's grant, so a link already in place is refused. What it cannot see is
 * a link put in place AFTER it answered: every read below it used to reopen
 * the path, and would follow the new link to another team's file. Each read
 * now goes through `openVerifiedSource` (lib/knowledge/verified-source.ts).
 *
 * The swap is injected exactly where an author of the share would race it:
 * the real `resolveAllowedFile` runs, then the file is replaced before the
 * route reads a byte.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({ getSession: (...args: unknown[]) => mockGetSession(...args) }));

const mockGetAgentWithAccess = vi.fn();
vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: (...args: unknown[]) => mockGetAgentWithAccess(...args),
}));

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));

const mockDeferAuditLog = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
}));

vi.mock("@/lib/file-serve-roots", async () => {
  const { tmpdir } = await import("node:os");
  return { FILE_SERVE_ROOTS: [tmpdir()] };
});

/** Runs after the real containment check has answered, before the route reads. */
let afterContainmentCheck: (() => void) | null = null;
vi.mock("@/lib/agent-file-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-file-access")>();
  return {
    ...actual,
    resolveAllowedFile: async (...args: Parameters<typeof actual.resolveAllowedFile>) => {
      const result = await actual.resolveAllowedFile(...args);
      afterContainmentCheck?.();
      return result;
    },
  };
});

let tmpRoot: string;
let allowedRoot: string;
let otherTeam: string;
let artifactDir: string;

const SECRET = "TOP SECRET merger terms for another team";

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  afterContainmentCheck = null;
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-workspace-file-swap-"));
  allowedRoot = join(tmpRoot, "allowed");
  otherTeam = join(tmpRoot, "other-team");
  artifactDir = join(tmpRoot, "artifacts");
  mkdirSync(allowedRoot, { recursive: true });
  mkdirSync(otherTeam, { recursive: true });
  process.env.KB_ARTIFACT_DIR = artifactDir;

  mockGetSession.mockResolvedValue({ user: { id: "user-1", role: "member" } });
  mockGetAgentWithAccess.mockResolvedValue({
    id: "agent-1",
    name: "Smithers",
    pluginConfig: { "pinchy-files": { allowed_paths: [allowedRoot] } },
  });
});

afterEach(() => {
  delete process.env.KB_ARTIFACT_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function callGET(requestedPath: string, extraParams: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/route");
  const url = new URL("http://localhost/api/agents/agent-1/workspace-file");
  url.searchParams.set("path", requestedPath);
  for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
  return GET(new NextRequest(url), {
    params: Promise.resolve({ agentId: "agent-1" }),
  } as unknown as Parameters<typeof GET>[1]);
}

/** Replaces `path` with a link to `target` once the containment check has passed. */
function swapAfterCheck(path: string, target: string) {
  afterContainmentCheck = () => {
    rmSync(path);
    symlinkSync(target, path);
  };
}

function failureReasons(): string[] {
  return mockDeferAuditLog.mock.calls
    .map(([entry]) => entry as { outcome: string; detail: { reason?: string } })
    .filter((entry) => entry.outcome === "failure")
    .map((entry) => entry.detail.reason ?? "");
}

describe("a source swapped for a link after the containment check", () => {
  it("is not served as the original", async () => {
    const report = join(allowedRoot, "report.pdf");
    writeFileSync(report, "%PDF-1.4 harmless report");
    const secret = join(otherTeam, "board.pdf");
    writeFileSync(secret, SECRET);
    swapAfterCheck(report, secret);

    const res = await callGET(report);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
    expect(failureReasons()).toEqual(["refused_link"]);
  });

  it("does not open another document's converted PDF", async () => {
    // The artifact store is keyed on content. Hashing the link's TARGET would
    // find the other team's conversion and serve it under this name.
    const report = join(allowedRoot, "report.docx");
    writeFileSync(report, "PK harmless report");
    const secret = join(otherTeam, "board.docx");
    writeFileSync(secret, SECRET);
    const { OfficeArtifactStore } = await import("@/lib/knowledge/office-artifacts");
    const staged = join(tmpRoot, "staged.pdf");
    writeFileSync(staged, `%PDF-1.4 ${SECRET}`);
    await new OfficeArtifactStore(artifactDir).put(
      createHash("sha256").update(SECRET).digest("hex"),
      staged
    );
    swapAfterCheck(report, secret);

    const res = await callGET(report);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("does not answer with another workbook's rows", async () => {
    const workbook = async (path: string, cell: string) => {
      const book = new ExcelJS.Workbook();
      book.addWorksheet("Suppliers").addRow([cell]);
      await book.xlsx.writeFile(path);
    };
    const report = join(allowedRoot, "prices.xlsx");
    await workbook(report, "harmless");
    const secret = join(otherTeam, "salaries.xlsx");
    await workbook(secret, SECRET);
    swapAfterCheck(report, secret);

    const res = await callGET(report, { variant: "rows", sheet: "Suppliers", from: "1", to: "1" });

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
    expect(failureReasons()).toEqual(["refused_link"]);
  });

  it("still serves an ordinary file, rows and conversion unchanged", async () => {
    const report = join(allowedRoot, "report.pdf");
    writeFileSync(report, "%PDF-1.4 harmless report");

    const res = await callGET(report);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF-1.4 harmless report");
  });
});
