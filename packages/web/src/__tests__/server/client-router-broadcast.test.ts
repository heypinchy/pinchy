/**
 * Tier 2b broadcast semantics for `ClientRouter.pipeStream` (#310).
 *
 * After a Browser ↔ Pinchy WebSocket drops mid-stream and a new ws joins
 * via the history-reconnect path, the OC stream continues server-side and
 * incoming chunks must reach BOTH the new ws and (if still alive) the
 * original. This file pins the contract that pipeStream broadcasts to the
 * activeRuns listener set rather than to the originating ws alone.
 *
 * The minimum-viable case here is: register has happened, two ws are in
 * the listener set, a chunk arrives → both ws receive the corresponding
 * outbound frame. The "multi-tab on the same session" case rides on the
 * same code path and is covered as a sanity check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { WebSocket } from "ws";
import type { ChatChunk } from "openclaw-node";

const {
  mockChat,
  mockChatAbort,
  mockSessionsHistory,
  mockSessionsList,
  mockFindFirst,
  mockUserFindFirst,
  mockAppendAuditLog,
  mockGetUserGroupIds,
  mockGetAgentGroupIds,
} = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockChatAbort: vi.fn().mockResolvedValue(undefined),
  mockSessionsHistory: vi.fn().mockResolvedValue({ messages: [] }),
  mockSessionsList: vi.fn().mockResolvedValue([]),
  mockFindFirst: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  mockGetUserGroupIds: vi.fn().mockResolvedValue([]),
  mockGetAgentGroupIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: { findFirst: mockFindFirst },
      users: { findFirst: mockUserFindFirst },
    },
  },
}));

vi.mock("@/db/schema", () => ({
  agents: { id: "id" },
  users: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

vi.mock("@/lib/agent-access", () => ({
  assertAgentAccess: vi.fn(() => {}),
  effectiveVisibility: (v: string) => v,
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: (...args: unknown[]) => mockGetUserGroupIds(...args),
  getAgentGroupIds: (...args: unknown[]) => mockGetAgentGroupIds(...args),
}));

vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, appendAuditLog: mockAppendAuditLog };
});

vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: vi.fn(),
}));

vi.mock("@/server/attachment-pipeline", () => ({
  processIncomingAttachments: vi.fn(async () => ({ chatAttachments: [], workspaceRefs: [] })),
  buildAttachmentBlock: () => "",
  parseAttachmentBlock: (s: string) => ({ cleanText: s, attachments: [] }),
  UploadValidationError: class UploadValidationError extends Error {},
}));

vi.mock("@/server/model-unavailable-throttle", () => ({
  shouldEmitModelUnavailableAudit: vi.fn().mockReturnValue(false),
  shouldEmitSilentStreamAudit: vi.fn().mockReturnValue(false),
  shouldEmitUpstreamFormatErrorAudit: vi.fn().mockReturnValue(false),
}));

import { ActiveRuns } from "@/server/active-runs";
import { ClientRouter } from "@/server/client-router";
import { SessionCache } from "@/server/session-cache";

interface MockWs extends WebSocket {
  sent: Record<string, unknown>[];
}

function createMockWs(): MockWs {
  const sent: Record<string, unknown>[] = [];
  const ws = {
    readyState: 1,
    send: vi.fn((data: string) => sent.push(JSON.parse(data))),
    sent,
  } as unknown as MockWs;
  return ws;
}

async function* makeChunkStream(chunks: ChatChunk[]): AsyncGenerator<ChatChunk> {
  for (const c of chunks) {
    await new Promise<void>((r) => setImmediate(r));
    yield c;
  }
}

function buildClient() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    chat: mockChat,
    chatAbort: mockChatAbort,
    sessions: { history: mockSessionsHistory, list: mockSessionsList },
    isConnected: true,
  });
}

const defaultAgent = {
  id: "agent-1",
  name: "Smithers",
  visibility: "public",
  greetingMessage: "",
  model: null,
  isPersonal: false,
};

describe("ClientRouter pipeStream broadcast (#310 Tier 2b)", () => {
  let activeRuns: ActiveRuns;
  let sessionCache: SessionCache;

  beforeEach(() => {
    vi.clearAllMocks();
    activeRuns = new ActiveRuns();
    sessionCache = new SessionCache();
    sessionCache.refresh([{ key: "agent:agent-1:direct:user-1" }]);
    mockFindFirst.mockResolvedValue(defaultAgent);
    mockUserFindFirst.mockResolvedValue({ id: "user-1", name: "Alice", context: null });
  });

  it("forwards a text chunk to every ws in the listener set, not only the originating ws", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", text: "Hello", runId: "run-broadcast" },
      { type: "done", text: "", runId: "run-broadcast" },
    ];
    mockChat.mockReturnValue(makeChunkStream(chunks));
    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );

    const wsOriginal = createMockWs();
    const wsReconnect = createMockWs();
    const sessionKey = "agent:agent-1:direct:user-1";

    // The reconnecting ws joins the listener set after the first chunk
    // triggers registration. We simulate that by hooking into the first
    // send on wsOriginal: at that moment, registration has happened, so
    // wsReconnect can addListener.
    const sendSpy = wsOriginal.send as unknown as ReturnType<typeof vi.fn>;
    let joined = false;
    sendSpy.mockImplementation((data: string) => {
      wsOriginal.sent.push(JSON.parse(data));
      if (!joined && activeRuns.get(sessionKey)) {
        activeRuns.addListener(sessionKey, wsReconnect);
        joined = true;
      }
    });

    await router.handleMessage(wsOriginal, {
      type: "message",
      content: "hi",
      agentId: "agent-1",
    });

    // The original ws receives the chunk and the done frame.
    expect(wsOriginal.sent.some((f) => f.type === "chunk" && f.content === "Hello")).toBe(true);
    expect(wsOriginal.sent.some((f) => f.type === "done")).toBe(true);
    // The reconnecting ws joined after the first chunk's send, so it
    // misses the initial text frame but DOES receive the done frame +
    // the terminal "complete" — proving broadcast hits the listener set,
    // not just the originating ws.
    expect(wsReconnect.sent.some((f) => f.type === "done")).toBe(true);
    expect(wsReconnect.sent.some((f) => f.type === "complete")).toBe(true);
  });

  it("falls back to the originating ws when no run is registered yet (pre-first-chunk frames)", async () => {
    // The initial "thinking" frame is sent BEFORE any chunk arrives, so
    // the registry is empty at that moment. The frame must still reach
    // the originating ws (otherwise no UI feedback during the dial-up
    // window).
    const chunks: ChatChunk[] = [
      { type: "text", text: "x", runId: "r" },
      { type: "done", text: "", runId: "r" },
    ];
    mockChat.mockReturnValue(makeChunkStream(chunks));
    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();

    await router.handleMessage(ws, {
      type: "message",
      content: "hi",
      agentId: "agent-1",
    });

    // The thinking frame fires before the first chunk; it must be present
    // on the originating ws.
    expect(ws.sent.some((f) => f.type === "thinking")).toBe(true);
  });
});
