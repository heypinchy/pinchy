import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { makeNextRequest, routeContext } from "@/test-helpers/route";

// Hoisted mocks for getSession + agent access + the delivery-grant lookup.
// Mirrors agent-uploads-route.test.ts, but the ownership source is the
// agent_delivered_files grant table instead of uploadedFiles.
const { mockGetSession, mockGetAgentWithAccess, mockGrantLookup } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetAgentWithAccess: vi.fn(),
  mockGrantLookup: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: mockGetAgentWithAccess,
}));
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => mockGrantLookup(...args),
      }),
    }),
  },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

let tmpRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-artifacts-route-test-"));
  vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
  // Default: authenticated member who was GRANTED this workbench file.
  mockGetSession.mockResolvedValue({
    user: { id: "user-1", role: "member" },
  });
  mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Smithers" });
  mockGrantLookup.mockResolvedValue([{ id: "grant-1" }]);
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const PDF_BYTES = Buffer.from("%PDF-1.4\n" + "\x00".repeat(128));

function writeArtifact(agentId: string, zone: string, filename: string, bytes: Buffer) {
  const dir = join(tmpRoot, agentId, zone);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
}

async function callGET(agentId: string, filename: string) {
  const { GET } = await import("@/app/api/agents/[agentId]/artifacts/[filename]/route");
  const req = makeNextRequest(
    `http://localhost/api/agents/${agentId}/artifacts/${encodeURIComponent(filename)}`
  );
  return GET(req, routeContext({ agentId, filename }));
}

describe("GET /api/agents/[agentId]/artifacts/[filename]", () => {
  it("streams a granted workbench file with the detected content-type", async () => {
    writeArtifact("agent-1", "workbench", "report.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "report.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PDF_BYTES)).toBe(true);
  });

  it("resolves the file from the uploads zone when it lives there (two-zone search)", async () => {
    // An agent-delivered email attachment lands in uploads/, not workbench/. The
    // grant no longer records the zone, so the route searches both and finds it.
    writeArtifact("agent-1", "uploads", "ticket.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "ticket.pdf");
    expect(res.status).toBe(200);
  });

  it("sets Cache-Control: private (delivered files are user-scoped, never public)", async () => {
    writeArtifact("agent-1", "workbench", "report.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "report.pdf");
    expect(res.headers.get("cache-control")).toMatch(/^private/);
  });

  it("returns 404 when no delivery grant exists for the caller (IDOR guard)", async () => {
    // The file physically exists in a shared agent's workbench, but the caller
    // holds no grant — a shared agent's other members must not fetch it. 404,
    // not 403, so existence is not disclosed.
    mockGetSession.mockResolvedValue({ user: { id: "user-2", role: "member" } });
    mockGrantLookup.mockResolvedValue([]); // no grant owned by user-2
    writeArtifact("agent-1", "workbench", "salary.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "salary.pdf");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the granted file does not exist on disk", async () => {
    writeArtifact("agent-1", "workbench", "other.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "missing.pdf");
    expect(res.status).toBe(404);
  });

  it("returns 401 when the user is not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    writeArtifact("agent-1", "workbench", "report.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "report.pdf");
    expect(res.status).toBe(401);
  });

  it("forwards the getAgentWithAccess denial response verbatim (403 → 403)", async () => {
    const { NextResponse } = await import("next/server");
    mockGetAgentWithAccess.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 })
    );
    writeArtifact("agent-1", "workbench", "report.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "report.pdf");
    expect(res.status).toBe(403);
  });

  it("returns 404 when the filename contains a path-traversal attempt", async () => {
    writeArtifact("agent-1", "workbench", "report.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "../../../etc/passwd");
    expect(res.status).toBe(404);
  });

  it("returns 415 when the on-disk file's content-type is not in the allowlist", async () => {
    writeArtifact(
      "agent-1",
      "workbench",
      "weird.bin",
      Buffer.from("\xfe\xed\xfa\xce" + "x".repeat(64))
    );
    const res = await callGET("agent-1", "weird.bin");
    expect(res.status).toBe(415);
  });

  it("sets X-Frame-Options: SAMEORIGIN so the browser can <embed> the file inline", async () => {
    writeArtifact("agent-1", "workbench", "report.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "report.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});
