import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { streamWorkspaceFile } from "@/lib/serve-workspace-file";
// Real xlsx bytes from the actual renderer used by pinchy_generate_file (#788),
// not a hand-faked MIME — proves the serve route accepts what the plugin
// really produces. Cross-package relative import: this file's own
// `fileTypeFromBuffer`/exceljs imports resolve from each module's own
// location, which is exactly how packages/plugins/pinchy-* tests already run
// inside the web vitest process (see vitest.config.ts's plugin include glob).
import { generateFile } from "../../../../plugins/pinchy-files/generate-file";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-serve-workspace-file-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("streamWorkspaceFile xlsx support (#788)", () => {
  it("serves a real exceljs-generated xlsx with the ooxml spreadsheet content-type", async () => {
    const { buffer } = await generateFile({
      format: "xlsx",
      title: "Bookings",
      columns: ["Date", "Amount"],
      rows: [["2026-01-03", 1200.5]],
    });
    const path = join(tmpRoot, "report.xlsx");
    writeFileSync(path, buffer);

    const res = await streamWorkspaceFile(path, "report.xlsx");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(buffer)).toBe(true);
  });

  it("still rejects a real docx (also an ooxml zip container) with 415 — proves xlsx support wasn't widened to all zips", async () => {
    // Fixture is a real docx produced by the `docx` package, not a fake — see
    // packages/plugins/pinchy-files/generate-docx-fixtures.ts. Both xlsx and
    // docx are zip containers, but file-type content-sniffs the internal
    // OOXML parts and returns distinct MIME types for each, so allowlisting
    // only the spreadsheet MIME does not accidentally let word documents
    // (or any other zip) through this route.
    const docxBuffer = readFileSync(
      join(__dirname, "../../../../plugins/pinchy-files/test-fixtures/simple.docx")
    );
    const path = join(tmpRoot, "report.docx");
    writeFileSync(path, docxBuffer);

    const res = await streamWorkspaceFile(path, "report.docx");

    expect(res.status).toBe(415);
  });
});
