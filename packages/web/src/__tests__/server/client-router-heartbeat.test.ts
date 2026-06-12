/**
 * Heartbeat lazy-start contract for `ClientRouter.pipeStream` (#310 Tier 2c).
 *
 * The heartbeat must start on the FIRST chunk pipeStream observes — not
 * later, and not earlier:
 *
 * - Earlier (e.g. pre-loop): would mask a Gateway that hangs at request-
 *   receive time, because the client's stuck timer (60s) keeps resetting
 *   on each heartbeat tick. The user would sit in front of an infinite
 *   spinner instead of getting an "agent didn't respond" bubble.
 * - Later (e.g. on first text chunk): traps slow-first-token cases. If the
 *   model takes >60s to emit any text, the client stuck timer fires even
 *   though OC was actively processing the request the whole time.
 *
 * The "first chunk" sweet spot works for both classes of caller:
 *
 * - Client-originated messages (always have a `clientMessageId`): the first
 *   chunk IS `userMessagePersisted` — OC's `accepted` ack.
 * - Server-originated messages (cron, webhooks — no `clientMessageId`): the
 *   first chunk is `agent_start` (or `text` on older Gateway versions).
 *   Same heartbeat-safe property holds because either signals OC is busy
 *   processing.
 *
 * Both branches are tested here so a future refactor that conditions
 * heartbeat-start on chunk type can't silently regress one of them.
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

/**
 * Drive a pipeStream that yields one "starter" chunk, blocks on a
 * manually-released promise (simulating OC busy on a slow first token),
 * then yields a `done` chunk to let the handler finish cleanly.
 *
 * Returns the captured `thinking` frame count after the heartbeat
 * interval should have fired exactly once.
 *
 * Why this shape: testing setInterval reliably requires fake timers, but
 * vitest's `vi.useFakeTimers()` swaps the global setInterval. The
 * pipeStream's finally block clears the interval handle stored from
 * inside the fake-timer context. To avoid leaking that handle across
 * tests when we switch back to real timers, we advance fake time
 * THROUGH the entire stream lifecycle (release block, drain final
 * chunks, finally cleanup) before switching back. That way clearInterval
 * runs against the same fake-timer context that registered the handle.
 */
async function runHeartbeatScenario(starterChunk: ChatChunk, opts?: { clientMessageId?: string }) {
  vi.useFakeTimers();
  let restored = false;
  try {
    let releaseBlock: (() => void) | undefined;
    const blockPromise = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    const doneChunk: ChatChunk = { type: "done", text: "", runId: starterChunk.runId };
    const stream = (async function* () {
      yield starterChunk;
      await blockPromise;
      yield doneChunk;
    })();
    mockChat.mockReturnValue(stream);

    const activeRuns = new ActiveRuns();
    const sessionCache = new SessionCache();
    sessionCache.refresh([{ key: "agent:agent-1:direct:user-1" }]);
    mockFindFirst.mockResolvedValue(defaultAgent);
    mockUserFindFirst.mockResolvedValue({ id: "user-1", name: "Alice", context: null });

    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();

    const handlePromise = router.handleMessage(ws, {
      type: "message",
      content: "hi",
      agentId: "agent-1",
      ...(opts?.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
    });

    // Drain microtasks so the generator hits its first await and
    // pipeStream observes the starter chunk (registering the heartbeat).
    await vi.advanceTimersByTimeAsync(50);
    // Jump past one heartbeat interval; the lazy-started setInterval
    // should fire once on this advance.
    await vi.advanceTimersByTimeAsync(15_500);

    // Snapshot mid-stream count BEFORE releasing the block — proves the
    // heartbeat fired while OC was still "busy".
    const midStreamThinkingCount = ws.sent.filter((f) => f.type === "thinking").length;

    // Release the block so the handler can finish; advance enough fake
    // time to drain the final `done` chunk + the finally block's
    // clearInterval call. This keeps the entire interval lifecycle
    // inside the fake-timer context (no leaked handles across tests).
    releaseBlock?.();
    await vi.advanceTimersByTimeAsync(100);

    vi.useRealTimers();
    restored = true;
    await handlePromise;
    return midStreamThinkingCount;
  } finally {
    if (!restored) vi.useRealTimers();
  }
}

describe("ClientRouter heartbeat lazy-start (#310 Tier 2c)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts the heartbeat on `userMessagePersisted` for client-originated messages (clientMessageId set)", async () => {
    // The earliest possible first chunk for any client-originated
    // message. After this lands we know OC has the request and is
    // processing — heartbeats become safe to fire.
    const count = await runHeartbeatScenario(
      {
        type: "userMessagePersisted",
        clientMessageId: "cm-x",
        sessionKey: "agent:agent-1:direct:user-1",
        persistedAt: 0,
        runId: "run-hb-1",
      },
      { clientMessageId: "cm-x" }
    );
    // At least 2 thinking frames: the pre-loop one fired in handleMessage,
    // plus one heartbeat tick during the 15s blocked window.
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("starts the heartbeat on `agent_start` for server-originated messages (no clientMessageId)", async () => {
    // Cron jobs / webhooks don't set clientMessageId, so the first chunk
    // is `agent_start` (lifecycle phase=start) instead of
    // userMessagePersisted. The heartbeat policy must still fire — this
    // pins the docstring claim that the lazy-start works for ANY first
    // chunk type, not just the userMessagePersisted special case.
    const count = await runHeartbeatScenario({
      type: "agent_start",
      text: "",
      runId: "run-hb-2",
    });
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
