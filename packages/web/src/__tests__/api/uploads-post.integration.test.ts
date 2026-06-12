// Real-DB integration test for POST /api/agents/[agentId]/uploads.
//
// Uses a real PostgreSQL test database (provisioned by global-setup.ts and
// truncated between tests by setup.ts). File system I/O is redirected to a
// per-test temp directory via WORKSPACE_BASE_PATH env stubbing so no real
// openclaw-config directories are touched.
//
// What stays mocked, and why:
//   - @/lib/auth (getSession) — route handler reads session from Next.js
//     headers(). There is no real browser session in unit/integration tests;
//     we supply a fake session object instead.
//   - next/headers — same reason; required by withAuth.
//   - @/lib/enterprise — avoids touching the settings table for every test.
//   - @/lib/groups — avoids touching the user_groups / agent_groups tables.
//
// Everything else (DB writes to uploaded_files, audit_log; FS writes to the
// staging dir) runs for real.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { eq } from "drizzle-orm";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();

vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(false),
  getLicenseState: vi.fn().mockResolvedValue("community"),
}));

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
}));

// ── Real DB imports (loaded AFTER mocks are declared) ─────────────────────

import { db } from "@/db";
import { users, agents, uploadedFiles, auditLog } from "@/db/schema";
import { POST } from "@/app/api/agents/[agentId]/uploads/route";

// ── Test fixtures ──────────────────────────────────────────────────────────

// Minimal valid PDF header — enough for file-type magic-byte detection.
// The payload is intentionally tiny (< 1 KB) so tests stay fast.
const VALID_PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(128, 0)]);

// An EXE disguised as application/pdf — magic bytes are MZ (Windows PE).
const EXE_AS_PDF = Buffer.concat([
  Buffer.from([0x4d, 0x5a]), // MZ header
  Buffer.alloc(128, 0),
]);

// A valid UUID v4 (variant 8xxx required for group 4).
const TEST_DRAFT_ID = "11111111-1111-4111-8111-111111111111";

// ── Helpers ────────────────────────────────────────────────────────────────

async function seedUser(overrides?: Partial<typeof users.$inferInsert>) {
  const [row] = await db
    .insert(users)
    .values({
      name: "Test User",
      email: "testuser@example.com",
      emailVerified: true,
      role: "admin",
      ...overrides,
    })
    .returning();
  return row;
}

async function seedAgent(ownerId: string | null, overrides?: Partial<typeof agents.$inferInsert>) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model: "anthropic/claude-haiku-4-5-20251001",
      greetingMessage: "Hello!",
      isPersonal: false,
      visibility: "all",
      ownerId,
      ...overrides,
    })
    .returning();
  return row;
}

function makeRequest(
  agentId: string,
  options: {
    draftId?: string | null;
    file?: File | null;
  } = {}
) {
  const { draftId = TEST_DRAFT_ID, file = null } = options;

  const headers = new Headers();
  if (draftId !== null) {
    headers.set("x-pinchy-draft-id", draftId);
  }

  const formData = new FormData();
  if (file !== null) {
    formData.append("file", file);
  }

  return new NextRequest(`http://localhost/api/agents/${agentId}/uploads`, {
    method: "POST",
    headers,
    body: formData,
  });
}

function makeParams(agentId: string) {
  return { params: Promise.resolve({ agentId }) };
}

// ── Test suite ─────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-uploads-test-"));
  vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("POST /api/agents/[agentId]/uploads", () => {
  // ── Auth & access ──────────────────────────────────────────────────────

  it("returns 401 for an unauthenticated request", async () => {
    mockGetSession.mockResolvedValue(null);

    const file = new File([VALID_PDF], "doc.pdf", { type: "application/pdf" });
    const resp = await POST(makeRequest("any-agent-id", { file }), makeParams("any-agent-id"));

    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when the user does not have access to the agent", async () => {
    const user = await seedUser({ role: "member" });
    mockGetSession.mockResolvedValue({
      user: { id: user.id, email: user.email, role: "member" },
    });

    // Create a personal agent owned by a different user.
    const owner = await seedUser({
      email: "owner@example.com",
    });
    const agent = await seedAgent(owner.id, { isPersonal: true });

    const file = new File([VALID_PDF], "doc.pdf", { type: "application/pdf" });
    const resp = await POST(makeRequest(agent.id, { file }), makeParams(agent.id));

    expect(resp.status).toBe(403);
  });

  // ── Form data validation ───────────────────────────────────────────────

  it("returns 400 when file field is missing from form data", async () => {
    const user = await seedUser();
    mockGetSession.mockResolvedValue({
      user: { id: user.id, email: user.email, role: "admin" },
    });
    const agent = await seedAgent(null);

    const resp = await POST(makeRequest(agent.id, { file: null }), makeParams(agent.id));

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/file/i);
  });

  // ── Header validation ──────────────────────────────────────────────────

  it("returns 400 when x-pinchy-draft-id header is missing", async () => {
    const user = await seedUser();
    mockGetSession.mockResolvedValue({
      user: { id: user.id, email: user.email, role: "admin" },
    });
    const agent = await seedAgent(null);

    const file = new File([VALID_PDF], "doc.pdf", { type: "application/pdf" });
    const resp = await POST(makeRequest(agent.id, { draftId: null, file }), makeParams(agent.id));

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/draft/i);
  });

  it("returns 400 when x-pinchy-draft-id is not a valid UUID", async () => {
    const user = await seedUser();
    mockGetSession.mockResolvedValue({
      user: { id: user.id, email: user.email, role: "admin" },
    });
    const agent = await seedAgent(null);

    const file = new File([VALID_PDF], "doc.pdf", { type: "application/pdf" });
    const resp = await POST(
      makeRequest(agent.id, { draftId: "not-a-uuid", file }),
      makeParams(agent.id)
    );

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/draft/i);
  });

  // ── Size limit ─────────────────────────────────────────────────────────

  it("returns 413 and an audit failure row when file > 15 MB", async () => {
    const user = await seedUser();
    mockGetSession.mockResolvedValue({
      user: { id: user.id, email: user.email, role: "admin" },
    });
    const agent = await seedAgent(null);

    // Create a buffer that is 1 byte over the 15 MB limit.
    // The route checks `file.size` before reading the buffer, so we need
    // the actual underlying data to be over the limit. 15 MB + 1 byte.
    const oversizeBuffer = Buffer.alloc(15 * 1024 * 1024 + 1, 0x25); // 0x25 = '%'
    const oversizeFile = new File([oversizeBuffer], "big.pdf", {
      type: "application/pdf",
    });

    const resp = await POST(makeRequest(agent.id, { file: oversizeFile }), makeParams(agent.id));

    expect(resp.status).toBe(413);

    // Audit failure row must exist.
    const rows = await db.select().from(auditLog).where(eq(auditLog.actorId, user.id));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.eventType).toBe("file.upload.staged");
    expect(row.outcome).toBe("failure");
    const detail = row.detail as Record<string, unknown>;
    expect(detail.reason).toBe("oversize");
  });

  // ── MIME validation ────────────────────────────────────────────────────

  it("returns 415 and an audit failure row for a disallowed MIME type", async () => {
    const user = await seedUser();
    mockGetSession.mockResolvedValue({
      user: { id: user.id, email: user.email, role: "admin" },
    });
    const agent = await seedAgent(null);

    // EXE binary claiming to be a PDF.
    const maliciousFile = new File([EXE_AS_PDF], "evil.pdf", { type: "application/pdf" });

    const resp = await POST(makeRequest(agent.id, { file: maliciousFile }), makeParams(agent.id));

    expect(resp.status).toBe(415);

    const rows = await db.select().from(auditLog).where(eq(auditLog.actorId, user.id));
    expect(rows).toHaveLength(1);
    const detail = rows[0].detail as Record<string, unknown>;
    expect(detail.reason).toBe("mime");
    expect(rows[0].outcome).toBe("failure");
  });

  // ── Filename validation ────────────────────────────────────────────────

  it("returns 400 and an audit failure row for a path-traversal filename", async () => {
    const user = await seedUser();
    mockGetSession.mockResolvedValue({
      user: { id: user.id, email: user.email, role: "admin" },
    });
    const agent = await seedAgent(null);

    const maliciousFile = new File([VALID_PDF], "../evil.pdf", { type: "application/pdf" });

    const resp = await POST(makeRequest(agent.id, { file: maliciousFile }), makeParams(agent.id));

    expect(resp.status).toBe(400);

    const rows = await db.select().from(auditLog).where(eq(auditLog.actorId, user.id));
    expect(rows).toHaveLength(1);
    const detail = rows[0].detail as Record<string, unknown>;
    expect(detail.reason).toBe("filename");
    expect(rows[0].outcome).toBe("failure");
  });

  // ── Happy path ─────────────────────────────────────────────────────────

  it("returns 201 with correct body, writes file to staging, inserts DB row, and emits success audit", async () => {
    const user = await seedUser();
    mockGetSession.mockResolvedValue({
      user: { id: user.id, email: user.email, role: "admin" },
    });
    const agent = await seedAgent(null);

    const pdfFile = new File([VALID_PDF], "report.pdf", { type: "application/pdf" });
    const before = new Date();

    const resp = await POST(makeRequest(agent.id, { file: pdfFile }), makeParams(agent.id));

    expect(resp.status).toBe(201);
    const body = await resp.json();

    // Response shape
    expect(typeof body.id).toBe("string");
    expect(body.filename).toBe("report.pdf");
    expect(body.mimeType).toBe("application/pdf");
    expect(body.sizeBytes).toBe(VALID_PDF.length);

    // DB row
    const rows = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, body.id));
    expect(rows).toHaveLength(1);
    const dbRow = rows[0];
    expect(dbRow.status).toBe("staged");
    expect(dbRow.draftId).toBe(TEST_DRAFT_ID);
    expect(dbRow.userId).toBe(user.id);
    expect(dbRow.agentId).toBe(agent.id);
    expect(dbRow.filename).toBe("report.pdf");
    expect(dbRow.mimeType).toBe("application/pdf");
    expect(dbRow.sizeBytes).toBe(VALID_PDF.length);
    expect(dbRow.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(dbRow.stagingPath).toMatch(/^\.staging\//);
    // expiresAt should be ~24h from now (within a 5-second window)
    const expectedExpiry = new Date(before.getTime() + 24 * 60 * 60 * 1000);
    expect(dbRow.expiresAt!.getTime()).toBeGreaterThanOrEqual(expectedExpiry.getTime() - 5000);
    expect(dbRow.expiresAt!.getTime()).toBeLessThanOrEqual(expectedExpiry.getTime() + 5000);

    // File must exist on disk under .staging/<uploadId>/
    const uploadId = dbRow.stagingPath!.split("/")[1];
    const stagingFile = join(tmpRoot, agent.id, ".staging", uploadId, "report.pdf");
    expect(existsSync(stagingFile)).toBe(true);

    // Audit row — success
    const auditRows = await db.select().from(auditLog).where(eq(auditLog.actorId, user.id));
    expect(auditRows).toHaveLength(1);
    const auditRow = auditRows[0];
    expect(auditRow.eventType).toBe("file.upload.staged");
    expect(auditRow.outcome).toBe("success");
    const detail = auditRow.detail as Record<string, unknown>;
    expect(detail.uploadId).toBe(body.id);
    expect(detail.filename).toBe("report.pdf");
    expect(detail.mimeType).toBe("application/pdf");
    expect(detail.sizeBytes).toBe(VALID_PDF.length);
    expect(detail.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((detail.agent as { id: string }).id).toBe(agent.id);
  });
});
