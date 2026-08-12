/**
 * GET /api/agents/[agentId]/workspace-file?variant=rows — the spreadsheet half
 * of #940.
 *
 * A cited `.xlsx` cannot open in the PDF viewer: it has no page, and
 * converting one would clip the wide columns the cell-based ingest exists to
 * preserve. So the citation opens the cited ROWS, and this route answers with
 * them.
 *
 * It rides the existing route rather than getting its own, and these tests are
 * the argument for that: one access check, one audit row. Reading rows is
 * looking at the document, so it must be gated and recorded exactly like
 * streaming its bytes — a preview that skipped either would be a way to read a
 * document the reader may not open, or to read one without saying so.
 *
 * Same harness as `agent-workspace-file-office.test.ts` (real filesystem,
 * mocked auth/agent-access/audit) with a real workbook on disk: a mocked
 * reader would assert nothing about the cells actually served.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import ExcelJS from "exceljs";

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

// The production ceiling is a container mount point no test can create, so it
// is MOVED to the temp tree rather than switched off — see the same note in
// `agent-workspace-file.test.ts`.
vi.mock("@/lib/file-serve-roots", async () => {
  const { tmpdir } = await import("node:os");
  return { FILE_SERVE_ROOTS: [tmpdir()] };
});

let tmpRoot: string;
let allowedRoot: string;
let outsideDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-workspace-file-rows-"));
  allowedRoot = join(tmpRoot, "allowed");
  outsideDir = join(tmpRoot, "outside");
  mkdirSync(allowedRoot, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  mockGetSession.mockResolvedValue({ user: { id: "user-1", role: "member" } });
  mockGetAgentWithAccess.mockResolvedValue({
    id: "agent-1",
    name: "Smithers",
    pluginConfig: { "pinchy-files": { allowed_paths: [allowedRoot] } },
  });
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

async function callGET(requestedPath: string, extraParams: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/route");
  const url = new URL("http://localhost/api/agents/agent-1/workspace-file");
  url.searchParams.set("path", requestedPath);
  for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
  return GET(new NextRequest(url), {
    params: Promise.resolve({ agentId: "agent-1" }),
  } as unknown as Parameters<typeof GET>[1]);
}

/** Writes a small suppliers workbook and returns its absolute path. */
async function writeWorkbook(dir = allowedRoot, name = "preise.xlsx"): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Suppliers");
  sheet.addRow(["Supplier", "Part", "Price"]);
  for (let i = 1; i <= 6; i++) sheet.addRow([`Acme ${i}`, `P-${i}`, i * 10]);
  const path = join(dir, name);
  await workbook.xlsx.writeFile(path);
  return path;
}

const ROWS = { variant: "rows", sheet: "Suppliers", from: "3", to: "4" };

describe("serving the cited rows", () => {
  it("answers with exactly those rows and the sheet's own labels", async () => {
    const path = await writeWorkbook();

    const res = await callGET(path, ROWS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sheet).toBe("Suppliers");
    expect(body.columns).toEqual(["Supplier", "Part", "Price"]);
    expect(body.rows.map((r: { number: number }) => r.number)).toEqual([3, 4]);
  });

  it("records the read as a view of the document, like any other", async () => {
    // Reading rows IS looking at the document. A second event type would split
    // one act across two filters, and an unaudited one would be a way to read a
    // document without the trail saying so.
    const path = await writeWorkbook();

    await callGET(path, ROWS);

    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.source_viewed");
    expect(entry.outcome).toBe("success");
    expect(entry.detail.document.name).toBe("preise.xlsx");
  });
});

describe("what it refuses", () => {
  it("refuses a workbook outside the agent's granted folders", async () => {
    // The whole point of riding this route: the rows variant cannot become a
    // way around the grant that gates the bytes.
    const path = await writeWorkbook(outsideDir);

    const res = await callGET(path, ROWS);

    expect(res.status).toBe(403);
    expect(mockDeferAuditLog.mock.calls[0][0].outcome).toBe("failure");
  });

  it("rejects a malformed range rather than guessing one", async () => {
    const path = await writeWorkbook();

    for (const bad of [
      { variant: "rows", sheet: "Suppliers", from: "0", to: "4" },
      { variant: "rows", sheet: "Suppliers", from: "5", to: "2" },
      { variant: "rows", sheet: "", from: "1", to: "2" },
      { variant: "rows", sheet: "Suppliers", from: "x", to: "2" },
    ]) {
      expect((await callGET(path, bad)).status).toBe(400);
    }
  });

  it("rejects rows of something that is not a spreadsheet", async () => {
    const { writeFileSync } = await import("node:fs");
    const path = join(allowedRoot, "report.pdf");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(path, Buffer.from("%PDF-1.4\n%%EOF"));

    expect((await callGET(path, ROWS)).status).toBe(400);
  });

  it("still rejects an unknown variant, which this one must not have loosened", async () => {
    const path = await writeWorkbook();

    expect((await callGET(path, { variant: "row" })).status).toBe(400);
  });
});

describe("what it answers rather than failing", () => {
  it("returns an empty range for a sheet the workbook does not have", async () => {
    // The DOCUMENT was found. A citation pointing into a sheet that is not
    // there is exactly what the reader needs to see, and a 404 would read as
    // "the document is missing" instead.
    const path = await writeWorkbook();

    const res = await callGET(path, { ...ROWS, sheet: "Nope" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rows).toEqual([]);
  });

  it("answers 422 for a workbook that will not open, and audits the reason", async () => {
    const { writeFileSync } = await import("node:fs");
    const path = join(allowedRoot, "broken.xlsx");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(path, Buffer.from("not a zip at all"));

    const res = await callGET(path, ROWS);

    expect(res.status).toBe(422);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.outcome).toBe("failure");
    expect(entry.detail.reason).toBe("unreadable_document");
  });
});
