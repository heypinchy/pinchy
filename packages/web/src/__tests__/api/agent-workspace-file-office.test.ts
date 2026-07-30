/**
 * GET /api/agents/[agentId]/workspace-file — the Office half (#939).
 *
 * A cited `.doc`/`.docx`/`.ppt`/`.pptx` opens in the SAME viewer as a PDF,
 * showing the converted artifact (#936), while the download control still
 * offers the original — the file on the reader's drive, the one they send a
 * customer.
 *
 * The containment question is re-reasoned rather than reused, because the
 * artifact store sits OUTSIDE `/data`: `resolveAllowedFile` still runs against
 * the original path, and the artifact path is derived from the store's
 * content key, never from the request. The first two describes below are that
 * argument written as tests — an artifact must be unreachable for a document
 * the agent may not read, and an artifact belonging to a superseded version of
 * a document must not be served as if it were current.
 *
 * Same harness as `agent-workspace-file.test.ts` (real filesystem, mocked
 * auth/agent-access/audit), plus a real `OfficeArtifactStore` pointed at a temp
 * directory: the route has to derive the SAME key the converter stored under,
 * and a mocked store would assert nothing about that.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest, NextResponse } from "next/server";

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

// The production ceiling is a container mount point no test can create, so it
// is MOVED to the temp tree rather than switched off — every assertion below
// still runs against a real one. See the same note in
// `agent-workspace-file.test.ts`.
vi.mock("@/lib/file-serve-roots", async () => {
  const { tmpdir } = await import("node:os");
  return { FILE_SERVE_ROOTS: [tmpdir()] };
});

let tmpRoot: string;
let allowedRoot: string;
let outsideDir: string;
let artifactDir: string;

const DOCX_BYTES = Buffer.from("PK pretend this is a .docx\n");
const ARTIFACT_BYTES = Buffer.from("%PDF-1.4\nconverted from the office source\n%%EOF");

beforeEach(() => {
  vi.clearAllMocks();
  // The artifact store reads its root at module evaluation, and caches one
  // instance per process. Both have to be fresh per test, or the second test
  // writes into the first one's (already deleted) directory.
  vi.resetModules();

  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-workspace-file-office-"));
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

async function callGET(requestedPath: string, extraParams: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/route");
  const url = new URL("http://localhost/api/agents/agent-1/workspace-file");
  url.searchParams.set("path", requestedPath);
  for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
  return GET(new NextRequest(url), {
    params: Promise.resolve({ agentId: "agent-1" }),
  } as unknown as Parameters<typeof GET>[1]);
}

/** Writes an Office source and returns its absolute path. */
function writeSource(name: string, bytes: Buffer = DOCX_BYTES): string {
  const path = join(allowedRoot, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
  writeFileSync(path, bytes);
  return path;
}

/**
 * Puts `pdfBytes` in the store under the key for `sourceBytes`, exactly as a
 * finished conversion does. Uses the real store, so what is asserted is that
 * the route derives the same key — not that a mock was called.
 */
async function storeArtifactFor(sourceBytes: Buffer, pdfBytes = ARTIFACT_BYTES): Promise<string> {
  const { OfficeArtifactStore } = await import("@/lib/knowledge/office-artifacts");
  const store = new OfficeArtifactStore(artifactDir);
  const staged = join(tmpRoot, `staged-${createHash("sha256").digest("hex").slice(0, 8)}.pdf`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
  writeFileSync(staged, pdfBytes);
  return store.put(createHash("sha256").update(sourceBytes).digest("hex"), staged);
}

function auditEntries() {
  return mockDeferAuditLog.mock.calls.map(([entry]) => entry as Record<string, unknown>);
}

describe("workspace-file — an artifact is only as reachable as its source", () => {
  it("refuses the converted preview of a document outside the agent's allowed paths", async () => {
    // The artifact EXISTS and is perfectly readable on disk. The only thing
    // standing between a caller and its bytes is that the source it was
    // converted from is not something this agent may read — which is the whole
    // reason the artifact path is derived from the source rather than asked
    // for.
    const outsideDoc = join(outsideDir, "payroll.docx");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(outsideDoc, DOCX_BYTES);
    await storeArtifactFor(DOCX_BYTES);

    const res = await callGET(outsideDoc);

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("converted from the office source");
  });

  it("refuses it for a traversal that lexically escapes the allowed root", async () => {
    const outsideDoc = join(outsideDir, "payroll.docx");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(outsideDoc, DOCX_BYTES);
    await storeArtifactFor(DOCX_BYTES);

    const res = await callGET(join(allowedRoot, "..", "outside", "payroll.docx"));

    expect(res.status).toBe(403);
  });

  it("records the refusal as a refusal to view, not as a missing artifact", async () => {
    const outsideDoc = join(outsideDir, "payroll.docx");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(outsideDoc, DOCX_BYTES);
    await storeArtifactFor(DOCX_BYTES);

    await callGET(outsideDoc);

    expect(auditEntries()[0]).toMatchObject({
      eventType: "knowledge.source_viewed",
      outcome: "failure",
      detail: { reason: "outside_allowed_paths" },
    });
  });
});

describe("workspace-file — a stale artifact is not served", () => {
  it("stops serving the old PDF once the source has changed", async () => {
    const source = writeSource("angebot.docx");
    await storeArtifactFor(DOCX_BYTES);
    expect((await callGET(source)).status).toBe(200);

    // The operator replaced the document on the read-only share and nothing has
    // reconverted it yet. The artifact for the OLD bytes is still on the
    // volume — and it now describes a document that no longer exists.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(source, Buffer.from("PK a different offer entirely\n"));

    const res = await callGET(source);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("converted from the office source");
  });

  it("serves the new PDF as soon as the conversion catches up", async () => {
    const source = writeSource("angebot.docx");
    const newBytes = Buffer.from("PK a different offer entirely\n");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(source, newBytes);
    await storeArtifactFor(newBytes, Buffer.from("%PDF-1.4\nthe new offer\n%%EOF"));

    const res = await callGET(source);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("the new offer");
  });

  it("answers 404 rather than handing over the unrenderable original", async () => {
    // Nothing has been converted yet (#938 wires the indexer). Serving the
    // .docx instead would be worse than nothing: it is served `attachment`, so
    // the viewer's <embed> would trigger a surprise download rather than show
    // a document.
    const source = writeSource("angebot.docx");

    const res = await callGET(source);

    expect(res.status).toBe(404);
    expect(auditEntries().at(-1)).toMatchObject({
      outcome: "failure",
      detail: { reason: "no_converted_artifact" },
    });
  });
});

describe("workspace-file — the Office preview", () => {
  it("renders the converted PDF in the same viewer a PDF citation opens", async () => {
    const source = writeSource("angebot.docx");
    await storeArtifactFor(DOCX_BYTES);

    const res = await callGET(source);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    // Without this the <embed> gets a blank pane: next.config.ts's global DENY
    // wins unless the route declares the relaxation (#703/#788).
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("converted from the office source");
  });

  it("lets the viewer seek, so a citation opens at its page instead of pulling the whole document", async () => {
    const source = writeSource("angebot.docx");
    await storeArtifactFor(DOCX_BYTES);

    const res = await callGET(source);

    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(ARTIFACT_BYTES.length));
  });

  it("names the served file after the document, carrying the format it is in", async () => {
    const source = writeSource("Angebot Herbst.docx");
    await storeArtifactFor(DOCX_BYTES);

    const res = await callGET(source);

    expect(res.headers.get("content-disposition")).toContain('filename="Angebot Herbst.pdf"');
  });

  it("audits the view under the document's own name, not the artifact's hash", async () => {
    // The artifact is named for its content key; an audit row saying
    // `3f9a2c….pdf` names nothing an analyst can act on.
    const source = writeSource("angebot.docx");
    await storeArtifactFor(DOCX_BYTES);

    await callGET(source);

    expect(auditEntries().at(-1)).toMatchObject({
      eventType: "knowledge.source_viewed",
      outcome: "success",
      detail: { document: { name: "angebot.docx" }, representation: "converted" },
    });
  });

  it("leaves a PDF citation exactly as it was", async () => {
    const pdf = writeSource("handbook.pdf", Buffer.from("%PDF-1.4\nthe original pdf\n%%EOF"));

    const res = await callGET(pdf);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("the original pdf");
    expect(auditEntries().at(-1)).toMatchObject({ detail: { representation: "original" } });
  });
});

describe("workspace-file — both downloads", () => {
  it("hands over the original when that is what was asked for", async () => {
    const source = writeSource("angebot.docx");
    await storeArtifactFor(DOCX_BYTES);

    const res = await callGET(source, { download: "1", variant: "original" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-disposition")).toContain('filename="angebot.docx"');
    expect(await res.text()).toContain("pretend this is a .docx");
  });

  it("types a slide deck as a slide deck, not as anonymous bytes", async () => {
    // `buildSourceDownloads` offers an original for every format in
    // OFFICE_EXTENSIONS, so every one of them reaches this route as a download.
    // `.ppt`/`.pptx` were missing from the content-type table, which is not a
    // security hole (unknown types are served `attachment` either way) but does
    // hand the reader `application/octet-stream` — a file their OS opens with a
    // shrug instead of with PowerPoint.
    const source = writeSource("Bericht.pptx");

    const res = await callGET(source, { download: "1", variant: "original" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("hands over the converted PDF under a name that tells the two apart", async () => {
    const source = writeSource("angebot.docx");
    await storeArtifactFor(DOCX_BYTES);

    const res = await callGET(source, { download: "1", variant: "converted" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-disposition")).toContain('filename="angebot.pdf"');
    expect(await res.text()).toContain("converted from the office source");
  });

  it("records which of the two left the building", async () => {
    const source = writeSource("angebot.docx");
    await storeArtifactFor(DOCX_BYTES);

    await callGET(source, { download: "1", variant: "original" });
    await callGET(source, { download: "1", variant: "converted" });

    expect(auditEntries().map((entry) => entry.eventType)).toEqual([
      "knowledge.source_downloaded",
      "knowledge.source_downloaded",
    ]);
    expect(
      auditEntries().map((entry) => (entry.detail as { representation: string }).representation)
    ).toEqual(["original", "converted"]);
  });

  it("keeps the original readable even before anything has been converted", async () => {
    // The download affordance (#934) must not start depending on a conversion
    // that may have failed or not run yet.
    const source = writeSource("angebot.docx");

    const res = await callGET(source, { download: "1", variant: "original" });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pretend this is a .docx");
  });

  it("refuses a converted download for a format nothing converts", async () => {
    // A `.pdf` has no converted representation, and answering with the file
    // itself would make `variant` mean something different per format.
    const pdf = writeSource("handbook.pdf", Buffer.from("%PDF-1.4\nthe original pdf\n%%EOF"));

    const res = await callGET(pdf, { download: "1", variant: "converted" });

    expect(res.status).toBe(404);
  });

  it("rejects a variant it does not know rather than guessing at one", async () => {
    const source = writeSource("angebot.docx");
    await storeArtifactFor(DOCX_BYTES);

    const res = await callGET(source, { variant: "somethingelse" });

    expect(res.status).toBe(400);
  });

  it("still refuses both variants for a document outside the allowed paths", async () => {
    const outsideDoc = join(outsideDir, "payroll.docx");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
    writeFileSync(outsideDoc, DOCX_BYTES);
    await storeArtifactFor(DOCX_BYTES);

    expect((await callGET(outsideDoc, { download: "1", variant: "original" })).status).toBe(403);
    expect((await callGET(outsideDoc, { download: "1", variant: "converted" })).status).toBe(403);
  });
});

describe("workspace-file — the artifact volume is not a failure of the document", () => {
  it("answers 404 rather than 500 when the store is unusable", async () => {
    // A missing or unwritable artifact volume is an infrastructure fault. It
    // must not surface as a stack trace on a request for a document that is
    // perfectly fine — and it must not take the ORIGINAL download down with it.
    process.env.KB_ARTIFACT_DIR = join(tmpRoot, "allowed", "angebot.docx", "not-a-directory");
    const source = writeSource("angebot.docx");

    const res = await callGET(source);

    expect(res.status).toBe(404);
    expect(res).toBeInstanceOf(NextResponse);
  });
});
