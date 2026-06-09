/**
 * Tier 2b: `handleHistory` includes an `activeRun` signal when there's a
 * matching in-flight run, and adds the requesting ws to the listener set
 * so subsequent chunks broadcast to it (#310). Detaches the ws from any
 * prior chat first, so an agent switch in a single tab transfers cleanly.
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

describe("ClientRouter handleHistory ↔ ActiveRuns resume (#310 Tier 2b)", () => {
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

  it("attaches the requesting ws as a listener and includes activeRun signal in the history frame", async () => {
    // Seed an in-flight run for the agent.
    const sessionKey = "agent:agent-1:direct:user-1";
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
    // The server has emitted more of the reply than OpenClaw has persisted —
    // this is the resume buffer the reconnecting client must be re-seeded with.
    activeRuns.setContent(sessionKey, "We're checking the vacation policy for you");

    // OC history returns a shorter (or no) partial assistant turn (typical for
    // in-flight — persistence lags the live stream).
    mockSessionsHistory.mockResolvedValue({
      messages: [
        { role: "user", content: "What's the vacation policy?" },
        { role: "assistant", content: "We're checking..." },
      ],
    });

    const wsReconnect = createMockWs();
    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );

    await router.handleMessage(wsReconnect, { type: "history", agentId: "agent-1" });

    const historyFrame = wsReconnect.sent.find((f) => f.type === "history");
    expect(historyFrame).toBeDefined();
    expect(historyFrame!.activeRun).toEqual({
      runId: "run-active",
      messageId: "msg-inflight",
      startedAt: 1000,
      // Resume completeness: the server replays its accumulated emitted text so
      // the client recovers words streamed before the reload, even though OC
      // history only has the shorter persisted "We're checking...".
      partialContent: "We're checking the vacation policy for you",
    });
    // The reconnecting ws joined the listener set so future chunks
    // broadcast to it.
    const run = activeRuns.get(sessionKey);
    expect(run?.listeners.has(wsReconnect)).toBe(true);
    expect(run?.listeners.has(wsOriginal)).toBe(true);
  });

  it("omits activeRun signal when there is no in-flight run", async () => {
    mockSessionsHistory.mockResolvedValue({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ],
    });

    const ws = createMockWs();
    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );

    await router.handleMessage(ws, { type: "history", agentId: "agent-1" });

    const historyFrame = ws.sent.find((f) => f.type === "history");
    expect(historyFrame).toBeDefined();
    expect(historyFrame!.activeRun).toBeUndefined();
  });

  it("detaches the ws from any other run's listener set before joining the new chat's set (agent switch)", async () => {
    // The user was watching chat A (with an active run), then switches
    // their single tab to chat B. The ws should no longer receive
    // chat A's broadcasts — otherwise switching agents in one tab leaks
    // cross-chat chunks.
    const sessionKeyA = "agent:a:direct:user-1";
    const sessionKeyB = "agent:b:direct:user-1";
    const ws = createMockWs();

    activeRuns.register({
      runId: "run-a",
      sessionKey: sessionKeyA,
      agentId: "a",
      userId: "user-1",
      agentName: "AgentA",
      startedAt: 1000,
      currentMessageId: "msg-a",
      ws,
    });
    // No active run for B.

    const agentB = { ...defaultAgent, id: "b", name: "AgentB" };
    mockFindFirst.mockResolvedValue(agentB);
    sessionCache.refresh([{ key: sessionKeyB }]);
    mockSessionsHistory.mockResolvedValue({ messages: [] });

    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );

    await router.handleMessage(ws, { type: "history", agentId: "b" });

    // ws was detached from A's listener set.
    expect(activeRuns.get(sessionKeyA)?.listeners.has(ws)).toBe(false);
    // The run for A is still registered (the OC stream continues
    // server-side regardless).
    expect(activeRuns.get(sessionKeyA)).toBeDefined();
  });
});
