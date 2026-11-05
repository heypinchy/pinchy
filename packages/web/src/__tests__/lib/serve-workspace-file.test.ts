import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { streamWorkspaceFile as serve } from "@/lib/serve-workspace-file";

/** Unconditional GET unless headers say otherwise. */
function streamWorkspaceFile(path: string, name: string, headers?: HeadersInit) {
  return serve(path, name, new Request("http://localhost/file", { headers }));
}
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

describe("streamWorkspaceFile refuses to follow a symlink", () => {
  // The helper's contract is that the caller has already resolved symlinks and
  // checked containment on the RESULT. A doc comment saying so protects
  // nothing; O_NOFOLLOW makes it a check. A caller that passes the requested
  // path instead of the resolved one would otherwise re-follow the link here,
  // against whatever it points at by then — which is the whole defect the
  // containment check in the uploads/artifacts routes exists to close.
  it("returns 404 for a symlink even when its target is perfectly servable", async () => {
    const target = join(tmpRoot, "real.pdf");
    writeFileSync(target, Buffer.from("%PDF-1.4\n" + "\x00".repeat(128)));
    const link = join(tmpRoot, "link.pdf");
    symlinkSync(target, link);

    // The target itself serves fine — so a 404 for the link is the flag doing
    // its job, not an unservable fixture.
    expect((await streamWorkspaceFile(target, "real.pdf")).status).toBe(200);
    expect((await streamWorkspaceFile(link, "link.pdf")).status).toBe(404);
  });
});

describe("streamWorkspaceFile caching (#1286)", () => {
  it("keys its browser cache to the session, so a file cached for one user is not served to the next", async () => {
    // Artifacts and uploads are per-agent, access-checked files. The browser
    // keys its cache by URL; Vary: Cookie makes a different session a miss,
    // so the request reaches the access check again.
    const path = join(tmpRoot, "notes.txt");
    writeFileSync(path, "hello");

    const res = await streamWorkspaceFile(path, "notes.txt");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("etag")).toMatch(/^W\/"[^"]+"$/);
  });

  it("answers an unchanged file with 304 and no body, so a reuse costs a round trip, not the bytes", async () => {
    const path = join(tmpRoot, "notes.txt");
    writeFileSync(path, "hello");
    const etag = (await streamWorkspaceFile(path, "notes.txt")).headers.get("etag")!;

    const res = await streamWorkspaceFile(path, "notes.txt", { "if-none-match": etag });

    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toBe("Cookie");
  });

  it("gives the same bytes served as a different type a different validator", async () => {
    // Same file, served under a name that makes it CSV rather than text: the
    // browser must not keep the text copy's content-type on a 304.
    const path = join(tmpRoot, "notes.txt");
    writeFileSync(path, "a,b\n1,2\n");
    const asText = (await streamWorkspaceFile(path, "notes.txt")).headers.get("etag")!;

    const res = await streamWorkspaceFile(path, "notes.csv", { "if-none-match": asText });

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(asText);
  });

  it("sends the new bytes when the file changed since it was cached", async () => {
    const path = join(tmpRoot, "notes.txt");
    writeFileSync(path, "hello");
    const etag = (await streamWorkspaceFile(path, "notes.txt")).headers.get("etag")!;
    writeFileSync(path, "hello, revised");

    const res = await streamWorkspaceFile(path, "notes.txt", { "if-none-match": etag });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello, revised");
  });

  it("still refuses an unservable file with 415 even when the request is conditional", async () => {
    const path = join(tmpRoot, "binary.txt");
    writeFileSync(path, Buffer.from([0x68, 0x00, 0x69]));

    const res = await streamWorkspaceFile(path, "binary.txt", { "if-none-match": "*" });

    expect(res.status).toBe(415);
  });
});
