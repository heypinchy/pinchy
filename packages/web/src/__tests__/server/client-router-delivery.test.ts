import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { tmpdir } from "os";

// Focused coverage of the agent→user file-delivery glue in ClientRouter: once a
// run's stream closes, the router polls OpenClaw's native `artifacts.list` RPC,
// records a per-user delivery grant for each new file/image artifact, audits it,
// and broadcasts a `file` frame. The OpenClaw gateway does not stream native
// plugin tool-output text, so this poll (not an inline marker) is how a delivery
// is observed. The full path (real plugin → transcript artifact → this glue) is
// covered by E2E; here we exercise the glue directly via the private-method cast
// seam.

const { mockInsertValues, mockAppendAuditLog, mockRecordAuditFailure, mockGrantSelect } =
  vi.hoisted(() => ({
    mockInsertValues: vi.fn().mockResolvedValue(undefined),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
    mockRecordAuditFailure: vi.fn(),
    // Configurable per-test: the existing-grant lookup result (empty => new).
    mockGrantSelect: vi.fn().mockReturnValue([]),
  }));

vi.mock("@/db", () => ({
  db: {
    query: { agents: { findFirst: vi.fn() }, users: { findFirst: vi.fn() } },
    select: () => ({ from: () => ({ where: () => mockGrantSelect() }) }),
    insert: () => ({ values: mockInsertValues }),
  },
}));
vi.mock("@/db/schema", () => ({
  agents: { id: "id" },
  users: { id: "id" },
  models: {},
  agentDeliveredFiles: {
    __table: "agent_delivered_files",
    id: "id",
    agentId: "agent_id",
    filename: "filename",
    userId: "user_id",
  },
}));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, appendAuditLog: mockAppendAuditLog };
});
vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: mockRecordAuditFailure,
}));

import { ClientRouter } from "@/server/client-router";
import { SessionCache } from "@/server/session-cache";

function createMockClientWs() {
  const sent: string[] = [];
  return { send: vi.fn((d: string) => sent.push(d)), close: vi.fn(), sent, readyState: 1 };
}

function createMockOpenClawClient(
  request: (method: string, params?: Record<string, unknown>) => unknown
) {
  return Object.assign(new EventEmitter(), {
    chat: vi.fn(),
    sessions: { history: vi.fn(), list: vi.fn() },
    hasMethod: () => true,
    agents: { list: vi.fn() },
    request: vi.fn(request),
    isConnected: true,
  });
}

const agent = { id: "agent-1", name: "Smithers" };
const SESSION_KEY = "agent:agent-1:direct:user-1";

// A grant is pinned to the bytes it was minted from (#903), so the glue now
// reads the workspace instead of trusting the artifact title. These tests get a
// real one — mocking the read away would leave the hash unasserted, which is
// the only part of the change that carries the security property.
let tmpRoot: string;

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function writeArtifactFile(zone: "workbench" | "uploads", filename: string, bytes: Buffer) {
  const dir = join(tmpRoot, agent.id, zone);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
}

/** The bytes every artifact in a test gets unless the test writes its own. */
const DEFAULT_BYTES = Buffer.from("delivered-bytes");

type Artifact = { type?: string; title?: string; mimeType?: string };

function makeRouter(artifacts: Artifact[]) {
  const cache = new SessionCache();
  cache.refresh([{ key: SESSION_KEY }]);
  const client = createMockOpenClawClient((method) => {
    if (method === "artifacts.list") return { payload: { artifacts } };
    return { payload: {} };
  });
  const router = new ClientRouter(client as any, "user-1", "member", cache);
  return { router, client };
}

async function deliver(router: ClientRouter, clientWs: unknown) {
  await (
    router as unknown as {
      deliverRunArtifacts: (
        sessionKey: string,
        agent: { id: string; name: string },
        clientWs: unknown,
        messageId: string
      ) => Promise<void>;
    }
  ).deliverRunArtifacts(SESSION_KEY, agent, clientWs, "msg-1");
}

describe("ClientRouter file-delivery glue (artifacts.list poll)", () => {
  let clientWs: ReturnType<typeof createMockClientWs>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGrantSelect.mockReturnValue([]);
    clientWs = createMockClientWs();
    tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-delivery-test-"));
    vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
    // Every artifact these tests deliver exists in workbench with the same
    // bytes, which is the ordinary case. Tests about a missing file, or about
    // the uploads zone, set up their own.
    for (const name of ["invoice.pdf", "chart.png", "export.csv", "a.pdf", "b.pdf"]) {
      writeArtifactFile("workbench", name, DEFAULT_BYTES);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function sentFrames() {
    return clientWs.sent.map((s) => JSON.parse(s));
  }

  it("records a delivery grant for the calling user from a file artifact", async () => {
    const { router } = makeRouter([
      { type: "file", title: "invoice.pdf", mimeType: "application/pdf" },
    ]);
    await deliver(router, clientWs);

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        agentId: "agent-1",
        sessionKey: SESSION_KEY,
        filename: "invoice.pdf",
        mimeType: "application/pdf",
      })
    );
  });

  // #903: the grant has to say WHAT was delivered, not only what it was called.
  // Without these two fields the download serves whatever later occupies that
  // filename in a workspace every member of a shared agent writes into.
  it("pins the grant to the zone and the bytes it was minted from", async () => {
    const { router } = makeRouter([
      { type: "file", title: "invoice.pdf", mimeType: "application/pdf" },
    ]);
    await deliver(router, clientWs);

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        zone: "workbench",
        contentHash: sha256(DEFAULT_BYTES),
      })
    );
  });

  it("records the uploads zone for a file the agent fetched rather than wrote", async () => {
    // An email attachment lands in uploads/, and the grant has to say so — the
    // route serves the zone the grant names and never guesses at the other.
    const bytes = Buffer.from("attachment-bytes");
    writeArtifactFile("uploads", "ticket.pdf", bytes);
    const { router } = makeRouter([
      { type: "file", title: "ticket.pdf", mimeType: "application/pdf" },
    ]);
    await deliver(router, clientWs);

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ zone: "uploads", contentHash: sha256(bytes) })
    );
  });

  it("mints no grant for an artifact with no readable file behind it", async () => {
    // Same call the non-servable MIME case makes, for the same reason: a grant
    // that cannot be pinned would fall back to pre-#903 semantics forever, so
    // minting it would re-open the gap for every future delivery instead of
    // only for the ones that predate the change.
    const { router } = makeRouter([
      { type: "file", title: "vanished.pdf", mimeType: "application/pdf" },
    ]);
    await deliver(router, clientWs);

    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
    expect(sentFrames().some((f) => f.type === "file")).toBe(false);
  });

  it("broadcasts a file frame the client attaches to the current assistant message", async () => {
    const { router } = makeRouter([
      { type: "file", title: "invoice.pdf", mimeType: "application/pdf" },
    ]);
    await deliver(router, clientWs);

    const fileFrame = sentFrames().find((f) => f.type === "file");
    expect(fileFrame).toMatchObject({
      type: "file",
      messageId: "msg-1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    });
  });

  it("writes a file.delivered audit row without a zone field", async () => {
    const { router } = makeRouter([
      { type: "file", title: "invoice.pdf", mimeType: "application/pdf" },
    ]);
    await deliver(router, clientWs);

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "file.delivered",
        outcome: "success",
        detail: expect.objectContaining({
          agent: { id: "agent-1", name: "Smithers" },
          filename: "invoice.pdf",
          mimeType: "application/pdf",
        }),
      })
    );
    const detail = mockAppendAuditLog.mock.calls[0][0].detail;
    expect(detail).not.toHaveProperty("zone");
  });

  it("delivers image artifacts too", async () => {
    const { router } = makeRouter([{ type: "image", title: "chart.png", mimeType: "image/png" }]);
    await deliver(router, clientWs);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "chart.png", mimeType: "image/png" })
    );
  });

  it("skips an artifact with an unknown mime type (defaults to octet-stream → not servable)", async () => {
    // A missing mimeType defaults to application/octet-stream, which the serving
    // route rejects (415). Delivering it would show a chip that fails to open, so
    // the delivery path must not create a grant/chip/audit for it.
    const { router } = makeRouter([{ type: "file", title: "blob.dat" }]);
    await deliver(router, clientWs);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
    expect(sentFrames().some((f) => f.type === "file")).toBe(false);
  });

  it("skips a file whose declared mime type is outside the serving allowlist (would 415)", async () => {
    // #703 M2: the grant/chip/success-audit must agree with what the serving
    // route can actually stream. A .docx is not in the MIME allowlist, so it must
    // not be delivered — otherwise the user gets a chip that 415s on download
    // while the audit claims success.
    const { router } = makeRouter([
      {
        type: "file",
        title: "contract.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ]);
    await deliver(router, clientWs);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
    expect(sentFrames().some((f) => f.type === "file")).toBe(false);
  });

  it("delivers a servable text file (csv is in the allowlist)", async () => {
    const { router } = makeRouter([{ type: "file", title: "export.csv", mimeType: "text/csv" }]);
    await deliver(router, clientWs);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "export.csv", mimeType: "text/csv" })
    );
  });

  it("skips an artifact already granted to this user (idempotent re-poll)", async () => {
    // The batched grant lookup returns the filenames already granted to this
    // (agent, user); a matching filename is skipped.
    mockGrantSelect.mockReturnValue([{ filename: "invoice.pdf" }]);
    const { router } = makeRouter([
      { type: "file", title: "invoice.pdf", mimeType: "application/pdf" },
    ]);
    await deliver(router, clientWs);

    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
    expect(sentFrames().some((f) => f.type === "file")).toBe(false);
  });

  it("skips non-file/non-image artifacts (e.g. text)", async () => {
    const { router } = makeRouter([{ type: "text", title: "notes.txt" }]);
    await deliver(router, clientWs);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(sentFrames().some((f) => f.type === "file")).toBe(false);
  });

  it("skips an artifact with no title (nothing to serve)", async () => {
    const { router } = makeRouter([{ type: "file", mimeType: "application/pdf" }]);
    await deliver(router, clientWs);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("records multiple new files from one poll", async () => {
    const { router } = makeRouter([
      { type: "file", title: "a.pdf", mimeType: "application/pdf" },
      { type: "file", title: "b.pdf", mimeType: "application/pdf" },
    ]);
    await deliver(router, clientWs);
    expect(mockInsertValues).toHaveBeenCalledTimes(2);
    expect(sentFrames().filter((f) => f.type === "file")).toHaveLength(2);
  });

  it("still broadcasts the file frame if the audit write throws (delivery must not be lost)", async () => {
    mockAppendAuditLog.mockRejectedValueOnce(new Error("audit down"));
    const { router } = makeRouter([
      { type: "file", title: "invoice.pdf", mimeType: "application/pdf" },
    ]);
    await deliver(router, clientWs);
    expect(mockRecordAuditFailure).toHaveBeenCalled();
    expect(sentFrames().some((f) => f.type === "file")).toBe(true);
  });

  it("rejects when the artifacts.list request throws (the caller swallows it)", async () => {
    const cache = new SessionCache();
    cache.refresh([{ key: SESSION_KEY }]);
    const client = createMockOpenClawClient(() => {
      throw new Error("gateway down");
    });
    const router = new ClientRouter(client as any, "user-1", "member", cache);
    await expect(deliver(router, clientWs)).rejects.toThrow("gateway down");
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});
