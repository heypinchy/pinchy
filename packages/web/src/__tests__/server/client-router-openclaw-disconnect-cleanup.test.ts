/**
 * #7: When OpenClaw drops the socket mid-stream, openclaw-node's chat()
 * generator hangs forever (its internal resolveChunk promise never settles).
 * Before the fix, pipeStream's `for await` would block on it indefinitely, so
 * the `finally` that clears the heartbeat interval and drops the ActiveRuns
 * entry never ran — leaking a timer and a registry entry per dropped run, and
 * leaving a phantom "in-flight" run that a reconnecting client would resume
 * against forever.
 *
 * The drain loop now races each chunk against a shared disconnect signal and
 * breaks out on disconnect, so the cleanup runs. It must NOT, however, log a
 * `chat.run_completed_after_disconnect` audit — the run did not complete.
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
import { OpenClawDisconnectSignal } from "@/server/openclaw-disconnect-signal";

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

const SESSION_KEY = "agent:agent-1:direct:user-1";

describe("ClientRouter pipeStream — OpenClaw disconnect mid-stream cleanup (#7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("breaks the hung drain loop, drops the run, and does not log a completed-after-disconnect audit", async () => {
    const client = buildClient();

    // One chunk to register the run + start the heartbeat, then hang forever —
    // exactly how chat() behaves after the OC socket drops mid-reply.
    const starter: ChatChunk = {
      type: "userMessagePersisted",
      clientMessageId: "cm-1",
      sessionKey: SESSION_KEY,
      persistedAt: 0,
      runId: "run-disc",
    } as ChatChunk;
    const stream = (async function* () {
      yield starter;
      await new Promise<void>(() => {}); // hang — never yields again
    })();
    mockChat.mockReturnValue(stream);

    const activeRuns = new ActiveRuns();
    const sessionCache = new SessionCache();
    sessionCache.refresh([{ key: SESSION_KEY }]);
    mockFindFirst.mockResolvedValue(defaultAgent);
    mockUserFindFirst.mockResolvedValue({ id: "user-1", name: "Alice", context: null });

    const signal = new OpenClawDisconnectSignal(client);
    const router = new ClientRouter(
      client as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns,
      signal
    );
    const ws = createMockWs();

    const handlePromise = router.handleMessage(ws, {
      type: "message",
      content: "hi",
      agentId: "agent-1",
      clientMessageId: "cm-1",
    });

    // Let the starter chunk register the run.
    await new Promise((r) => setTimeout(r, 25));
    expect(activeRuns.size()).toBe(1);

    // OpenClaw drops. The real disconnect handler also closes the browser WS,
    // which detaches it from the run's listener set — simulate that so the
    // finally observes zero listeners (the condition that would otherwise log
    // run_completed_after_disconnect).
    client.emit("disconnected");
    activeRuns.removeListenerFromAll(ws);

    // Must resolve — without the abort, handleMessage would hang on the dead
    // generator forever and this await would time out.
    await handlePromise;

    // The leak is fixed: the run is gone from the registry.
    expect(activeRuns.size()).toBe(0);

    // ...and we did NOT misreport it as a completed run.
    const completedAfterDisconnect = mockAppendAuditLog.mock.calls.find(
      (c) => (c[0] as { eventType?: string })?.eventType === "chat.run_completed_after_disconnect"
    );
    expect(completedAfterDisconnect).toBeUndefined();
  });
});
