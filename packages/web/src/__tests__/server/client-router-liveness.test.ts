/**
 * Authoritative liveness signal (chat-liveness-observer Task 2A).
 *
 * Pinchy's chat used to guess run failure from silence (client-side timers /
 * heuristics), which produced false "The agent didn't respond" bubbles. We are
 * moving to an AUTHORITATIVE liveness signal sourced from the OpenClaw gateway.
 *
 * This file pins the SERVER half of that contract:
 *
 *   1. The chat pipe (`pipeStream`) emits a `liveness` frame ALONGSIDE the
 *      existing chunk/complete/error frames:
 *        - first chunk that starts streaming → `liveness: responding`
 *        - terminal `complete`               → `liveness: completed`
 *        - terminal `error`                  → `liveness: failed` (+ reason)
 *
 *   2. On reconnect (`handleHistory`) with an in-flight run, the server asks
 *      the gateway's authoritative oracle (`agentWait`) for the run's state and
 *      emits a `liveness` verdict — NEVER fabricating `failed` from a timer or
 *      from an `agentWait` throw.
 *
 * The frames are additive on the wire: the existing `chunk`/`complete`/`error`/
 * `ack` frames are unchanged in this task (the client switchover is later).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { WebSocket } from "ws";
import type { ChatChunk, AgentWaitResult } from "openclaw-node";

const {
  mockChat,
  mockChatAbort,
  mockAgentWait,
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
  mockAgentWait: vi.fn(),
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
  getLicenseState: vi.fn().mockResolvedValue("community"),
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
    agentWait: mockAgentWait,
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

function liveness(ws: MockWs): Record<string, unknown>[] {
  return ws.sent.filter((f) => f.type === "liveness");
}

describe("ClientRouter liveness frames in the chat pipe (Part 1)", () => {
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

  it("emits liveness:responding when the run starts streaming, then liveness:completed on complete", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", text: "Hello", runId: "run-live" },
      { type: "done", text: "", runId: "run-live" },
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

    await router.handleMessage(ws, { type: "message", content: "hi", agentId: "agent-1" });

    const states = liveness(ws).map((f) => f.state);
    // responding first (run started), completed last (terminal). The existing
    // chunk/done/complete frames remain present (additive).
    expect(states).toEqual(["responding", "completed"]);
    expect(ws.sent.some((f) => f.type === "chunk")).toBe(true);
    expect(ws.sent.some((f) => f.type === "complete")).toBe(true);

    // responding must come before completed, and completed must be the last
    // liveness frame (terminal).
    const respondingIdx = ws.sent.findIndex(
      (f) => f.type === "liveness" && f.state === "responding"
    );
    const completedIdx = ws.sent.findIndex((f) => f.type === "liveness" && f.state === "completed");
    expect(respondingIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(respondingIdx);
  });

  it("emits liveness:responding exactly once even across multiple text chunks", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", text: "Hel", runId: "run-live" },
      { type: "text", text: "lo", runId: "run-live" },
      { type: "done", text: "", runId: "run-live" },
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

    await router.handleMessage(ws, { type: "message", content: "hi", agentId: "agent-1" });

    const responding = liveness(ws).filter((f) => f.state === "responding");
    expect(responding).toHaveLength(1);
  });

  it("emits liveness:failed with the provider error as reason on a terminal error chunk", async () => {
    const chunks: ChatChunk[] = [
      { type: "error", text: "upstream model exploded", runId: "run-live" },
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

    await router.handleMessage(ws, { type: "message", content: "hi", agentId: "agent-1" });

    const failed = liveness(ws).find((f) => f.state === "failed");
    expect(failed).toBeDefined();
    expect(failed!.reason).toBe("upstream model exploded");
    // The existing `error` frame is still emitted (additive contract).
    expect(ws.sent.some((f) => f.type === "error")).toBe(true);
    // No false "completed" verdict on a failed run.
    expect(liveness(ws).some((f) => f.state === "completed")).toBe(false);
  });

  it("emits liveness:failed for the silent-stream synthesised error too", async () => {
    // A stream that ends with no text and no error chunk → the silent-stream
    // safety net synthesises an error. That terminal failure must also carry a
    // liveness:failed verdict so the client never falls back to a timer guess.
    const chunks: ChatChunk[] = [{ type: "done", text: "", runId: "run-live" }];
    mockChat.mockReturnValue(makeChunkStream(chunks));
    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();

    await router.handleMessage(ws, { type: "message", content: "hi", agentId: "agent-1" });

    const failed = liveness(ws).find((f) => f.state === "failed");
    expect(failed).toBeDefined();
    expect(typeof failed!.reason).toBe("string");
    expect(liveness(ws).some((f) => f.state === "completed")).toBe(false);
  });
});

describe("ClientRouter reconnect liveness verdict via agentWait (Part 2)", () => {
  let activeRuns: ActiveRuns;
  let sessionCache: SessionCache;
  const sessionKey = "agent:agent-1:direct:user-1";

  function seedInflightRun(): void {
    const wsOriginal = createMockWs();
    activeRuns.register({
      runId: "run-active",
      sessionKey,
      agentId: "agent-1",
      userId: "user-1",
      agentName: "Smithers",
      startedAt: 1000,
      currentMessageId: "msg-inflight",
      ws: wsOriginal,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    activeRuns = new ActiveRuns();
    sessionCache = new SessionCache();
    sessionCache.refresh([{ key: sessionKey }]);
    mockFindFirst.mockResolvedValue(defaultAgent);
    mockUserFindFirst.mockResolvedValue({ id: "user-1", name: "Alice", context: null });
    mockSessionsHistory.mockResolvedValue({
      messages: [
        { role: "user", content: "What's the vacation policy?" },
        { role: "assistant", content: "We're checking..." },
      ],
    });
  });

  it("emits liveness:responding when the gateway reports the run is still working", async () => {
    seedInflightRun();
    const result: AgentWaitResult = { status: "pending", livenessState: "working" };
    mockAgentWait.mockResolvedValue(result);

    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();
    await router.handleMessage(ws, { type: "history", agentId: "agent-1" });

    expect(mockAgentWait).toHaveBeenCalledWith(
      "run-active",
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    const verdict = liveness(ws);
    expect(verdict).toHaveLength(1);
    expect(verdict[0].state).toBe("responding");
  });

  it("emits liveness:completed when the gateway reports the run has ended", async () => {
    seedInflightRun();
    const result: AgentWaitResult = { status: "ok", endedAt: 1234, stopReason: "complete" };
    mockAgentWait.mockResolvedValue(result);

    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();
    await router.handleMessage(ws, { type: "history", agentId: "agent-1" });

    const verdict = liveness(ws);
    expect(verdict).toHaveLength(1);
    expect(verdict[0].state).toBe("completed");
  });

  it("emits liveness:failed with stopReason when the gateway reports the run abandoned", async () => {
    seedInflightRun();
    const result: AgentWaitResult = {
      status: "ok",
      endedAt: 1234,
      livenessState: "abandoned",
      stopReason: "agent gave up",
    };
    mockAgentWait.mockResolvedValue(result);

    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();
    await router.handleMessage(ws, { type: "history", agentId: "agent-1" });

    const verdict = liveness(ws);
    expect(verdict).toHaveLength(1);
    expect(verdict[0].state).toBe("failed");
    expect(verdict[0].reason).toBe("agent gave up");
  });

  it("emits liveness:failed when the gateway returns status:error", async () => {
    seedInflightRun();
    const result: AgentWaitResult = { status: "error", stopReason: "gateway internal error" };
    mockAgentWait.mockResolvedValue(result);

    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();
    await router.handleMessage(ws, { type: "history", agentId: "agent-1" });

    const verdict = liveness(ws);
    expect(verdict).toHaveLength(1);
    expect(verdict[0].state).toBe("failed");
  });

  it("does NOT manufacture a failure when agentWait throws (infra hiccup)", async () => {
    seedInflightRun();
    mockAgentWait.mockRejectedValue(new Error("websocket closed"));

    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();
    await router.handleMessage(ws, { type: "history", agentId: "agent-1" });

    // A gateway hiccup must NEVER become a `failed` verdict — that's the core of
    // "only fail when we are sure". No liveness frame is emitted at all; the
    // existing history flow continues.
    expect(liveness(ws)).toHaveLength(0);
    // History still went out.
    expect(ws.sent.some((f) => f.type === "history")).toBe(true);
  });

  it("does not call agentWait or emit a liveness verdict when there is no in-flight run", async () => {
    // No seeded run.
    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();
    await router.handleMessage(ws, { type: "history", agentId: "agent-1" });

    expect(mockAgentWait).not.toHaveBeenCalled();
    expect(liveness(ws)).toHaveLength(0);
  });
});
