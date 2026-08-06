/**
 * A user abort is not a provider failure (#978).
 *
 * OpenClaw ends a stopped run by pushing the abort into the stream as an ERROR
 * — `decision=surface_error reason=none rawError=Request was aborted` in its
 * own log — and an error chunk carries nothing that separates that from a
 * provider blowing up. So the pipe gave the stop click the full failure
 * treatment: a `chat.agent_error` audit row, a durable banner reading *"The
 * model provider timed out."* that outlives a reload, and a terminal `error`
 * frame to the browser.
 *
 * Each of those is wrong on its own. Together they also caused the data loss
 * this issue is named for: the error bubble is what flips the client's
 * destructive-reconcile predicate, and the next history catch-up then adopts a
 * server history that has no record of the partial reply.
 *
 * The registry is what tells the two apart — `handleAbort` marks the run the
 * moment the stop frame arrives, and the pipe reads that rather than pattern-
 * matching the error text ("was aborted" is a phrase a provider may use for
 * its own failures).
 *
 * The complementary half — that a REAL error still gets all of this — is
 * covered by client-router.test.ts and client-router-liveness.test.ts; the last
 * test here pins it directly so this file cannot pass by suppressing
 * everything.
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
  mockRecordChatSessionError,
  mockSupersedeChatSessionErrors,
  mockAgentRanToolSince,
  mockGetUserGroupIds,
  mockGetAgentGroupIds,
} = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockChatAbort: vi.fn().mockResolvedValue({ ok: true, aborted: true }),
  mockSessionsHistory: vi.fn().mockResolvedValue({ messages: [] }),
  mockSessionsList: vi.fn().mockResolvedValue([]),
  mockFindFirst: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  mockRecordChatSessionError: vi.fn().mockResolvedValue(undefined),
  mockSupersedeChatSessionErrors: vi.fn().mockResolvedValue(undefined),
  mockAgentRanToolSince: vi.fn().mockResolvedValue(false),
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

vi.mock("@/db/schema", () => ({ agents: { id: "id" }, users: { id: "id" } }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn((col, val) => ({ col, val })) }));

vi.mock("@/lib/agent-access", () => ({
  assertAgentAccess: vi.fn(),
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

vi.mock("@/lib/audit-deferred", () => ({ recordAuditFailure: vi.fn() }));

vi.mock("@/server/chat-session-errors", () => ({
  recordChatSessionError: (...args: unknown[]) => mockRecordChatSessionError(...args),
  supersedeChatSessionErrors: (...args: unknown[]) => mockSupersedeChatSessionErrors(...args),
  agentRanToolSince: (...args: unknown[]) => mockAgentRanToolSince(...args),
}));

vi.mock("@/server/attachment-pipeline", () => ({
  processIncomingAttachments: vi.fn(async () => ({ chatAttachments: [], workspaceRefs: [] })),
  buildAttachmentBlock: () => "",
  parseAttachmentBlock: (s: string) => ({ cleanText: s, attachments: [] }),
  UploadValidationError: class UploadValidationError extends Error {},
}));

vi.mock("@/server/model-unavailable-throttle", () => ({
  shouldEmitModelUnavailableAudit: vi.fn().mockReturnValue(true),
  shouldEmitSilentStreamAudit: vi.fn().mockReturnValue(true),
}));

import { ActiveRuns } from "@/server/active-runs";
import { ClientRouter } from "@/server/client-router";
import { SessionCache } from "@/server/session-cache";

interface MockWs extends WebSocket {
  sent: Record<string, unknown>[];
}

function createMockWs(): MockWs {
  const sent: Record<string, unknown>[] = [];
  return {
    readyState: 1,
    send: vi.fn((data: string) => sent.push(JSON.parse(data))),
    sent,
  } as unknown as MockWs;
}

function buildClient() {
  return Object.assign(new EventEmitter(), {
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

const tick = () => new Promise<void>((r) => setImmediate(r));

/** What OpenClaw reports when the user stops a run that had started replying. */
const ABORT_ERROR: ChatChunk = { type: "error", text: "Request was aborted" } as ChatChunk;

function eventTypes(): string[] {
  return mockAppendAuditLog.mock.calls.map((c) => (c[0] as { eventType: string }).eventType);
}

describe("ClientRouter — a stop click is not a provider error (#978)", () => {
  let activeRuns: ActiveRuns;
  let sessionCache: SessionCache;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChatAbort.mockResolvedValue({ ok: true, aborted: true });
    activeRuns = new ActiveRuns();
    sessionCache = new SessionCache();
    sessionCache.refresh([{ key: "agent:agent-1:direct:user-1" }]);
    mockFindFirst.mockResolvedValue(defaultAgent);
    mockUserFindFirst.mockResolvedValue({ id: "user-1", name: "Alice", context: null });
  });

  function makeRouter() {
    return new ClientRouter(buildClient() as never, "user-1", "member", sessionCache, activeRuns);
  }

  /**
   * Drives the real sequence: a word streams, the user presses stop, and only
   * THEN does OpenClaw push the abort into the stream. Feeding the abort chunk
   * without the intervening `handleAbort` would test the failure path instead.
   */
  async function runStoppedMidStream(
    router: ClientRouter,
    ws: MockWs,
    tail: ChatChunk[] = [ABORT_ERROR, { type: "done", text: "" } as ChatChunk]
  ) {
    async function* stream(): AsyncGenerator<ChatChunk> {
      await tick();
      yield { type: "text", text: "lima", runId: "run-1" } as ChatChunk;
      await router.handleMessage(ws, { type: "abort", agentId: "agent-1" });
      for (const chunk of tail) {
        await tick();
        yield { ...chunk, runId: "run-1" } as ChatChunk;
      }
    }
    mockChat.mockReturnValue(stream());
    await router.handleMessage(ws, {
      type: "message",
      content: "please respond slowly",
      agentId: "agent-1",
    });
  }

  it("sends no error frame and no failed liveness for the abort", async () => {
    const router = makeRouter();
    const ws = createMockWs();

    await runStoppedMidStream(router, ws);

    expect(ws.sent.filter((f) => f.type === "error")).toEqual([]);
    expect(ws.sent.filter((f) => f.type === "liveness" && f.state === "failed")).toEqual([]);
    // The words that did arrive are still delivered, and the turn is closed —
    // "no error" must not be reached by dropping the stream on the floor.
    expect(ws.sent.some((f) => f.type === "chunk" && f.content === "lima")).toBe(true);
    expect(ws.sent.some((f) => f.type === "complete")).toBe(true);
  });

  it("persists no durable banner, so a reload does not blame the provider", async () => {
    const router = makeRouter();
    await runStoppedMidStream(router, createMockWs());

    expect(mockRecordChatSessionError).not.toHaveBeenCalled();
  });

  it("audits the abort once, as chat.run_aborted and not as chat.agent_error", async () => {
    const router = makeRouter();
    await runStoppedMidStream(router, createMockWs());

    expect(eventTypes()).toContain("chat.run_aborted");
    expect(eventTypes()).not.toContain("chat.agent_error");
  });

  it("does not fall through to the silent-stream net when stopped before the first word", async () => {
    const router = makeRouter();
    const ws = createMockWs();

    async function* stream(): AsyncGenerator<ChatChunk> {
      await tick();
      // A run registers on its first chunk; `userMessagePersisted` is OpenClaw's,
      // and carries no text — so this is a stop with nothing to preserve.
      yield { type: "userMessagePersisted", clientMessageId: "cm-1", runId: "run-1" } as ChatChunk;
      await router.handleMessage(ws, { type: "abort", agentId: "agent-1" });
      await tick();
      yield { ...ABORT_ERROR, runId: "run-1" } as ChatChunk;
    }
    mockChat.mockReturnValue(stream());
    await router.handleMessage(ws, { type: "message", content: "hi", agentId: "agent-1" });

    // Neither the abort's own error NOR the "the model said nothing" synthesis
    // that a naive suppression would leave behind — the user is the reason
    // nothing was said.
    expect(ws.sent.filter((f) => f.type === "error")).toEqual([]);
    expect(eventTypes()).not.toContain("chat.silent_stream");
  });

  it("treats the abort the same when it arrives as a rejection rather than a chunk", async () => {
    const router = makeRouter();
    const ws = createMockWs();

    async function* stream(): AsyncGenerator<ChatChunk> {
      await tick();
      yield { type: "text", text: "lima", runId: "run-1" } as ChatChunk;
      await router.handleMessage(ws, { type: "abort", agentId: "agent-1" });
      await tick();
      throw new Error("Request was aborted");
    }
    mockChat.mockReturnValue(stream());
    await router.handleMessage(ws, { type: "message", content: "hi", agentId: "agent-1" });

    expect(ws.sent.filter((f) => f.type === "error")).toEqual([]);
    expect(mockRecordChatSessionError).not.toHaveBeenCalled();
    // A rejection skips the loop's terminal frames, so the pipe has to close
    // the turn itself — otherwise a second tab watching this run spins forever.
    expect(ws.sent.some((f) => f.type === "complete")).toBe(true);
  });

  it("still reports a REAL provider error on a run nobody stopped", async () => {
    const router = makeRouter();
    const ws = createMockWs();

    async function* stream(): AsyncGenerator<ChatChunk> {
      await tick();
      yield { type: "text", text: "lima", runId: "run-1" } as ChatChunk;
      await tick();
      yield { type: "error", text: "upstream exploded", runId: "run-1" } as ChatChunk;
    }
    mockChat.mockReturnValue(stream());
    await router.handleMessage(ws, { type: "message", content: "hi", agentId: "agent-1" });

    expect(ws.sent.some((f) => f.type === "error")).toBe(true);
    expect(ws.sent.some((f) => f.type === "liveness" && f.state === "failed")).toBe(true);
    expect(mockRecordChatSessionError).toHaveBeenCalled();
    expect(eventTypes()).toContain("chat.agent_error");
  });

  it("does not carry the mark into the next turn", async () => {
    const router = makeRouter();
    const ws = createMockWs();
    await runStoppedMidStream(router, ws);

    // A fresh turn on the same session that genuinely fails must be reported.
    // The mark lives on the registry entry, and a new turn replaces the entry —
    // this is the assertion that keeps that true.
    const ws2 = createMockWs();
    async function* stream(): AsyncGenerator<ChatChunk> {
      await tick();
      yield { type: "error", text: "upstream exploded", runId: "run-2" } as ChatChunk;
    }
    mockChat.mockReturnValue(stream());
    await router.handleMessage(ws2, { type: "message", content: "again", agentId: "agent-1" });

    expect(ws2.sent.some((f) => f.type === "error")).toBe(true);
    expect(eventTypes()).toContain("chat.agent_error");
  });
});
