import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "fs";
import { createHash } from "crypto";
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

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * A grant as #903 writes them: pinned to the zone the file came from and to the
 * bytes that were handed over. This is the shape the route must enforce.
 */
function pinnedGrant(zone: "workbench" | "uploads", bytes: Buffer) {
  return [{ zone, contentHash: sha256(bytes) }];
}

/**
 * A grant written before #903 — no zone, no hash, and unpinnable after the
 * fact. It keeps the semantics it was created under; the block at the bottom of
 * this file is what holds that promise (AGENTS.md § "Test Migrations Against
 * Pre-Existing Data").
 */
const LEGACY_GRANT = [{ zone: null, contentHash: null }];

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-artifacts-route-test-"));
  vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
  // Default: authenticated member who was GRANTED this workbench file.
  mockGetSession.mockResolvedValue({
    user: { id: "user-1", role: "member" },
  });
  mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Smithers" });
  mockGrantLookup.mockResolvedValue(pinnedGrant("workbench", PDF_BYTES));
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const PDF_BYTES = Buffer.from("%PDF-1.4\n" + "\x00".repeat(128));

// The bytes a symlink escape must never deliver. Shaped so the route WOULD
// serve them without the containment check: real PDF magic bytes, so
// `file-type` sniffs `application/pdf` and the MIME allowlist waves them
// through. Content with no magic bytes is the weaker fixture — `.pdf` is
// absent from EXTENSION_TO_MIME, so the unfixed route answers 415 and the
// test then passes on a MIME rejection rather than on the leak. Verified by
// reproduction: reverted to the pre-fix routes, this payload is answered 200
// with the secret in the body.
const SECRET_MARKER = "SECRET-CONTENTS-NOT-A-DELIVERY";
const SECRET_PDF_BYTES = Buffer.from("%PDF-1.4\n" + SECRET_MARKER + "\n" + "\x00".repeat(128));

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

  it("serves from the uploads zone when that is where the grant was minted", async () => {
    // An agent-delivered email attachment lands in uploads/, not workbench/.
    mockGrantLookup.mockResolvedValue(pinnedGrant("uploads", PDF_BYTES));
    writeArtifact("agent-1", "uploads", "ticket.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "ticket.pdf");
    expect(res.status).toBe(200);
  });

  // Gap 1 of #903. `pinchy_write(workbench/report.pdf, overwrite=true)` in one
  // member's turn used to replace the bytes behind another member's live chip,
  // and the download served them under the old grant — content from a
  // conversation the grantee may not even be able to see.
  it("refuses a file whose bytes changed after it was delivered", async () => {
    writeArtifact("agent-1", "workbench", "report.pdf", SECRET_PDF_BYTES);
    const res = await callGET("agent-1", "report.pdf");
    expect(res.status).toBe(404);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.includes(SECRET_MARKER)).toBe(false);
  });

  // Gap 2 of #903, and the one that needs no overwrite semantics at all: an
  // ordinary create of `workbench/invoice.pdf` shadowed an `uploads/invoice.pdf`
  // delivery, because the route searched the zones in order and took the first
  // hit. A grant that names its zone never looks in the other one.
  it("serves the zone the grant names, not a same-named file shadowing it", async () => {
    mockGrantLookup.mockResolvedValue(pinnedGrant("uploads", PDF_BYTES));
    writeArtifact("agent-1", "uploads", "invoice.pdf", PDF_BYTES);
    writeArtifact("agent-1", "workbench", "invoice.pdf", SECRET_PDF_BYTES);

    const res = await callGET("agent-1", "invoice.pdf");
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PDF_BYTES)).toBe(true);
  });

  // Two grants for one filename — the same user was handed two different files
  // that happened to share a name. Each grant may only unlock its own bytes.
  it("matches the file against the grant it belongs to, not against any grant", async () => {
    mockGrantLookup.mockResolvedValue([
      ...pinnedGrant("uploads", SECRET_PDF_BYTES),
      ...pinnedGrant("workbench", PDF_BYTES),
    ]);
    writeArtifact("agent-1", "uploads", "note.pdf", PDF_BYTES);

    // The uploads copy carries the workbench grant's bytes. Neither grant
    // authorizes that pairing, so nothing is served.
    const res = await callGET("agent-1", "note.pdf");
    expect(res.status).toBe(404);
  });

  // The ordinary shape after a file is replaced: the user holds the grant for
  // what they were handed first AND one for what replaced it, because the
  // delivery glue mints on changed bytes rather than on a new name. Their older
  // chip points at the same filename, so it must open the file they currently
  // hold a grant for instead of dying with the bytes it was minted from.
  it("serves the current file when a stale grant for the same name sits beside it", async () => {
    mockGrantLookup.mockResolvedValue([
      ...pinnedGrant("workbench", SECRET_PDF_BYTES), // the replaced file
      ...pinnedGrant("workbench", PDF_BYTES), // what replaced it
    ]);
    writeArtifact("agent-1", "workbench", "report.pdf", PDF_BYTES);

    const res = await callGET("agent-1", "report.pdf");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
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

  it("forwards the getAgentWithAccess denial response verbatim, whatever its status", async () => {
    // The 403 below is a SYNTHETIC sentinel: the helper really denies with 404
    // (see its docblock), and the agent gate now matches the file gate two
    // tests up. Mocking a status the helper never emits is deliberate — a 404
    // would collide with the route's own missing-file answer and prove nothing
    // about forwarding.
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
    const weird = Buffer.from("\xfe\xed\xfa\xce" + "x".repeat(64));
    mockGrantLookup.mockResolvedValue(pinnedGrant("workbench", weird));
    writeArtifact("agent-1", "workbench", "weird.bin", weird);
    const res = await callGET("agent-1", "weird.bin");
    expect(res.status).toBe(415);
  });

  it("declares X-Frame-Options: SAMEORIGIN so the browser can <embed> the file inline", async () => {
    // Handler-level declaration only — next.config.ts decides what the URL
    // really receives and can override this to DENY. That is exactly how
    // agent-delivered PDFs shipped unviewable with this test green. The
    // resolved value is asserted in security-headers.test.ts, and enforced for
    // every serving route by frame-options-route-coverage.test.ts.
    writeArtifact("agent-1", "workbench", "report.pdf", PDF_BYTES);
    const res = await callGET("agent-1", "report.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  // Defence in depth beyond sanitizeFilename + the lexical startsWith check:
  // a symlink placed inside a delivery zone (its own filename passes
  // sanitizeFilename) can point anywhere on disk. The lexical containment
  // check only sees the symlink's in-scope path, never its target — only a
  // realpath-based check catches this. 404, not 403 (or 200), matching every
  // other not-found path in this route.
  it("returns 404 when a symlink inside a delivery zone resolves outside the workspace", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "pinchy-artifacts-escape-target-"));
    const secretPath = join(outsideDir, "secret.pdf");
    writeFileSync(secretPath, SECRET_PDF_BYTES);

    // The grant is pinned to the SECRET bytes on purpose: containment has to be
    // what refuses this, not the hash check. Pin it to anything else and the
    // test would still be green with the symlink resolution removed.
    mockGrantLookup.mockResolvedValue(pinnedGrant("workbench", SECRET_PDF_BYTES));

    const workbenchDir = join(tmpRoot, "agent-1", "workbench");
    mkdirSync(workbenchDir, { recursive: true });
    symlinkSync(secretPath, join(workbenchDir, "escape.pdf"));

    try {
      const res = await callGET("agent-1", "escape.pdf");
      // Both assertions, deliberately: the status alone would still pass if a
      // future change served the bytes under some other code, and the body
      // alone would pass on a 403 that hands an attacker an existence oracle.
      expect(res.status).toBe(404);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.includes(SECRET_MARKER)).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // The branch the escape test above cannot reach: a failed containment check
  // must `continue` to the next zone, not short-circuit the whole search. So
  // an escaping symlink in `workbench` must neither be served NOR shadow the
  // legitimate file of the same name in `uploads`. Pre-fix this test is red in
  // the worst way — 200 carrying the secret.
  it("skips an escaping symlink in workbench and still serves the real file from uploads", async () => {
    // The two-zone search is a legacy-grant behaviour since #903 — a pinned
    // grant never looks in the other zone — so this branch is exercised with
    // the grant shape that still reaches it.
    mockGrantLookup.mockResolvedValue(LEGACY_GRANT);
    const outsideDir = mkdtempSync(join(tmpdir(), "pinchy-artifacts-escape-target-"));
    const secretPath = join(outsideDir, "secret.pdf");
    writeFileSync(secretPath, SECRET_PDF_BYTES);

    const workbenchDir = join(tmpRoot, "agent-1", "workbench");
    mkdirSync(workbenchDir, { recursive: true });
    symlinkSync(secretPath, join(workbenchDir, "report.pdf"));
    writeArtifact("agent-1", "uploads", "report.pdf", PDF_BYTES);

    try {
      const res = await callGET("agent-1", "report.pdf");
      expect(res.status).toBe(200);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(PDF_BYTES)).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // AGENTS.md § "Test Migrations Against Pre-Existing Data". The pinning above
  // is a change to WHERE this route reads its authorization from, and every
  // other test in this file starts from a database written by the new code.
  // A real upgrade does not: `agent_delivered_files` already holds rows with
  // `zone` and `content_hash` NULL, and no honest value can be backfilled into
  // them — hashing what is on disk today would notarize exactly the swap the
  // change exists to catch. So they keep the semantics they were written
  // under, and that has to be asserted rather than assumed.
  describe("grants written before the zone/hash pin existed", () => {
    beforeEach(() => {
      mockGrantLookup.mockResolvedValue(LEGACY_GRANT);
    });

    it("still serves a delivery from either zone", async () => {
      writeArtifact("agent-1", "uploads", "ticket.pdf", PDF_BYTES);
      const res = await callGET("agent-1", "ticket.pdf");
      expect(res.status).toBe(200);
    });

    it("does not check bytes it was never told about", async () => {
      // The accepted cost of not backfilling, stated as a test so nobody reads
      // the pin as protecting deliveries that predate it.
      writeArtifact("agent-1", "workbench", "report.pdf", SECRET_PDF_BYTES);
      const res = await callGET("agent-1", "report.pdf");
      expect(res.status).toBe(200);
    });

    it("keeps the IDOR guard — a missing grant is still a 404", async () => {
      mockGrantLookup.mockResolvedValue([]);
      writeArtifact("agent-1", "workbench", "salary.pdf", PDF_BYTES);
      expect((await callGET("agent-1", "salary.pdf")).status).toBe(404);
    });
  });
});
