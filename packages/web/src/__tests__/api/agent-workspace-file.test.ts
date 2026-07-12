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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
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

async function callGET(agentId: string, requestedPath: string) {
  const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/route");
  const url = new URL(`http://localhost/api/agents/${agentId}/workspace-file`);
  url.searchParams.set("path", requestedPath);
  const req = new NextRequest(url);
  return GET(req, {
    params: Promise.resolve({ agentId }),
  } as unknown as Parameters<typeof GET>[1]);
}

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
      userId: "user-1",
      agent: { id: "agent-1", name: "Smithers" },
      document: { name: "handbook.pdf" },
    });
    // The full path (which could embed a username) must never land in the
    // audit detail — only the basename.
    expect(JSON.stringify(entry.detail)).not.toContain(tmpRoot);
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
