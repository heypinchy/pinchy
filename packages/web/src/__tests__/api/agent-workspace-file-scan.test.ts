/**
 * GET /api/agents/[agentId]/workspace-file — a cited TIFF (#1409).
 *
 * A TIFF is indexed as the PDF it was converted to, one page per frame, and
 * its citations carry those page numbers. So a citation opens that PDF in the
 * same viewer a PDF citation opens, at its page — a browser renders no TIFF,
 * and handing the original to the viewer would turn a preview into a surprise
 * download. The download control still offers the original scan.
 *
 * Same harness as `agent-workspace-file-office.test.ts`, with a real store
 * pointed at the scan directory under a temp artifact root: the route has to
 * derive the key the indexer stored under, in the store the indexer used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

// See the same note in `agent-workspace-file.test.ts`: the production ceiling
// is moved to the temp tree, not switched off.
vi.mock("@/lib/file-serve-roots", async () => {
  const { tmpdir } = await import("node:os");
  return { FILE_SERVE_ROOTS: [tmpdir()] };
});

let tmpRoot: string;
let allowedRoot: string;
let artifactDir: string;

const TIFF_BYTES = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
const SCAN_PDF_BYTES = Buffer.from("%PDF-1.4\nconverted from the scan\n%%EOF");

beforeEach(() => {
  vi.clearAllMocks();
  // The stores read their root at module evaluation and cache one instance
  // per process; both have to be fresh per test.
  vi.resetModules();

  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-workspace-file-scan-"));
  allowedRoot = join(tmpRoot, "allowed");
  artifactDir = join(tmpRoot, "artifacts");
  mkdirSync(allowedRoot, { recursive: true });
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

function writeScan(name: string): string {
  const path = join(allowedRoot, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
  writeFileSync(path, TIFF_BYTES);
  return path;
}

/** Puts the converted PDF where the indexer's scan conversion puts it. */
async function storeScanArtifact(): Promise<void> {
  const { OfficeArtifactStore, SCAN_ARTIFACT_FORMAT_VERSION, scanArtifactDirOf } =
    await import("@/lib/knowledge/office-artifacts");
  const store = new OfficeArtifactStore(scanArtifactDirOf(artifactDir), {
    formatVersion: SCAN_ARTIFACT_FORMAT_VERSION,
  });
  const staged = join(tmpRoot, "staged.pdf");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
  writeFileSync(staged, SCAN_PDF_BYTES);
  await store.put(createHash("sha256").update(TIFF_BYTES).digest("hex"), staged);
}

/** The same bytes' artifact in the OFFICE store, which a scan must never be served from. */
async function storeOfficeArtifact(): Promise<void> {
  const { OfficeArtifactStore } = await import("@/lib/knowledge/office-artifacts");
  const staged = join(tmpRoot, "office-staged.pdf");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
  writeFileSync(staged, Buffer.from("%PDF-1.4\nfrom the office store\n%%EOF"));
  await new OfficeArtifactStore(artifactDir).put(
    createHash("sha256").update(TIFF_BYTES).digest("hex"),
    staged
  );
}

function auditEntries() {
  return mockDeferAuditLog.mock.calls.map(([entry]) => entry as Record<string, unknown>);
}

describe("workspace-file — a cited TIFF", () => {
  it("opens the converted PDF inline, named after the scan", async () => {
    const source = writeScan("Lieferschein 0815.tif");
    await storeScanArtifact();

    const res = await callGET(source);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("content-disposition")).toContain('filename="Lieferschein 0815.pdf"');
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await res.text()).toContain("converted from the scan");
    expect(auditEntries().at(-1)).toMatchObject({
      eventType: "knowledge.source_viewed",
      outcome: "success",
      detail: { document: { name: "Lieferschein 0815.tif" }, representation: "converted" },
    });
  });

  it("does the same for a .tiff", async () => {
    const source = writeScan("certificate.tiff");
    await storeScanArtifact();

    const res = await callGET(source);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("converted from the scan");
  });

  it("reads the scan store, never the Office store under the same key", async () => {
    // Both stores are keyed on the source's content hash. A scan read from the
    // Office store would show whatever an Office conversion of these bytes
    // left there — not the pages its citations count.
    const source = writeScan("scan.tif");
    await storeOfficeArtifact();

    const res = await callGET(source);

    expect(res.status).toBe(404);
    expect(auditEntries().at(-1)).toMatchObject({
      outcome: "failure",
      detail: { reason: "no_converted_artifact" },
    });
  });

  it("answers 404 rather than handing the viewer an unrenderable TIFF", async () => {
    const source = writeScan("scan.tif");

    const res = await callGET(source);

    expect(res.status).toBe(404);
  });

  it("still hands over the original scan when that is what was asked for", async () => {
    const source = writeScan("scan.tif");
    await storeScanArtifact();

    const res = await callGET(source, { download: "1", variant: "original" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/tiff");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-disposition")).toContain('filename="scan.tif"');
  });

  it("offers the converted PDF as a download too", async () => {
    const source = writeScan("scan.tif");
    await storeScanArtifact();

    const res = await callGET(source, { download: "1", variant: "converted" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-disposition")).toContain('filename="scan.pdf"');
  });
});
