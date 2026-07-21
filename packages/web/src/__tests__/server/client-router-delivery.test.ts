import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";

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
    // No zone field is written anymore.
    expect(mockInsertValues.mock.calls[0][0]).not.toHaveProperty("zone");
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

  it("defaults the mime type when the artifact omits it", async () => {
    const { router } = makeRouter([{ type: "file", title: "blob.dat" }]);
    await deliver(router, clientWs);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "blob.dat", mimeType: "application/octet-stream" })
    );
  });

  it("skips an artifact already granted to this user (idempotent re-poll)", async () => {
    mockGrantSelect.mockReturnValue([{ id: "existing-grant" }]);
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
