/**
 * GET /api/agents/[agentId]/workspace-file/[name] — the citation viewer's url (#1268).
 *
 * A browser's built-in PDF viewer titles a document after the last path
 * segment of its url when the file carries no title of its own. For every
 * citation that segment was the ROUTE, so the viewer announced
 * "workspace-file" above a reader's document. The viewer now asks for
 * `…/workspace-file/<name>?path=…`, and the name is what the toolbar shows.
 *
 * The name is presentation, never selection: `path` alone decides which file
 * is read, through the same containment and the same audit as the bare route.
 * What the name may NOT do is lie — a url that titles one document while
 * serving another would put a false name in front of a reader checking a
 * claim — so a name that is not the name of the bytes being served is a 404.
 *
 * Same harness as `agent-workspace-file-office.test.ts`: real filesystem, a
 * real artifact store in a temp directory, mocked auth/agent-access/audit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({ getSession: (...args: unknown[]) => mockGetSession(...args) }));

const mockGetAgentWithAccess = vi.fn();
vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: (...args: unknown[]) => mockGetAgentWithAccess(...args),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockDeferAuditLog = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
}));

vi.mock("@/lib/file-serve-roots", async () => {
  const { tmpdir } = await import("node:os");
  return { FILE_SERVE_ROOTS: [tmpdir()] };
});

let tmpRoot: string;
let allowedRoot: string;
let outsideDir: string;
let artifactDir: string;

const PDF_BYTES = Buffer.from("%PDF-1.4\na cited document\n%%EOF");
const DOCX_BYTES = Buffer.from("PK pretend this is a .docx\n");
const ARTIFACT_BYTES = Buffer.from("%PDF-1.4\nconverted from the office source\n%%EOF");

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();

  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-workspace-file-named-"));
  allowedRoot = join(tmpRoot, "allowed");
  outsideDir = join(tmpRoot, "outside");
  artifactDir = join(tmpRoot, "artifacts");
  mkdirSync(allowedRoot, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
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

async function callNamedGET(
  name: string,
  requestedPath: string,
  extraParams: Record<string, string> = {}
) {
  const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/[name]/route");
  const url = new URL(
    `http://localhost/api/agents/agent-1/workspace-file/${encodeURIComponent(name)}`
  );
  url.searchParams.set("path", requestedPath);
  for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
  return GET(new NextRequest(url), {
    // Next.js 16 hands a dynamic segment over decoded; the handler reads the
    // name from the url anyway (see the "reading the name" describe).
    params: Promise.resolve({ agentId: "agent-1", name }),
  } as unknown as Parameters<typeof GET>[1]);
}

function writeFile(dir: string, name: string, bytes: Buffer): string {
  const path = join(dir, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
  writeFileSync(path, bytes);
  return path;
}

async function storeArtifactFor(sourceBytes: Buffer, pdfBytes = ARTIFACT_BYTES): Promise<void> {
  const { OfficeArtifactStore } = await import("@/lib/knowledge/office-artifacts");
  const store = new OfficeArtifactStore(artifactDir);
  const staged = join(tmpRoot, "staged.pdf");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
  writeFileSync(staged, pdfBytes);
  await store.put(createHash("sha256").update(sourceBytes).digest("hex"), staged);
}

function auditEntries() {
  return mockDeferAuditLog.mock.calls.map(([entry]) => entry as Record<string, unknown>);
}

describe("workspace-file/[name] — the url a viewer titles the document by", () => {
  it("serves a cited PDF under its own name, embeddable like the bare route", async () => {
    const doc = writeFile(allowedRoot, "Prüfbericht Nr. 5.pdf", PDF_BYTES);

    const res = await callNamedGET("Prüfbericht Nr. 5.pdf", doc);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF_BYTES);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("serves an Office source's preview under the name of the PDF it shows", async () => {
    const doc = writeFile(allowedRoot, "Vorlage_Wartung.docx", DOCX_BYTES);
    await storeArtifactFor(DOCX_BYTES);

    const res = await callNamedGET("Vorlage_Wartung.pdf", doc);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(ARTIFACT_BYTES);
  });

  it("audits the view exactly like the bare route does", async () => {
    const doc = writeFile(allowedRoot, "report.pdf", PDF_BYTES);

    await callNamedGET("report.pdf", doc);

    expect(auditEntries()).toEqual([
      expect.objectContaining({
        eventType: "knowledge.source_viewed",
        outcome: "success",
        detail: expect.objectContaining({ document: { name: "report.pdf" } }),
      }),
    ]);
  });
});

describe("workspace-file/[name] — reading the name", () => {
  it("reads it from the url, whatever shape the framework hands the param in", async () => {
    // The comparison must not hinge on whether a dynamic param arrives decoded:
    // if it did not, every name with a space or an umlaut would 404 and blank
    // the viewer. The url's own last segment, decoded once, is the name.
    const doc = writeFile(allowedRoot, "Angebot Müller.pdf", PDF_BYTES);
    const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/[name]/route");
    const url = new URL(
      `http://localhost/api/agents/agent-1/workspace-file/${encodeURIComponent("Angebot Müller.pdf")}`
    );
    url.searchParams.set("path", doc);

    const res = await GET(new NextRequest(url), {
      params: Promise.resolve({
        agentId: "agent-1",
        name: encodeURIComponent("Angebot Müller.pdf"),
      }),
    } as unknown as Parameters<typeof GET>[1]);

    expect(res.status).toBe(200);
  });
});

describe("workspace-file/[name] — a grant that is a link to a single file", () => {
  it("accepts the name the citation knows, not only the name the link resolves to", () => {
    // A grant may point at one file through a link ("a share mounted elsewhere
    // is a normal way to set one up", ingest.ts). The citation — and so the
    // viewer url — carries the LINK's name; the bytes resolve to the target's.
    // Both name the same document, and refusing the first would blank a
    // citation that opened before the viewer url carried a name.
    const target = writeFile(outsideDir, "Handbook_v7.pdf", PDF_BYTES);
    const link = join(allowedRoot, "handbook.pdf");
    symlinkSync(target, link);
    mockGetAgentWithAccess.mockResolvedValue({
      id: "agent-1",
      name: "Smithers",
      pluginConfig: { "pinchy-files": { allowed_paths: [link] } },
    });

    return callNamedGET("handbook.pdf", link).then((res) => {
      expect(res.status).toBe(200);
    });
  });
});

describe("workspace-file/[name] — a name that does not name the served bytes", () => {
  it("is refused when it only matches after a second decode", async () => {
    // The framework has already decoded the segment once. Decoding again would
    // let `a%2520b.pdf` stand for `a b.pdf` — a name the viewer would title as
    // `a%20b.pdf`, i.e. not the document's name.
    const doc = writeFile(allowedRoot, "a b.pdf", PDF_BYTES);

    // The url segment is `a%2520b.pdf`; decoded once that is `a%20b.pdf`.
    const res = await callNamedGET("a%20b.pdf", doc);

    expect(res.status).toBe(404);
  });

  it("is a 404, so no url can title one document while serving another", async () => {
    const doc = writeFile(allowedRoot, "salaries.pdf", PDF_BYTES);

    const res = await callNamedGET("canteen-menu.pdf", doc);

    expect(res.status).toBe(404);
    expect(auditEntries()).toEqual([
      expect.objectContaining({
        eventType: "knowledge.source_viewed",
        outcome: "failure",
        detail: expect.objectContaining({ reason: "name_mismatch" }),
      }),
    ]);
  });

  it("refuses the Office original's name on a url that serves its converted PDF", async () => {
    // The preview's bytes are a PDF. A `.docx` name on them would title a PDF
    // as a Word document — the representation the reader is looking at has to
    // be the one the url names.
    const doc = writeFile(allowedRoot, "Vorlage_Wartung.docx", DOCX_BYTES);
    await storeArtifactFor(DOCX_BYTES);

    const res = await callNamedGET("Vorlage_Wartung.docx", doc);

    expect(res.status).toBe(404);
  });

  it("still answers 403 for a path outside the grant, whatever the name", async () => {
    // The access decision comes first and does not depend on the name: a
    // probe must not learn anything from varying it.
    const doc = writeFile(outsideDir, "payroll.pdf", PDF_BYTES);

    const res = await callNamedGET("payroll.pdf", doc);

    expect(res.status).toBe(403);
  });
});
