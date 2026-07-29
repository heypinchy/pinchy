/**
 * GET /api/agents/[agentId]/workspace-file — access-controlled serve of a
 * file under an agent's `pinchy-files` allowed_paths (KB citation source
 * PDFs today; the shared "agent, give me file X" mechanism later).
 *
 * Security-critical (file-exfiltration surface), so these tests lead with
 * the containment/traversal/symlink-escape defenses, then cover the
 * auth/agent-authorization gate, content-type/disposition, and the
 * deliberate `knowledge.source_viewed` audit row. Real filesystem I/O
 * against a per-test temp directory (same pattern as
 * `server/agent-uploads-route.test.ts`); auth + agent-access + audit are
 * mocked (same pattern as `api/agent-active-error.test.ts` /
 * `api/knowledge-search.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  openSync,
  writeSync,
  ftruncateSync,
  closeSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
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

let tmpRoot: string;
let allowedRoot: string;
let outsideDir: string;

const PDF_BYTES = Buffer.from("%PDF-1.4\nfake pdf body for tests\n%%EOF");
const SECRET_BYTES = Buffer.from("top secret content that must never be served");

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-workspace-file-test-"));
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

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function callGET(
  agentId: string,
  requestedPath: string,
  headers?: HeadersInit,
  extraParams?: Record<string, string>
) {
  const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/route");
  const url = new URL(`http://localhost/api/agents/${agentId}/workspace-file`);
  url.searchParams.set("path", requestedPath);
  for (const [key, value] of Object.entries(extraParams ?? {})) {
    url.searchParams.set(key, value);
  }
  const req = new NextRequest(url, headers ? { headers } : undefined);
  return GET(req, {
    params: Promise.resolve({ agentId }),
  } as unknown as Parameters<typeof GET>[1]);
}

/** The same route, asked for a copy to keep rather than a pane to read. */
async function callDownload(agentId: string, requestedPath: string, headers?: HeadersInit) {
  return callGET(agentId, requestedPath, headers, { download: "1" });
}

/**
 * Next.js does not route HEAD separately: with no HEAD export it calls the GET
 * handler and then discards the body without reading or cancelling it
 * (`send-response.js`: `if (response.body && req.method !== 'HEAD')`). So the
 * handler must see the real method — passing it here is not test scaffolding,
 * it is the only shape in which the HEAD path exists.
 */
async function callHEAD(agentId: string, requestedPath: string) {
  const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/route");
  const url = new URL(`http://localhost/api/agents/${agentId}/workspace-file`);
  url.searchParams.set("path", requestedPath);
  const req = new NextRequest(url, { method: "HEAD" });
  return GET(req, {
    params: Promise.resolve({ agentId }),
  } as unknown as Parameters<typeof GET>[1]);
}

/**
 * Open file descriptors of this process. `/dev/fd` is a directory on both
 * macOS and Linux (where it is a symlink to /proc/self/fd), which is what makes
 * a descriptor leak assertable in an ordinary unit test instead of only in
 * production, where it surfaces as EMFILE under load.
 */
function countOpenDescriptors(): number {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path
  return readdirSync("/dev/fd").length;
}

/**
 * Creates a file of `size` bytes that occupies almost no disk: the header is
 * written, then the length is extended with `ftruncate`, which allocates no
 * blocks on any filesystem this runs on (apfs, ext4, xfs, overlayfs, tmpfs).
 * That is what makes it practical to assert behaviour on a file larger than
 * memory in an ordinary unit test.
 */
function writeSparseFile(path: string, size: number, header: Buffer): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-local path under a per-test temp dir
  const fd = openSync(path, "w");
  try {
    writeSync(fd, header, 0, header.length, 0);
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

/**
 * One byte past the largest buffer `fs.readFile` will produce — it throws
 * ERR_FS_FILE_TOO_LARGE above 2 GiB. A file this size therefore cannot be
 * served by any implementation that materialises it first, which is what makes
 * the two tests below a structural proof of streaming rather than a
 * measurement of it. If Node ever raises that ceiling the tests stay valid;
 * they assert the route's behaviour, not Node's limit.
 */
const OVER_BUFFER_LIMIT = 2 * 1024 * 1024 * 1024 + 1;

describe("GET /api/agents/[agentId]/workspace-file", () => {
  it("serves a PDF under an allowed root inline with the right headers, bytes, and audit row", async () => {
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callGET("agent-1", pdfPath);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PDF_BYTES)).toBe(true);

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.source_viewed");
    expect(entry.outcome).toBe("success");
    expect(entry.actorId).toBe("user-1");
    expect(entry.detail).toMatchObject({
      agent: { id: "agent-1", name: "Smithers" },
      document: { name: "handbook.pdf" },
    });
    // The full path (which could embed a username) must never land in the
    // audit detail — only the basename.
    expect(JSON.stringify(entry.detail)).not.toContain(tmpRoot);
    // Nor may the raw users.id (#824): appendAuditLog pseudonymizes the
    // actorId COLUMN only, `detail` is stored verbatim. An id written here
    // would sit un-erasable in an HMAC-chained row and defeat crypto-erasure
    // — and it is redundant with the (pseudonymized) actorId anyway.
    expect(entry.detail).not.toHaveProperty("userId");
    expect(JSON.stringify(entry.detail)).not.toContain("user-1");
  });

  it("keeps the raw user id out of the detail on failure rows too", async () => {
    // Same crypto-erasure rule as the success row above (#824) — every audit
    // path this route writes goes through the same detail builder, so a
    // regression on any of them is a regression on all.
    const secretPath = join(outsideDir, "secret.pdf");
    writeFileSync(secretPath, SECRET_BYTES);

    const res = await callGET("agent-1", secretPath);

    expect(res.status).toBe(403);
    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.source_viewed");
    expect(entry.outcome).toBe("failure");
    expect(entry.detail).toMatchObject({ reason: "outside_allowed_paths" });
    // The actor is still attributable — through the column that gets
    // pseudonymized, which is the whole point.
    expect(entry.actorId).toBe("user-1");
    expect(entry.detail).not.toHaveProperty("userId");
    expect(JSON.stringify(entry.detail)).not.toContain("user-1");
  });

  it("sanitizes a filename containing a quote/backslash so it cannot break out of the quoted Content-Disposition value", async () => {
    // macOS/Linux both allow `"` and `\` in a filename. If either survived
    // into `filename="<name>"` unescaped, a crafted document name could
    // terminate the quoted value early (header/response splitting risk).
    const evilName = 'evil"na\\me.pdf';
    const pdfPath = join(allowedRoot, evilName);
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callGET("agent-1", pdfPath);

    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition")!;
    const match = disposition.match(/filename="([^]*?)";\s*filename\*=/);
    expect(match).not.toBeNull();
    const quotedFilename = match![1];
    expect(quotedFilename).not.toContain('"');
    expect(quotedFilename).not.toContain("\\");
  });

  it("serves a non-PDF file under an allowed root as an attachment (not inline)", async () => {
    const txtPath = join(allowedRoot, "notes.txt");
    writeFileSync(txtPath, "hello");

    const res = await callGET("agent-1", txtPath);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("denies a path entirely outside allowed_paths with 403 and never serves its bytes", async () => {
    const secretPath = join(outsideDir, "secret.pdf");
    writeFileSync(secretPath, SECRET_BYTES);

    const res = await callGET("agent-1", secretPath);

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("top secret");
  });

  it("denies a .. traversal attempt that lexically escapes the allowed root with 403", async () => {
    const secretPath = join(outsideDir, "secret.pdf");
    writeFileSync(secretPath, SECRET_BYTES);
    const traversalPath = join(allowedRoot, "..", "outside", "secret.pdf");

    const res = await callGET("agent-1", traversalPath);

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("top secret");
  });

  it("denies a symlink inside the allowed root that points outside it (realpath containment) with 403", async () => {
    const secretPath = join(outsideDir, "secret.pdf");
    writeFileSync(secretPath, SECRET_BYTES);
    const linkPath = join(allowedRoot, "evil-link.pdf");
    symlinkSync(secretPath, linkPath);

    const res = await callGET("agent-1", linkPath);

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("top secret");
  });

  it("returns 401 when the caller is unauthenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callGET("agent-1", pdfPath);

    expect(res.status).toBe(401);
    expect(mockDeferAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is not authorized for the agent", async () => {
    mockGetAgentWithAccess.mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callGET("agent-1", pdfPath);

    expect(res.status).toBe(403);
    expect(mockDeferAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 when the agent has no allowed_paths configured", async () => {
    mockGetAgentWithAccess.mockResolvedValue({
      id: "agent-1",
      name: "Smithers",
      pluginConfig: { "pinchy-files": { allowed_paths: [] } },
    });
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callGET("agent-1", pdfPath);

    expect(res.status).toBe(403);
  });

  it("returns 404 for a path under an allowed root that does not exist on disk", async () => {
    const res = await callGET("agent-1", join(allowedRoot, "missing.pdf"));

    expect(res.status).toBe(404);
  });

  it("returns 404 (not a directory listing) for a directory under an allowed root", async () => {
    const subdir = join(allowedRoot, "subdir");
    mkdirSync(subdir);

    const res = await callGET("agent-1", subdir);

    expect(res.status).toBe(404);
  });

  it("returns 400 when the path query parameter is missing", async () => {
    const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/route");
    const req = new NextRequest("http://localhost/api/agents/agent-1/workspace-file");
    const res = await GET(req, {
      params: Promise.resolve({ agentId: "agent-1" }),
    } as unknown as Parameters<typeof GET>[1]);

    expect(res.status).toBe(400);
  });
});

/**
 * A knowledge-base corpus is not a folder of small handouts. The corpus this
 * route was built against contains a 268 MB and a 174 MB scanned compilation
 * binder, and because they contain the most, retrieval cites them the most —
 * so the largest files in the corpus are exactly the ones a user is most
 * likely to click. An earlier revision refused anything over 50 MB with 413 to
 * avoid loading it into memory; the fix is to stop loading it into memory.
 */
describe("GET /api/agents/[agentId]/workspace-file — large files and byte ranges", () => {
  it("serves a file too large to fit in a buffer at all", async () => {
    // No implementation that reads the file into memory can pass this: at this
    // size fs.readFile throws ERR_FS_FILE_TOO_LARGE before producing a byte.
    const hugePath = join(allowedRoot, "compilation-binder.pdf");
    writeSparseFile(hugePath, OVER_BUFFER_LIMIT, PDF_BYTES);

    const res = await callGET("agent-1", hugePath);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(OVER_BUFFER_LIMIT));
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);

    // Read one chunk and walk away. A buffering implementation would have had
    // to finish the whole file before the first byte ever arrived here.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    expect(Buffer.from(value!.subarray(0, PDF_BYTES.length)).equals(PDF_BYTES)).toBe(true);
  });

  it("advertises range support so a PDF viewer fetches pages instead of the whole file", async () => {
    // Without this header a viewer has no way to know it may seek, and opening
    // a citation at #page=510 downloads every byte before rendering anything.
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callGET("agent-1", pdfPath);

    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("answers a byte range from a file too large to buffer, reading only that span", async () => {
    const hugePath = join(allowedRoot, "compilation-binder.pdf");
    writeSparseFile(hugePath, OVER_BUFFER_LIMIT, PDF_BYTES);

    const res = await callGET("agent-1", hugePath, { Range: "bytes=0-7" });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-7/${OVER_BUFFER_LIMIT}`);
    expect(res.headers.get("content-length")).toBe("8");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PDF_BYTES.subarray(0, 8))).toBe(true);
  });

  it("answers a suffix range with the tail of the file", async () => {
    // How a PDF viewer starts: it reads the trailer to find the cross-reference
    // table before it knows where anything else lives.
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callGET("agent-1", pdfPath, { Range: "bytes=-6" });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(
      `bytes ${PDF_BYTES.length - 6}-${PDF_BYTES.length - 1}/${PDF_BYTES.length}`
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PDF_BYTES.subarray(PDF_BYTES.length - 6))).toBe(true);
  });

  it("rejects a range past the end of the file with 416 rather than wrong bytes", async () => {
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callGET("agent-1", pdfPath, { Range: `bytes=${PDF_BYTES.length}-99999` });

    expect(res.status).toBe(416);
    // Tells the client the real length so it can retry correctly instead of guessing.
    expect(res.headers.get("content-range")).toBe(`bytes */${PDF_BYTES.length}`);
  });

  it("serves the whole file when the range header is one it does not implement", async () => {
    // Multi-range needs a multipart/byteranges body; answering with only the
    // first span while claiming 206 would misplace every following byte.
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callGET("agent-1", pdfPath, { Range: "bytes=0-3,8-11" });

    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PDF_BYTES)).toBe(true);
  });

  it("still enforces access control on a range request", async () => {
    // The range path must not become a second, unguarded way in.
    const secretPath = join(outsideDir, "secret.pdf");
    writeFileSync(secretPath, SECRET_BYTES);

    const res = await callGET("agent-1", secretPath, { Range: "bytes=0-10" });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("top secret");
  });

  it("records a partial read as such in the audit trail", async () => {
    // Governance still sees every access — a viewer fetching a document in
    // twenty range requests must not be a way to read it unlogged. The flag is
    // what lets an analyst count document views without counting chunks.
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    await callGET("agent-1", pdfPath, { Range: "bytes=0-7" });

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.source_viewed");
    expect(entry.outcome).toBe("success");
    expect(entry.detail).toMatchObject({
      document: { name: "handbook.pdf" },
      partial: true,
    });
  });

  it("marks a whole-file read as not partial, so views are countable", async () => {
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    await callGET("agent-1", pdfPath);

    expect(mockDeferAuditLog.mock.calls[0][0].detail).toMatchObject({ partial: false });
  });
});

/**
 * Streaming replaced a buffered read, and it brought a failure mode buffering
 * did not have: the descriptor now outlives the handler. `createReadStream` on
 * an open handle closes it when the stream ENDS or is CANCELLED — but a body
 * that is never touched at all does neither, and the handle stays open until a
 * garbage collection that may not come ("Warning: Closing file descriptor N on
 * garbage collection").
 *
 * That is not a hypothetical path. Next.js auto-implements HEAD by calling the
 * GET handler (`auto-implement-methods.js`) and then throws the body away
 * unread, so every HEAD request against this route parks a descriptor — and a
 * file-serving route is exactly what proxies, monitors and PDF viewers probe
 * with HEAD. Any authenticated user could then exhaust the process's descriptor
 * limit with a loop.
 */
describe("GET /api/agents/[agentId]/workspace-file — HEAD does not leak descriptors", () => {
  // Larger than the read stream's internal buffer. Below that the stream drains
  // itself and closes the handle by accident, which would make this pass
  // against a leaking implementation — and it is the LARGE knowledge-base
  // binders this route exists for that never drain.
  const BIGGER_THAN_ONE_READ = 8 * 1024 * 1024;

  it("answers HEAD with the headers of a GET but no body", async () => {
    const pdfPath = join(allowedRoot, "compilation-binder.pdf");
    writeSparseFile(pdfPath, BIGGER_THAN_ONE_READ, PDF_BYTES);

    const res = await callHEAD("agent-1", pdfPath);

    expect(res.status).toBe(200);
    // A HEAD must be usable for what clients ask it for: size and seekability.
    expect(res.headers.get("content-length")).toBe(String(BIGGER_THAN_ONE_READ));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.body).toBeNull();
  });

  it("holds no descriptor open after a burst of HEAD requests", async () => {
    const pdfPath = join(allowedRoot, "compilation-binder.pdf");
    writeSparseFile(pdfPath, BIGGER_THAN_ONE_READ, PDF_BYTES);

    // Warm up first: the first call imports the route module and opens whatever
    // it opens once, which would otherwise read as a leak.
    await callHEAD("agent-1", pdfPath);
    const before = countOpenDescriptors();

    for (let i = 0; i < 40; i++) await callHEAD("agent-1", pdfPath);

    // Slack for unrelated descriptors the runner may open concurrently; a leak
    // is 40, not a handful.
    expect(countOpenDescriptors() - before).toBeLessThan(10);
  });

  it("still audits the access, because a HEAD reveals the document exists", async () => {
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    await callHEAD("agent-1", pdfPath);

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    expect(mockDeferAuditLog.mock.calls[0][0]).toMatchObject({
      eventType: "knowledge.source_viewed",
      outcome: "success",
    });
  });

  it("still refuses a path outside the allowed roots", async () => {
    // The HEAD path must not become a way to probe for files by status code.
    const secretPath = join(outsideDir, "secret.pdf");
    writeFileSync(secretPath, SECRET_BYTES);

    const res = await callHEAD("agent-1", secretPath);

    expect(res.status).toBe(403);
  });
});

/**
 * Reading a cited document in the viewer and taking a copy out of the building
 * are different acts. The customer this was built for reaches the file through
 * Citrix today — save to a local disk, then attach to a mail — and asked for the
 * detour to go away; governance, meanwhile, asks a question a view row cannot
 * answer: who has the actual spec sheet on their own machine?
 *
 * So the download is the same read, gated the same way, with two differences the
 * caller asks for explicitly: the browser is told to keep the bytes rather than
 * render them, and the row it writes says `knowledge.source_downloaded`.
 */
describe("GET /api/agents/[agentId]/workspace-file — download", () => {
  it("tells the browser to keep a PDF instead of rendering it", async () => {
    // Without `download=1` this exact file is served `inline` (see above) —
    // which is what makes the flag, not the file type, the thing being tested.
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callDownload("agent-1", pdfPath);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PDF_BYTES)).toBe(true);
  });

  it("does not invite framing of a response it just told the browser to save", async () => {
    // The SAMEORIGIN relaxation exists for the embedded viewer. A download is
    // not embedded, so the relaxation has no business travelling with it.
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callDownload("agent-1", pdfPath);

    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("distinguishes taking the document from looking at it in the audit trail", async () => {
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    await callDownload("agent-1", pdfPath);

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.source_downloaded");
    expect(entry.outcome).toBe("success");
    expect(entry.actorId).toBe("user-1");
    expect(entry.resource).toBe("agent:agent-1");
    expect(entry.detail).toMatchObject({
      agent: { id: "agent-1", name: "Smithers" },
      document: { name: "handbook.pdf" },
      partial: false,
    });
    // Same PII rules as the view row: the basename only, never a path that
    // could embed a username, and no raw users.id in a detail that
    // appendAuditLog stores verbatim (#824).
    expect(JSON.stringify(entry.detail)).not.toContain(tmpRoot);
    expect(JSON.stringify(entry.detail)).not.toContain("user-1");
  });

  it("leaves an ordinary view logged as a view", async () => {
    // The two event types have to stay separable in both directions, or the
    // download row is just a rename of the view row.
    const pdfPath = join(allowedRoot, "handbook.pdf");
    writeFileSync(pdfPath, PDF_BYTES);

    await callGET("agent-1", pdfPath);

    expect(mockDeferAuditLog.mock.calls[0][0].eventType).toBe("knowledge.source_viewed");
  });

  it("records a refused download as a refused download, not as a refused view", async () => {
    // A denied attempt to take a document out is the row an analyst most wants
    // to find; folding it into the view family would hide it.
    const secretPath = join(outsideDir, "secret.pdf");
    writeFileSync(secretPath, SECRET_BYTES);

    const res = await callDownload("agent-1", secretPath);

    expect(res.status).toBe(403);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.source_downloaded");
    expect(entry.outcome).toBe("failure");
    expect(entry.detail).toMatchObject({ reason: "outside_allowed_paths" });
  });

  it("keeps a filename with umlauts and diacritics intact for the saved file", async () => {
    // The corpus this serves is German and full of these. `filename="…"` can
    // only carry ASCII, so the real name rides in `filename*=UTF-8''…`; without
    // it the user saves `Pr_fbericht_Nr._5_-_lwanne.pdf` and has to rename it
    // before attaching it to a mail — the very detour this feature removes.
    const documentName = "Prüfbericht Nr. 5 – Ölwanne (Größe).pdf";
    const pdfPath = join(allowedRoot, documentName);
    writeFileSync(pdfPath, PDF_BYTES);

    const res = await callDownload("agent-1", pdfPath);

    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition")!;
    const extended = /filename\*=UTF-8''(\S+)/.exec(disposition)?.[1];
    expect(extended).toBeDefined();
    // Compared under NFC because a filesystem is free to hand the name back in
    // a different normalisation than it was written in (HFS+ does); the bytes
    // the user ends up with must be the same name either way.
    expect(decodeURIComponent(extended!).normalize("NFC")).toBe(documentName.normalize("NFC"));
    // The ASCII fallback must still be a safe quoted value, not a broken header.
    const quoted = /filename="([^]*?)";\s*filename\*=/.exec(disposition)?.[1];
    expect(quoted).toBeDefined();
    expect(quoted).not.toContain('"');
    expect(quoted).not.toContain("\\");
  });

  it("is still refused for a file outside the agent's allowed paths", async () => {
    // The download flag must not become a second, unguarded way in.
    const secretPath = join(outsideDir, "secret.pdf");
    writeFileSync(secretPath, SECRET_BYTES);

    const res = await callDownload("agent-1", secretPath);

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("top secret");
  });

  it("streams a document too large to buffer rather than refusing to hand it over", async () => {
    // The most-cited documents in this corpus are the biggest ones, so the
    // download path has to survive exactly what the view path does.
    const hugePath = join(allowedRoot, "compilation-binder.pdf");
    writeSparseFile(hugePath, OVER_BUFFER_LIMIT, PDF_BYTES);

    const res = await callDownload("agent-1", hugePath);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(OVER_BUFFER_LIMIT));
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    expect(Buffer.from(value!.subarray(0, PDF_BYTES.length)).equals(PDF_BYTES)).toBe(true);
  });
});
