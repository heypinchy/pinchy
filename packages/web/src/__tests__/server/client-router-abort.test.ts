/**
 * Focused tests for the user-triggered chat abort (#550).
 *
 * The chat composer's stop button sends a `{ type: "abort" }` frame; the
 * server routes it to `openclawClient.chatAbort(sessionKey, runId)` and emits
 * the `chat.run_aborted` audit event (reserved by #441's watchdog work,
 * emitted for the first time here). The actual OpenClaw-side abort and the
 * session-lock release are exercised by the integration suite — these tests
 * pin the routing + audit contract in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { WebSocket } from "ws";

const {
  mockChat,
  mockChatAbort,
  mockSessionsHistory,
  mockSessionsList,
  mockFindFirst,
  mockUserFindFirst,
  mockAppendAuditLog,
  mockRecordAuditFailure,
  mockGetUserGroupIds,
  mockGetAgentGroupIds,
  mockAssertAgentAccess,
} = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockChatAbort: vi.fn().mockResolvedValue(undefined),
  mockSessionsHistory: vi.fn().mockResolvedValue({ messages: [] }),
  mockSessionsList: vi.fn().mockResolvedValue([]),
  mockFindFirst: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  mockRecordAuditFailure: vi.fn(),
  mockGetUserGroupIds: vi.fn().mockResolvedValue([]),
  mockGetAgentGroupIds: vi.fn().mockResolvedValue([]),
  mockAssertAgentAccess: vi.fn(() => {}),
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
  assertAgentAccess: (...args: unknown[]) => mockAssertAgentAccess(...args),
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
  return {
    ...actual,
    appendAuditLog: mockAppendAuditLog,
  };
});

vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: (...args: unknown[]) => mockRecordAuditFailure(...args),
}));

import { ActiveRuns } from "@/server/active-runs";
import { ClientRouter } from "@/server/client-router";
import { SessionCache } from "@/server/session-cache";

interface MockWs extends WebSocket {
  sent: string[];
}

function createMockWs(): MockWs {
  const sent: string[] = [];
  const ws = {
    readyState: 1, // WS_OPEN
    send: vi.fn((data: string) => sent.push(data)),
    sent,
  } as unknown as MockWs;
  return ws;
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

const SESSION_KEY = "agent:agent-1:direct:user-1";

function registerActiveRun(activeRuns: ActiveRuns, ws: WebSocket, runId = "run-xyz") {
  activeRuns.register({
    runId,
    sessionKey: SESSION_KEY,
    agentId: "agent-1",
    userId: "user-1",
    agentName: "Smithers",
    startedAt: 1000,
    currentMessageId: "msg-1",
    ws,
  });
}

describe("ClientRouter user-triggered abort (#550)", () => {
  let activeRuns: ActiveRuns;
  let sessionCache: SessionCache;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChatAbort.mockResolvedValue(undefined);
    mockAssertAgentAccess.mockImplementation(() => {});
    activeRuns = new ActiveRuns();
    sessionCache = new SessionCache();
    mockFindFirst.mockResolvedValue(defaultAgent);
    mockUserFindFirst.mockResolvedValue({ id: "user-1", name: "Alice", context: null });
  });

  function makeRouter() {
    return new ClientRouter(buildClient() as never, "user-1", "member", sessionCache, activeRuns);
  }

  it("routes an abort frame to chatAbort with the active run's sessionKey and runId", async () => {
    const ws = createMockWs();
    registerActiveRun(activeRuns, ws, "run-xyz");
    const router = makeRouter();

    await router.handleMessage(ws, { type: "abort", agentId: "agent-1" });

    expect(mockChatAbort).toHaveBeenCalledTimes(1);
    expect(mockChatAbort).toHaveBeenCalledWith(SESSION_KEY, "run-xyz");
  });

  it("emits a chat.run_aborted audit row (actor=user, outcome=success)", async () => {
    const ws = createMockWs();
    registerActiveRun(activeRuns, ws, "run-xyz");
    const router = makeRouter();

    await router.handleMessage(ws, { type: "abort", agentId: "agent-1" });

    expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockAppendAuditLog.mock.calls[0]![0];
    expect(entry).toMatchObject({
      actorType: "user",
      actorId: "user-1",
      eventType: "chat.run_aborted",
      resource: "agent:agent-1",
      outcome: "success",
      detail: {
        agent: { id: "agent-1", name: "Smithers" },
        sessionKey: SESSION_KEY,
        runId: "run-xyz",
      },
    });
  });

  it("still signals chatAbort when no run is registered, but writes no audit row", async () => {
    const ws = createMockWs();
    const router = makeRouter();

    await router.handleMessage(ws, { type: "abort", agentId: "agent-1" });

    // The stop click still reaches OpenClaw (a safe no-op there) so the button
    // is never a silent no-op — but with no in-flight run there is nothing to
    // attribute the abort to, so we do NOT write a chat.run_aborted row a buggy
    // or hostile client could otherwise spam.
    expect(mockChatAbort).toHaveBeenCalledWith(SESSION_KEY, undefined);
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("targets the per-chat session key when a chatId is supplied (#508)", async () => {
    const ws = createMockWs();
    const router = makeRouter();

    await router.handleMessage(ws, { type: "abort", agentId: "agent-1", chatId: "abcd1234" });

    expect(mockChatAbort).toHaveBeenCalledWith("agent:agent-1:direct:user-1:abcd1234", undefined);
  });

  it("records outcome=failure when the OpenClaw abort throws, but still audits", async () => {
    const ws = createMockWs();
    registerActiveRun(activeRuns, ws, "run-xyz");
    mockChatAbort.mockRejectedValueOnce(new Error("gateway offline"));
    const router = makeRouter();

    await router.handleMessage(ws, { type: "abort", agentId: "agent-1" });

    expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    expect(mockAppendAuditLog.mock.calls[0]![0].outcome).toBe("failure");
  });

  it("does not abort or audit when the user lacks access to the agent", async () => {
    const ws = createMockWs();
    registerActiveRun(activeRuns, ws, "run-xyz");
    mockAssertAgentAccess.mockImplementation(() => {
      throw new Error("denied");
    });
    const router = makeRouter();

    await router.handleMessage(ws, { type: "abort", agentId: "agent-1" });

    expect(mockChatAbort).not.toHaveBeenCalled();
    // The access-denied path writes its own tool.denied row, never chat.run_aborted.
    const abortAudits = mockAppendAuditLog.mock.calls.filter(
      (c) => c[0]?.eventType === "chat.run_aborted"
    );
    expect(abortAudits).toHaveLength(0);
  });
});
