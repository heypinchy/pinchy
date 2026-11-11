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
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { format } from "node:util";
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

// Same move for the grant boundary: a grant outside /data is a pre-lockdown
// leftover the route ignores (#1272), and these fixtures live in a temp dir.
vi.mock("@/lib/agent-granted-paths", () => import("@/test-helpers/granted-paths-under-tmpdir"));

// The rows are read in a heap-capped CHILD process, never in the web process:
// exceljs costs ~20× the sheet XML, and this route is reachable by any member,
// uncached. The in-process reader is booby-trapped
// for the whole file, so every 200 below is also proof the read happened in
// the child — which imports the real module, out of this mock's reach.
vi.mock("@/lib/knowledge/xlsx-extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/xlsx-extract")>()),
  readSheetRange: () => {
    throw new Error("readSheetRange ran in the web process");
  },
}));

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
  // The rows are read from a private copy on the artifact volume's staging
  // area (verified-source.ts), never from the share's path.
  process.env.KB_ARTIFACT_DIR = join(tmpRoot, "artifacts");

  mockGetSession.mockResolvedValue({ user: { id: "user-1", role: "member" } });
  mockGetAgentWithAccess.mockResolvedValue({
    id: "agent-1",
    name: "Smithers",
    pluginConfig: { "pinchy-files": { allowed_paths: [allowedRoot] } },
  });
});

afterEach(() => {
  vi.doUnmock(VERIFIED);
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

const VERIFIED = "@/lib/knowledge/verified-source";

/** Records every private copy the route makes; the copies are still made. */
async function watchCopies() {
  const actual = await vi.importActual<typeof import("@/lib/knowledge/verified-source")>(VERIFIED);
  const copy = vi.fn(actual.copyOpenSource);
  vi.doMock(VERIFIED, () => ({ ...actual, copyOpenSource: copy }));
  return copy;
}

/** What turns one log line into two, or reorders one on a terminal. */
const BREAKS_A_LINE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

describe("serving the cited rows", () => {
  it("answers with exactly those rows and the sheet's own labels", async () => {
    const path = await writeWorkbook();

    const res = await callGET(path, ROWS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sheet).toBe("Suppliers");
    expect(body.columns).toEqual(["Supplier", "Part", "Price"]);
    expect(body.rows.map((r: { number: number }) => r.number)).toEqual([3, 4]);
    // Cells arrive index-aligned to `columns`, so the dialog renders them
    // positionally and two columns sharing one header label stay two columns.
    expect(body.rows[0].cells).toEqual(["Acme 2", "P-2", "20"]);
  });

  it("opens at the top of the first sheet when no range is named at all", async () => {
    // A bare workbook citation names no sheet and no rows. That is a request
    // for the top of the workbook — where opening the file itself would land —
    // not a client defect to 400 at.
    const path = await writeWorkbook();

    const res = await callGET(path, { variant: "rows" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sheet).toBe("Suppliers");
    expect(body.rows[0].number).toBe(2);
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
    // Which representation left is a separate question from whether one did —
    // same field the byte-serving path records ("original"/"converted").
    expect(entry.detail.representation).toBe("rows");
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

    const badRanges: Array<Record<string, string>> = [
      { variant: "rows", sheet: "Suppliers", from: "0", to: "4" },
      { variant: "rows", sheet: "Suppliers", from: "5", to: "2" },
      { variant: "rows", sheet: "", from: "1", to: "2" },
      { variant: "rows", sheet: "Suppliers", from: "x", to: "2" },
      // A partial range is a typo, not a request for the top of the workbook:
      // only naming NOTHING means that.
      { variant: "rows", sheet: "Suppliers" },
      { variant: "rows", from: "1", to: "2" },
    ];
    for (const bad of badRanges) {
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

    const res = await callGET(path, { variant: "row" });

    expect(res.status).toBe(400);
    // The refusal names every variant that exists, so the client with a typo
    // learns the real choices rather than a stale pair.
    expect((await res.json()).error).toContain("rows");
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

  it("answers 413 for a compressed-bomb workbook instead of inflating it, and audits the reason", async () => {
    // Any member with agent access can ask for this, uncached and as often as
    // they like, and exceljs would inflate the declared 4 GB into the web
    // server's heap. The refusal is read off the central directory.
    const { writeFileSync } = await import("node:fs");
    const { declaredBomb } = await import("@/test-helpers/office-zip");
    const path = join(allowedRoot, "bomb.xlsx");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(path, declaredBomb(0xfffffffe));

    const res = await callGET(path, ROWS);

    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large to read/i);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.outcome).toBe("failure");
    expect(entry.detail.reason).toBe("document_too_large");
  });

  it("answers 413 for a workbook past the reader's limit without copying it, and audits the reason", async () => {
    // The reader refuses it unopened anyway. Copying it first would write the
    // whole file to the staging volume on every reload — and on a volume too
    // full to take it, answer "reader unavailable" about a workbook that is
    // simply too large.
    const { truncateSync } = await import("node:fs");
    const { XLSX_MAX_FILE_BYTES } = await import("@/lib/knowledge/office-preflight");
    const path = join(allowedRoot, "huge.xlsx");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    truncateSync(await writeWorkbook(allowedRoot, "huge.xlsx"), XLSX_MAX_FILE_BYTES + 1);
    const copy = await watchCopies();

    const res = await callGET(path, ROWS);

    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large to read/i);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.outcome).toBe("failure");
    expect(entry.detail.reason).toBe("document_too_large");
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies a workbook at most one byte past the reader's limit, so one still being written cannot outgrow it", async () => {
    const { XLSX_MAX_FILE_BYTES } = await import("@/lib/knowledge/office-preflight");
    const path = await writeWorkbook();
    const copy = await watchCopies();

    expect((await callGET(path, ROWS)).status).toBe(200);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0][3]).toEqual({ maxBytes: XLSX_MAX_FILE_BYTES + 1 });
  });
});

describe("when the reader is the problem, not the workbook", () => {
  // The rows are read in a child process (xlsx-isolated.ts). A child that
  // could not be started (tsx missing, EAGAIN/ENOMEM on fork), was killed by
  // the system, or timed out says nothing about THIS workbook — answering
  // 422 and auditing `unreadable_document` would put a false statement about
  // the document into an immutable row. Those answer 503, audited as the
  // reader being unavailable.
  const READER = "@/lib/knowledge/xlsx-isolated";

  type Reader = typeof import("@/lib/knowledge/xlsx-isolated");

  /** Replaces the reader with one that throws what `failure` makes — ONE doMock per test, so no factory can win a race against another. */
  async function readerFails(failure: (actual: Reader) => Error) {
    const actual = await vi.importActual<Reader>(READER);
    const read = vi.fn(async () => {
      throw failure(actual);
    });
    vi.doMock(READER, () => ({ ...actual, readSheetRangeIsolated: read }));
    return { actual, read };
  }

  afterEach(() => {
    vi.doUnmock(READER);
  });

  it("answers 503 for a reader that could not be started, and does not blame the document", async () => {
    const path = await writeWorkbook();
    await readerFails(() => new Error("the spreadsheet reader could not be started"));

    const res = await callGET(path, ROWS);

    expect(res.status).toBe(503);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.outcome).toBe("failure");
    expect(entry.detail.reason).toBe("reader_unavailable");
  });

  it("logs a failed reader as one line, whatever the workbook's name and the error hold", async () => {
    // The name is whoever put the file on the share's choice, newlines
    // included, and the reader's error can quote it. Neither may write a line
    // of its own into the server log an admin reads.
    const planted = "Preise\n[workspace-file] spreadsheet reader failed for FORGED.xlsx";
    const path = await writeWorkbook(allowedRoot, planted);
    await readerFails(
      () =>
        new Error(`the spreadsheet reader could not be started for ${planted}\n${"Q".repeat(5000)}`)
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await callGET(path, ROWS);

      expect(res.status).toBe(503);
      expect(consoleError).toHaveBeenCalledTimes(1);
      const printed = format(...consoleError.mock.calls[0]);
      expect(printed).not.toMatch(BREAKS_A_LINE);
      expect(printed.length).toBeLessThan(4000);
      expect(printed).toContain("Preise\\n[workspace-file] spreadsheet reader failed for FORGED");
      expect(printed).toContain("could not be started");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("answers 503 with a Retry-After when previews are already queued, and says so in the audit", async () => {
    const path = await writeWorkbook();
    await readerFails((actual) => new actual.SheetReaderBusyError(2));

    const res = await callGET(path, ROWS);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(mockDeferAuditLog.mock.calls[0][0].detail.reason).toBe("reader_busy");
  });

  it("turns a preview away before copying the workbook when the queue is already full", async () => {
    // Every request would otherwise copy the workbook first and learn it was
    // busy afterwards: reloads stacking copies on the staging volume for
    // reads that never happen.
    const path = await writeWorkbook();
    const actual = await vi.importActual<Reader>(READER);
    const read = vi.fn(actual.readSheetRangeIsolated);
    vi.doMock(READER, () => ({
      ...actual,
      checkSheetReaderQueue: () => {
        throw new actual.SheetReaderBusyError(2);
      },
      readSheetRangeIsolated: read,
    }));
    const copy = await watchCopies();

    const res = await callGET(path, ROWS);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(mockDeferAuditLog.mock.calls[0][0].detail.reason).toBe("reader_busy");
    expect(copy).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("records a read its requester abandoned as cancelled, not as a fault of the document", async () => {
    const path = await writeWorkbook();
    await readerFails((actual) => new actual.SheetReaderCancelledError());

    const res = await callGET(path, ROWS);

    expect(res.status).toBe(499);
    expect(mockDeferAuditLog.mock.calls[0][0].detail.reason).toBe("cancelled");
  });

  it("hands the reader the request's signal and the preview queue limit", async () => {
    const path = await writeWorkbook();
    const { actual, read } = await readerFails(() => new Error("unused: resolved below"));
    read.mockResolvedValue({ sheet: "Suppliers", columns: [], rows: [] } as never);

    // The request's OWN signal: aborting the request must reach the reader.
    const client = new AbortController();
    const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/route");
    const url = new URL("http://localhost/api/agents/agent-1/workspace-file");
    url.searchParams.set("path", path);
    for (const [key, value] of Object.entries(ROWS)) url.searchParams.set(key, value);
    const res = await GET(new NextRequest(url, { signal: client.signal }), {
      params: Promise.resolve({ agentId: "agent-1" }),
    } as unknown as Parameters<typeof GET>[1]);

    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledWith(expect.any(String), "Suppliers", 3, 4, {
      signal: expect.any(AbortSignal),
      maxQueued: actual.SHEET_PREVIEW_MAX_QUEUED,
    });
    // The reader is handed the private copy streamed from the verified open,
    // under the source's name on the artifact volume — never the share's path
    // — and the copy is gone once it answered.
    const handed = (read.mock.calls[0] as unknown[])[0] as string;
    expect(handed).not.toBe(realpathSync(path));
    expect(basename(handed)).toBe(basename(path));
    expect(handed.startsWith(join(process.env.KB_ARTIFACT_DIR!, "staging") + sep)).toBe(true);
    expect(existsSync(handed)).toBe(false);
    const passed = (read.mock.calls[0] as unknown[])[4] as { signal: AbortSignal };
    expect(passed.signal.aborted).toBe(false);
    client.abort();
    expect(passed.signal.aborted).toBe(true);
  });
});

describe("a legacy .xls workbook (#1373)", () => {
  // exceljs cannot parse BIFF, so the indexer reads a legacy workbook through
  // the `.xlsx` the converter made of it. A citation into it points at sheet
  // and rows of THAT workbook, so the preview has to read the same one — and
  // never the `.xls` itself, which would answer 422 for every cited row.
  const LEGACY_XLS = join(__dirname, "../fixtures/kb/office/legacy-workbook.xls");

  async function writeLegacySource(name = "preise.xls"): Promise<{ path: string; bytes: Buffer }> {
    const { readFileSync, writeFileSync } = await import("node:fs");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in fixture
    const bytes = readFileSync(LEGACY_XLS);
    const path = join(allowedRoot, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(path, bytes);
    return { path, bytes };
  }

  /** Stores a converted workbook under the source's content key, as the converter does. */
  async function storeConvertedWorkbook(sourceBytes: Buffer): Promise<string> {
    const { createHash } = await import("node:crypto");
    const { OfficeArtifactStore } = await import("@/lib/knowledge/office-artifacts");
    const staged = await writeWorkbook(tmpRoot, "converted.xlsx");
    return new OfficeArtifactStore(join(tmpRoot, "artifacts")).put(
      createHash("sha256").update(sourceBytes).digest("hex"),
      staged,
      ".xlsx"
    );
  }

  it("answers with the cited rows of the workbook it was converted into", async () => {
    const { path, bytes } = await writeLegacySource();
    await storeConvertedWorkbook(bytes);
    const copy = await watchCopies();

    const res = await callGET(path, ROWS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sheet).toBe("Suppliers");
    expect(body.rows.map((r: { number: number }) => r.number)).toEqual([3, 4]);
    // The artifact is the store's own file, so there is nothing to copy off
    // the share — the `.xls` is opened only to be hashed.
    expect(copy).not.toHaveBeenCalled();
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.source_viewed");
    expect(entry.outcome).toBe("success");
    // The SOURCE's name, as for every converted representation.
    expect(entry.detail.document.name).toBe("preise.xls");
    expect(entry.detail.representation).toBe("rows");
  });

  it("answers 404 while the workbook has not been converted, and audits why", async () => {
    // Not 422: nothing is wrong with the document, the indexer simply has not
    // got to it (or the converter refused it). The original download stays
    // available either way.
    const { path } = await writeLegacySource();

    const res = await callGET(path, ROWS);

    expect(res.status).toBe(404);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.outcome).toBe("failure");
    expect(entry.detail.reason).toBe("no_converted_artifact");
  });

  it("does not read a converted PDF of the same bytes as the workbook", async () => {
    // The format is part of the artifact's name: a `.doc` renamed to `.xls`
    // hashes the same, and its PDF is not a workbook.
    const { createHash } = await import("node:crypto");
    const { writeFileSync } = await import("node:fs");
    const { OfficeArtifactStore } = await import("@/lib/knowledge/office-artifacts");
    const { path, bytes } = await writeLegacySource();
    const staged = join(tmpRoot, "staged.pdf");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(staged, Buffer.from("%PDF-1.4\n%%EOF"));
    await new OfficeArtifactStore(join(tmpRoot, "artifacts")).put(
      createHash("sha256").update(bytes).digest("hex"),
      staged
    );

    expect((await callGET(path, ROWS)).status).toBe(404);
  });
});
