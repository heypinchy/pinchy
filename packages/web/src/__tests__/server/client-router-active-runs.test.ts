/**
 * Focused tests for the `ClientRouter` ↔ `ActiveRuns` wiring (#310 Tier 2a).
 *
 * Why a dedicated file: the existing `client-router.test.ts` is already
 * ~2500 lines and covers a lot of unrelated chat-streaming nuance. The
 * Tier 2 wiring has its own state machine (register on first chunk that
 * carries runId, touch on every chunk, audit-and-delete on terminal
 * states), and keeping its tests in their own file makes the contract
 * easy to find and protect from drift.
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
  return {
    ...actual,
    appendAuditLog: mockAppendAuditLog,
  };
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

// Suppress umbrella-error / throttle side-effects we don't care about here.
vi.mock("@/server/model-unavailable-throttle", () => ({
  shouldEmitModelUnavailableAudit: vi.fn().mockReturnValue(false),
  shouldEmitSilentStreamAudit: vi.fn().mockReturnValue(false),
  shouldEmitUpstreamFormatErrorAudit: vi.fn().mockReturnValue(false),
}));

import { ActiveRuns } from "@/server/active-runs";
import { ClientRouter } from "@/server/client-router";
import { SessionCache } from "@/server/session-cache";

// ── Fakes ────────────────────────────────────────────────────────────────

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

describe("ClientRouter ↔ ActiveRuns wiring (#310 Tier 2a)", () => {
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

  it("registers an ActiveRun on the first chunk carrying a runId, then deletes it on `done`", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", text: "Hello", runId: "run-abc" },
      { type: "done", text: "", runId: "run-abc" },
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

    // Snapshot registry size after each send so we can assert it was
    // non-zero at some point during the stream.
    const sizeSamples: number[] = [];
    (ws.send as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      sizeSamples.push(activeRuns.size());
    });

    await router.handleMessage(ws, {
      type: "message",
      content: "hi",
      agentId: "agent-1",
    });

    expect(sizeSamples.some((n) => n === 1)).toBe(true);
    expect(activeRuns.size()).toBe(0);
  });

  it("accumulates emitted text into the ActiveRun resume buffer for reconnect replay (Tier 2b)", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", text: "one ", runId: "run-acc" },
      { type: "text", text: "two ", runId: "run-acc" },
      { type: "text", text: "three", runId: "run-acc" },
      { type: "done", text: "", runId: "run-acc" },
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
    const sessionKey = "agent:agent-1:direct:user-1";

    // Sample the resume buffer on every broadcast so we can prove it grows as
    // the stream progresses and reaches the full emitted reply — this is what a
    // reconnecting client is re-seeded with via activeRun.partialContent.
    const contentSamples: string[] = [];
    (ws.send as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const run = activeRuns.get(sessionKey);
      if (run) contentSamples.push(run.currentContent);
    });

    await router.handleMessage(ws, {
      type: "message",
      content: "hi",
      agentId: "agent-1",
    });

    // The buffer reached the full reply mid-stream.
    expect(contentSamples).toContain("one two three");
    // And it only ever grew (prefix chain) while in-flight — never shrank.
    const nonEmpty = contentSamples.filter((s) => s.length > 0);
    for (let i = 1; i < nonEmpty.length; i++) {
      expect(nonEmpty[i]!.startsWith(nonEmpty[i - 1]!)).toBe(true);
    }
  });

  it("touches lastChunkAt as new chunks arrive (watchdog distinguishes 'progressing' from 'silent')", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", text: "Hi ", runId: "run-touch" },
      { type: "text", text: "there", runId: "run-touch" },
      { type: "done", text: "", runId: "run-touch" },
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

    const sessionKey = "agent:agent-1:direct:user-1";
    const lastChunkAtSamples: number[] = [];
    (ws.send as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const run = activeRuns.get(sessionKey);
      if (run) lastChunkAtSamples.push(run.lastChunkAt);
    });

    await router.handleMessage(ws, {
      type: "message",
      content: "hi",
      agentId: "agent-1",
    });

    // Strictly non-decreasing (touch only moves forward in time).
    for (let i = 1; i < lastChunkAtSamples.length; i++) {
      expect(lastChunkAtSamples[i]).toBeGreaterThanOrEqual(lastChunkAtSamples[i - 1]!);
    }
    expect(lastChunkAtSamples.length).toBeGreaterThan(0);
  });

  it("registers a PENDING run at dispatch time (firstChunkAt=null) and reconciles it to the real runId on the first chunk (B-1)", async () => {
    const tick = () => new Promise<void>((r) => setImmediate(r));
    let releaseChunk!: () => void;
    let releaseDone!: () => void;
    const chunkGate = new Promise<void>((r) => (releaseChunk = r));
    const doneGate = new Promise<void>((r) => (releaseDone = r));
    async function* gated(): AsyncGenerator<ChatChunk> {
      await chunkGate; // a backend that accepted the run but hasn't streamed yet
      yield { type: "text", text: "hi", runId: "real-run-99" };
      await doneGate;
      yield { type: "done", text: "", runId: "real-run-99" };
    }
    mockChat.mockReturnValue(gated());
    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();
    const sessionKey = "agent:agent-1:direct:user-1";

    const done = router.handleMessage(ws, {
      type: "message",
      content: "hi",
      agentId: "agent-1",
    });

    // Before any chunk: a PENDING run is already registered, so the watchdog
    // can see a backend that accepted the request but never started streaming.
    await tick();
    await tick();
    const pending = activeRuns.get(sessionKey);
    expect(pending).toBeDefined();
    expect(pending!.firstChunkAt).toBeNull();
    expect(pending!.userId).toBe("user-1");
    expect(pending!.agentName).toBe("Smithers");

    // First chunk arrives → reconciled to the real runId, no longer pending.
    releaseChunk();
    await tick();
    await tick();
    const started = activeRuns.get(sessionKey);
    expect(started!.firstChunkAt).not.toBeNull();
    expect(started!.runId).toBe("real-run-99");

    releaseDone();
    await done;
    expect(activeRuns.size()).toBe(0);
  });

  it("does NOT resurrect or double-signal when the watchdog tore down a pending run before its first chunk (C-1)", async () => {
    const tick = () => new Promise<void>((r) => setImmediate(r));
    let releaseDone!: () => void;
    const doneGate = new Promise<void>((r) => (releaseDone = r));
    // Mirror openclaw-node's post-abort behavior: after chatAbort the generator
    // drains and yields a synthetic terminal `done` (dist/index.js:511).
    async function* abortedThenDone(): AsyncGenerator<ChatChunk> {
      await doneGate;
      yield { type: "done", text: "", runId: "real-late" };
    }
    mockChat.mockReturnValue(abortedThenDone());
    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const ws = createMockWs();
    const sessionKey = "agent:agent-1:direct:user-1";

    const done = router.handleMessage(ws, {
      type: "message",
      content: "hi",
      agentId: "agent-1",
    });
    await tick();
    await tick();
    expect(activeRuns.get(sessionKey)?.firstChunkAt).toBeNull(); // pending

    // Simulate the watchdog tearing the pending run down (it deletes the entry
    // and aborts the stream, which is what produces the synthetic `done`).
    activeRuns.delete(sessionKey);

    releaseDone();
    await done;

    // No resurrection.
    expect(activeRuns.size()).toBe(0);
    // No duplicate audit — the watchdog already wrote chat.run_no_first_chunk;
    // pipeStream must NOT also fire the silent-stream synthesised error path.
    const errorAudits = mockAppendAuditLog.mock.calls.filter((c) =>
      ["chat.agent_error", "chat.silent_stream"].includes((c[0] as { eventType: string }).eventType)
    );
    expect(errorAudits).toEqual([]);
    // No contradictory second error frame to the client.
    expect(ws.sent.some((s) => s.includes("did not produce a response"))).toBe(false);
  });

  it("a finishing run does not delete a newer pending run that replaced it on the same session (S-1)", async () => {
    const tick = () => new Promise<void>((r) => setImmediate(r));
    let releaseDoneA!: () => void;
    const doneGateA = new Promise<void>((r) => (releaseDoneA = r));
    async function* genA(): AsyncGenerator<ChatChunk> {
      yield { type: "text", text: "A", runId: "real-A" };
      await doneGateA;
      yield { type: "done", text: "", runId: "real-A" };
    }
    mockChat.mockReturnValue(genA());
    const router = new ClientRouter(
      buildClient() as never,
      "user-1",
      "member",
      sessionCache,
      activeRuns
    );
    const wsA = createMockWs();
    const sessionKey = "agent:agent-1:direct:user-1";

    const doneA = router.handleMessage(wsA, {
      type: "message",
      content: "a",
      agentId: "agent-1",
    });
    await tick();
    await tick();
    expect(activeRuns.get(sessionKey)?.runId).toBe("real-A"); // A started

    // A rapid resend (run B) replaces the entry with a fresh pending run while
    // A is still finishing.
    const wsB = createMockWs();
    activeRuns.registerPending({
      runId: "msg-B",
      sessionKey,
      agentId: "agent-1",
      userId: "user-1",
      agentName: "Smithers",
      currentMessageId: "msg-B",
      submittedAt: 2_000_000,
      ws: wsB,
    });
    expect(activeRuns.get(sessionKey)?.runId).toBe("msg-B");

    // A finishes — its finally must NOT delete B's entry (identity mismatch).
    releaseDoneA();
    await doneA;

    const survivor = activeRuns.get(sessionKey);
    expect(survivor).toBeDefined();
    expect(survivor!.runId).toBe("msg-B"); // B survived A's teardown
  });

  it("emits chat.run_completed_after_disconnect when `done` arrives with zero listeners", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", text: "Hi", runId: "run-disc" },
      { type: "done", text: "", runId: "run-disc" },
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
    const sessionKey = "agent:agent-1:direct:user-1";

    // Simulate browser disconnect mid-stream: after the first send, the ws
    // flips to CLOSED and is dropped from the listener set.
    const sendSpy = ws.send as unknown as ReturnType<typeof vi.fn>;
    let firstCall = true;
    sendSpy.mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return;
      }
      (ws as unknown as { readyState: number }).readyState = 3; // CLOSED
      activeRuns.removeListenerFromAll(ws);
    });

    await router.handleMessage(ws, {
      type: "message",
      content: "hi",
      agentId: "agent-1",
    });

    expect(activeRuns.get(sessionKey)).toBeUndefined();
    const completedAfterDisconnect = mockAppendAuditLog.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === "chat.run_completed_after_disconnect"
    );
    expect(completedAfterDisconnect).toBeDefined();
    const detail = (completedAfterDisconnect![0] as { detail: Record<string, unknown> }).detail;
    expect(detail.sessionKey).toBe(sessionKey);
    expect(detail.runId).toBe("run-disc");
    expect(detail.agent).toEqual({ id: "agent-1", name: "Smithers" });
    expect(detail.user).toEqual({ id: "user-1" });
  });

  it("does NOT emit chat.run_completed_after_disconnect when listeners remain at `done`", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", text: "Hi", runId: "run-ok" },
      { type: "done", text: "", runId: "run-ok" },
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

    const ghost = mockAppendAuditLog.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === "chat.run_completed_after_disconnect"
    );
    expect(ghost).toBeUndefined();
  });

  it("deletes the entry on an `error` chunk so a follow-up retry can register a fresh run", async () => {
    const chunks: ChatChunk[] = [{ type: "error", text: "provider 500", runId: "run-err" }];
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

    expect(activeRuns.size()).toBe(0);
  });
});
