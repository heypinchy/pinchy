import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Hoisted mocks for getSession + agent access — same pattern as
// other route tests (see e.g. agent-access.test.ts).
const { mockGetSession, mockGetAgentWithAccess } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetAgentWithAccess: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: mockGetAgentWithAccess,
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

let tmpRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-uploads-route-test-"));
  vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
  // Default: authenticated, has access
  mockGetSession.mockResolvedValue({
    user: { id: "user-1", role: "member" },
  });
  mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Smithers" });
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const PDF_BYTES = Buffer.from("%PDF-1.4\n" + "\x00".repeat(128));

function writeUpload(agentId: string, filename: string, bytes: Buffer) {
  const dir = join(tmpRoot, agentId, "uploads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
}

async function callGET(agentId: string, filename: string) {
  const { GET } = await import("@/app/api/agents/[agentId]/uploads/[filename]/route");
  const req = new Request(
    `http://localhost/api/agents/${agentId}/uploads/${encodeURIComponent(filename)}`
  );
  return GET(
    req as unknown as Request,
    {
      params: Promise.resolve({ agentId, filename }),
    } as unknown as Parameters<typeof GET>[1]
  );
}

describe("GET /api/agents/[agentId]/uploads/[filename]", () => {
  it("streams the file with the detected content-type", async () => {
    writeUpload("agent-1", "invoice.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "invoice.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PDF_BYTES)).toBe(true);
  });

  it("sets Cache-Control: private (uploads are user-scoped, never public)", async () => {
    writeUpload("agent-1", "invoice.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "invoice.pdf");
    expect(res.headers.get("cache-control")).toMatch(/^private/);
  });

  it("returns 404 when the file does not exist", async () => {
    // Workspace exists (other agent uploads), file does not.
    writeUpload("agent-1", "other.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "missing.pdf");
    expect(res.status).toBe(404);
  });

  it("returns 401 when the user is not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    writeUpload("agent-1", "invoice.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "invoice.pdf");
    expect(res.status).toBe(401);
  });

  it("forwards the getAgentWithAccess denial response verbatim (403 from helper → 403 to caller)", async () => {
    // getAgentWithAccess returns a NextResponse on denial.
    const { NextResponse } = await import("next/server");
    mockGetAgentWithAccess.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 })
    );
    writeUpload("agent-1", "invoice.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "invoice.pdf");
    // The route forwards the helper's response verbatim — same pattern as all other agent routes.
    expect(res.status).toBe(403);
  });

  // sanitizeFilename rejects "../etc/passwd" — but a defence-in-depth check
  // belongs in the route too. A future helper change must not silently open
  // a path-traversal hole.
  it("returns 404 when the filename contains a path-traversal attempt", async () => {
    writeUpload("agent-1", "invoice.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "../../../etc/passwd");
    expect(res.status).toBe(404);
  });

  // sanitizeFilename strips directory separators — "subdir/foo.pdf" becomes
  // "foo.pdf". The file lookup then fails because "foo.pdf" was never written,
  // so we still get a 404. The point of this test is to ensure the route never
  // resolves to a file outside uploads/ even with slashed input.
  it("strips directory prefix from slashed filenames (sanitizeFilename normalizes to basename)", async () => {
    writeUpload("agent-1", "invoice.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "subdir/foo.pdf");
    expect(res.status).toBe(404);
  });

  it("returns 415 when the on-disk file's content-type is not in the upload allowlist", async () => {
    // Belt-and-suspenders: even though the upload pipeline rejects unknown
    // MIME types, the route MUST refuse to serve anything outside the
    // allowlist. Otherwise a future bug elsewhere (or an admin sneaking a
    // file into the workspace by hand) could leak arbitrary content to
    // browsers.
    writeUpload("agent-1", "weird.bin", Buffer.from("\xfe\xed\xfa\xce" + "x".repeat(64)));
    const res = await callGET("agent-1", "weird.bin");
    expect(res.status).toBe(415);
  });

  it("URL-decodes the filename param so files with spaces/parentheses work (regression guard)", async () => {
    // "Profile (38).pdf" round-trips as "Profile%20(38).pdf" through encodeURIComponent.
    writeUpload("agent-1", "Profile (38).pdf", PDF_BYTES);
    const res = await callGET("agent-1", "Profile (38).pdf");
    expect(res.status).toBe(200);
  });
});
