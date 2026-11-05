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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

vi.mock("@/lib/budgets", () => ({
  getExhaustedBlockingBudget: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/agent-access", () => ({
  assertAgentAccess: vi.fn(() => {}),
  effectiveVisibility: (v: string) => v,
  isPersonalAgentPausedFor: vi.fn().mockResolvedValue(false),
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
}));

import type { OpenClawClient } from "openclaw-node";
import { ActiveRuns, type ActiveRun } from "@/server/active-runs";
import { abortRunsOfUser, followUpDepsFor } from "@/server/abort-runs";
import { ClientRouter } from "@/server/client-router";
import { SessionCache } from "@/server/session-cache";
import {
  startFakeGateway,
  type FakeGateway,
  type FakeRun,
} from "@/test-helpers/fake-openclaw-gateway";

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
    // #824: the acting user is the row's actor, pseudonymized on write; a raw
    // id mirrored into the verbatim `detail` would survive crypto-erasure.
    // (The sessionKey is OpenClaw's address for the conversation, kept as is.)
    expect(detail).not.toHaveProperty("user");
    const { sessionKey: _address, ...rest } = detail;
    expect(JSON.stringify(rest)).not.toContain("user-1");
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

  describe("a run that was aborted, then ended with nobody watching", () => {
    // `chat.abort` ends the local stream with a plain `done` — no error
    // chunk, no OpenClaw disconnect. With the tab gone (closed by
    // deactivation, or closed right after the stop click) the run has zero
    // listeners at that `done`, which is exactly the shape of a reply that
    // finished for a browser that left. It didn't finish; it was stopped.
    const sessionKey = "agent:agent-1:direct:user-1";

    async function startGatedRun() {
      let releaseDone!: () => void;
      const doneGate = new Promise<void>((r) => (releaseDone = r));
      mockChat.mockReturnValue(
        (async function* (): AsyncGenerator<ChatChunk> {
          yield { type: "text", text: "Booking the invoices…", runId: "run-stopped" };
          await doneGate;
          yield { type: "done", text: "", runId: "run-stopped" };
        })()
      );
      const router = new ClientRouter(
        buildClient() as never,
        "user-1",
        "member",
        sessionCache,
        activeRuns
      );
      const ws = createMockWs();
      const handling = router.handleMessage(ws, {
        type: "message",
        content: "Book this month's invoices",
        agentId: "agent-1",
      });
      await vi.waitFor(() =>
        expect(activeRuns.get(sessionKey)?.firstChunkAt).toEqual(expect.any(Number))
      );
      const closeTab = () => {
        (ws as unknown as { readyState: number }).readyState = 3; // CLOSED
        activeRuns.removeListenerFromAll(ws);
      };
      return { router, ws, handling, releaseDone, closeTab };
    }

    function completedAfterDisconnectRows() {
      return mockAppendAuditLog.mock.calls.filter(
        (c) => (c[0] as { eventType: string }).eventType === "chat.run_completed_after_disconnect"
      );
    }

    it("is not recorded as completed when deactivation aborted it", async () => {
      const { handling, releaseDone, closeTab } = await startGatedRun();

      // DELETE /api/users/:id: the socket closes, then the run is aborted.
      closeTab();
      const aborted = await abortRunsOfUser("user-1", {
        activeRuns,
        chatAbort: mockChatAbort,
      });
      expect(aborted).toHaveLength(1);
      releaseDone();
      await handling;

      expect(mockChatAbort).toHaveBeenCalledWith(sessionKey, "run-stopped");
      expect(completedAfterDisconnectRows()).toEqual([]);
      expect(activeRuns.get(sessionKey)).toBeUndefined();
    });

    it("leaves the registry as soon as its stream ends, while the abort is still unanswered", async () => {
      // A reopened tab asks the registry whether a run is still going. Holding
      // the entry (and its heartbeat) until OpenClaw answers the abort — up to
      // the RPC timeout — would show it a spinner for a run that is over.
      mockChatAbort.mockReturnValueOnce(new Promise(() => {}));
      const { router, ws, handling, releaseDone } = await startGatedRun();

      void router.handleMessage(ws, { type: "abort", agentId: "agent-1" } as never);
      await vi.waitFor(() => expect(mockChatAbort).toHaveBeenCalledTimes(1));
      releaseDone();
      const ended = await Promise.race([
        handling.then(() => "ended"),
        new Promise((r) => setTimeout(() => r("still waiting"), 2_000)),
      ]);

      expect(ended).toBe("ended");
      expect(activeRuns.get(sessionKey)).toBeUndefined();
    });

    it("is not recorded as completed when the user stopped it and closed the tab", async () => {
      const { router, ws, handling, releaseDone, closeTab } = await startGatedRun();

      await router.handleMessage(ws, { type: "abort", agentId: "agent-1" } as never);
      closeTab();
      releaseDone();
      await handling;

      expect(mockChatAbort).toHaveBeenCalledWith(sessionKey, "run-stopped");
      expect(completedAfterDisconnectRows()).toEqual([]);
    });
  });

  describe("an abort that did not stop the run", () => {
    // These tests queue one-shot answers (`mockReturnValueOnce`); one a test
    // did not consume must not answer the next test's call.
    afterEach(() => {
      mockChat.mockReset();
      mockChatAbort.mockReset().mockResolvedValue(undefined);
    });

    // The `done` that ends a stopped run's stream is Pinchy's own: the
    // client ends the local stream the moment it sends `chat.abort`. Whether
    // the reply then completed anyway is the follow-up's question (see "on a
    // real openclaw-node client" below), never the stream's.
    const sessionKey = "agent:agent-1:direct:user-1";

    async function startGatedRun() {
      let releaseDone!: () => void;
      const doneGate = new Promise<void>((r) => (releaseDone = r));
      mockChat.mockReturnValue(
        (async function* (): AsyncGenerator<ChatChunk> {
          yield { type: "text", text: "Booking the invoices…", runId: "run-unstopped" };
          await doneGate;
          yield { type: "text", text: " Done.", runId: "run-unstopped" };
          yield { type: "done", text: "", runId: "run-unstopped" };
        })()
      );
      const router = new ClientRouter(
        buildClient() as never,
        "user-1",
        "member",
        sessionCache,
        activeRuns
      );
      const ws = createMockWs();
      const handling = router.handleMessage(ws, {
        type: "message",
        content: "Book this month's invoices",
        agentId: "agent-1",
      });
      await vi.waitFor(() =>
        expect(activeRuns.get(sessionKey)?.firstChunkAt).toEqual(expect.any(Number))
      );
      const closeTab = () => {
        (ws as unknown as { readyState: number }).readyState = 3; // CLOSED
        activeRuns.removeListenerFromAll(ws);
      };
      return { router, ws, handling, releaseDone, closeTab };
    }

    function completedAfterDisconnectRows() {
      return mockAppendAuditLog.mock.calls.filter(
        (c) => (c[0] as { eventType: string }).eventType === "chat.run_completed_after_disconnect"
      );
    }

    it("is not recorded as completed when the abort succeeded, even if OpenClaw answered after the stream ended", async () => {
      // OpenClaw ends the aborted run's stream and answers the abort RPC
      // independently; the `done` can win. "Not confirmed yet" is not
      // "failed" — and a stopped run's `done` is no completion either way.
      let answerAbort!: (res: unknown) => void;
      mockChatAbort.mockReturnValueOnce(new Promise((r) => (answerAbort = r)));
      const { handling, releaseDone, closeTab } = await startGatedRun();

      closeTab();
      const aborting = abortRunsOfUser("user-1", { activeRuns, chatAbort: mockChatAbort });
      releaseDone();
      await new Promise<void>((r) => setTimeout(r, 20));
      answerAbort({ ok: true, aborted: true, runIds: ["run-unstopped"] });
      await aborting;
      await handling;

      expect(completedAfterDisconnectRows()).toEqual([]);
    });
  });

  describe("a run stopped before OpenClaw started it", () => {
    // These tests queue one-shot answers (`mockReturnValueOnce`); one a test
    // did not consume must not answer the next test's call.
    afterEach(() => {
      mockChat.mockReset();
      mockChatAbort.mockReset().mockResolvedValue(undefined);
    });

    // A pending run is aborted by session only. If OpenClaw has not started it
    // yet — the dispatch-race retry is between attempts, or the dispatch is
    // still on its way — that abort answers `aborted: false` and stops nothing.
    const sessionKey = "agent:agent-1:direct:user-1";

    function clientWithoutAgentsList() {
      // No `agents.list` RPC: the dispatch-race retry falls back to backoff.
      return Object.assign(buildClient(), { hasMethod: () => false });
    }

    const stoppers: Array<[string, (router: ClientRouter, ws: MockWs) => Promise<unknown>]> = [
      [
        "the stop button",
        (router, ws) => router.handleMessage(ws, { type: "abort", agentId: "agent-1" } as never),
      ],
      [
        "deactivation",
        () =>
          abortRunsOfUser("user-1", {
            activeRuns,
            chatAbort: mockChatAbort,
            requestedBy: "admin-1",
          }),
      ],
    ];

    it.each(stoppers)(
      "is not dispatched again by the dispatch-race retry after %s",
      async (_label, stop) => {
        let releaseRace!: () => void;
        const raceGate = new Promise<void>((r) => (releaseRace = r));
        mockChat
          .mockReturnValueOnce(
            (async function* (): AsyncGenerator<ChatChunk> {
              await raceGate;
              yield {
                type: "error",
                text: 'invalid agent params: unknown agent id "agent-1"',
                runId: "r0",
              };
            })()
          )
          .mockReturnValueOnce(
            makeChunkStream([
              { type: "text", text: "Booked.", runId: "run-redispatched" },
              { type: "done", text: "", runId: "run-redispatched" },
            ])
          );
        mockChatAbort.mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] });
        const router = new ClientRouter(
          clientWithoutAgentsList() as never,
          "user-1",
          "member",
          sessionCache,
          activeRuns
        );
        const ws = createMockWs();
        const handling = router.handleMessage(ws, {
          type: "message",
          content: "Book this month's invoices",
          agentId: "agent-1",
        });
        await vi.waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
        expect(activeRuns.get(sessionKey)?.firstChunkAt).toBeNull();

        await stop(router, ws);
        expect(mockChatAbort).toHaveBeenCalledWith(sessionKey, undefined);
        releaseRace();
        await handling;

        expect(mockChat).toHaveBeenCalledTimes(1);
        expect(activeRuns.get(sessionKey)).toBeUndefined();
      }
    );

    it.each([
      ["the stop button", "user-1", "user_request"],
      ["deactivation", "admin-1", "account_deactivated"],
    ] as const)(
      "records that the stop took effect when the retry did not dispatch it again after %s",
      async (label, actorId, reason) => {
        let releaseRace!: () => void;
        const raceGate = new Promise<void>((r) => (releaseRace = r));
        mockChat.mockReturnValueOnce(
          (async function* (): AsyncGenerator<ChatChunk> {
            await raceGate;
            yield {
              type: "error",
              text: 'invalid agent params: unknown agent id "agent-1"',
              runId: "r0",
            };
          })()
        );
        mockChatAbort.mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] });
        const router = new ClientRouter(
          clientWithoutAgentsList() as never,
          "user-1",
          "member",
          sessionCache,
          activeRuns
        );
        const ws = createMockWs();
        const handling = router.handleMessage(ws, {
          type: "message",
          content: "Book this month's invoices",
          agentId: "agent-1",
        });
        await vi.waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));

        await stoppers.find(([l]) => l === label)![1](router, ws);
        releaseRace();
        await handling;

        const rows = mockAppendAuditLog.mock.calls
          .map(
            (c) => c[0] as { eventType: string; actorId: string; detail: unknown; outcome: string }
          )
          .filter((row) => row.eventType === "chat.run_aborted");
        // The deactivation's own first row is the route's to write; the stop
        // button writes it through the router.
        expect(rows.at(-1)).toEqual({
          actorType: "user",
          actorId,
          eventType: "chat.run_aborted",
          resource: "agent:agent-1",
          // No sessionKey: it names the run's user by raw id (#824).
          detail: {
            agent: { id: "agent-1", name: "Smithers" },
            runId: null,
            reason,
            followUp: "stopped_before_dispatch",
          },
          outcome: "success",
        });
        expect(JSON.stringify(rows.at(-1)?.detail)).not.toContain("user-1");
      }
    );
  });

  describe("on a real openclaw-node client", () => {
    // Driven through the real client against a fake gateway
    // (`test-helpers/fake-openclaw-gateway.ts`), because the client's own
    // behaviour is what these depend on: `chatAbort` ends the local stream at
    // once, and that stream then yields a plain `done` carrying the run's id —
    // before OpenClaw answered, whether or not OpenClaw stopped anything. For a
    // run OpenClaw has not accepted yet, that `done` is the first chunk Pinchy
    // sees, and both early aborts (by session, then by that runId) find
    // nothing. OpenClaw then accepts the run and executes it, tools included.
    const sessionKey = "agent:agent-1:direct:user-1";
    let gw: FakeGateway;
    let client: OpenClawClient;
    // Every run a test started, so each one's follow-up can be awaited before
    // the gateway goes away.
    let started: ActiveRun[];

    beforeEach(async () => {
      gw = await startFakeGateway();
      client = await gw.connectClient();
      started = [];
      const register = activeRuns.registerPending.bind(activeRuns);
      vi.spyOn(activeRuns, "registerPending").mockImplementation((input) => {
        const run = register(input);
        started.push(run);
        return run;
      });
    });

    afterEach(async () => {
      // Let a follow-up still waiting for acceptance end: accept, so its next
      // abort is confirmed.
      for (const r of gw.runs.values()) if (r.state === "received") gw.accept(r.runId);
      for (const run of started) await run.abortFollowUp;
      await gw.close();
    });

    function router() {
      return new ClientRouter(client as never, "user-1", "member", sessionCache, activeRuns);
    }

    async function send(r: ClientRouter, index: number) {
      const ws = createMockWs();
      const handling = r.handleMessage(ws, {
        type: "message",
        content: index === 0 ? "Book this month's invoices" : "Actually, just list them",
        agentId: "agent-1",
      });
      await vi.waitFor(() => expect(gw.runAt(index)).toBeDefined());
      return { ws, handling, gwRun: gw.runAt(index)!, run: started.at(index)! };
    }

    const stoppers: Array<[string, (r: ClientRouter, ws: MockWs) => Promise<unknown>]> = [
      [
        "the stop button",
        (r, ws) => r.handleMessage(ws, { type: "abort", agentId: "agent-1" } as never),
      ],
      [
        "deactivation",
        () =>
          abortRunsOfUser("user-1", {
            activeRuns,
            chatAbort: (key, id) => client.chatAbort(key, id),
            requestedBy: "admin-1",
            followUp: followUpDepsFor(() => client),
          }),
      ],
    ];

    /**
     * Hold the pipe in its post-run file delivery (`artifacts.list`): the run
     * stays registered, and the stop button showing, until `release()`.
     */
    function holdArtifacts() {
      let release!: () => void;
      const held = new Promise<void>((res) => (release = res));
      let polling = false;
      const request = client.request.bind(client);
      (client as unknown as { request: typeof client.request }).request = (async (
        method: string,
        params?: unknown
      ) => {
        if (method === "artifacts.list") {
          polling = true;
          await held;
        }
        return request(method as never, params as never);
      }) as never;
      return { polling: () => polling, release };
    }

    function auditRows(eventType: string) {
      return mockAppendAuditLog.mock.calls
        .map(
          (c) =>
            c[0] as {
              eventType: string;
              actorId: string;
              detail: Record<string, unknown>;
              outcome: string;
            }
        )
        .filter((row) => row.eventType === eventType);
    }

    it.each(stoppers)(
      "is aborted again by its real runId when its first chunk arrives after %s",
      async (_label, stop) => {
        const r = router();
        const { ws, handling, gwRun } = await send(r, 0);

        await stop(r, ws);
        await handling;
        await vi.waitFor(() => expect(gw.aborts).toHaveLength(2));

        expect(gw.aborts).toEqual([
          { sessionKey, runId: undefined, aborted: false },
          { sessionKey, runId: gwRun.runId, aborted: false },
        ]);
      }
    );

    it.each(stoppers)(
      "is still aborted when OpenClaw accepts it only after both early aborts (%s)",
      async (_label, stop) => {
        const r = router();
        const { ws, handling, gwRun, run } = await send(r, 0);

        await stop(r, ws);
        await handling;
        await vi.waitFor(() => expect(gw.aborts).toHaveLength(2));
        expect(gw.aborts.every((a) => !a.aborted)).toBe(true);

        // OpenClaw finishes preparing the run and starts it.
        gw.accept(gwRun.runId);
        await vi.waitFor(() => expect(gwRun.state).toBe("aborted"), { timeout: 5_000 });
        // The model gets to its tool — on a run that is no longer running.
        expect(gw.runTool(gwRun.runId, "odoo_write")).toBe(false);
        await run.abortFollowUp;

        expect(gwRun.toolsRun).toEqual([]);
        expect(ws.sent.some((f) => f.includes("odoo_write"))).toBe(false);
        expect(auditRows("chat.run_completed_after_disconnect")).toEqual([]);
        // The trail ends on the abort that took effect, by the real runId.
        expect(auditRows("chat.run_aborted").at(-1)).toEqual(
          expect.objectContaining({
            outcome: "success",
            detail: expect.objectContaining({
              runId: gwRun.runId,
              followUp: "aborted_by_run_id",
            }),
          })
        );
      }
    );

    it("never cuts off the user's next turn on the same session while it follows up", async () => {
      const r = router();
      const first = await send(r, 0);
      await r.handleMessage(first.ws, { type: "abort", agentId: "agent-1" } as never);
      await first.handling;
      await vi.waitFor(() => expect(gw.aborts).toHaveLength(2));

      // The user asks again while OpenClaw is still preparing the stopped run.
      const second = await send(r, 1);
      gw.accept(second.gwRun.runId);
      // At least one follow-up for the first run goes out during the new turn…
      await vi.waitFor(() => expect(gw.aborts.length).toBeGreaterThanOrEqual(3), {
        timeout: 5_000,
      });
      // …and the new turn's stream still delivers what comes after it.
      gw.emitText(second.gwRun.runId, "Here they are.");
      gw.finish(second.gwRun.runId);
      await second.handling;

      expect(gw.aborts.every((a) => a.runId !== second.gwRun.runId)).toBe(true);
      expect(second.gwRun.state).toBe("ended");
      expect(second.ws.sent.some((f) => f.includes("Here they are."))).toBe(true);
    });

    it("is not aborted a second time when OpenClaw already confirmed the first abort", async () => {
      const r = router();
      const { ws, handling, gwRun } = await send(r, 0);
      // Running on OpenClaw, but nothing of it has reached Pinchy yet.
      gw.accept(gwRun.runId, { silent: true });

      await r.handleMessage(ws, { type: "abort", agentId: "agent-1" } as never);
      await handling;
      await started[0].abortFollowUp;

      expect(gw.aborts).toEqual([{ sessionKey, runId: undefined, aborted: true }]);
    });

    it.each(stoppers)(
      "is still aborted by its runId when %s's abort by session stopped an earlier turn instead",
      async (_label, stop) => {
        // A pending turn is aborted by session, and OpenClaw answers with every
        // run that abort stopped. Here that is an EARLIER turn of the same
        // session — stopped while OpenClaw prepared it, and started by OpenClaw
        // before its own follow-up got to it. Its `aborted: true` says nothing
        // about this turn, which OpenClaw starts afterwards, tools included.
        const r = router();
        const t0 = await send(r, 0);
        await r.handleMessage(t0.ws, { type: "abort", agentId: "agent-1" } as never);
        await t0.handling;
        await vi.waitFor(() => expect(gw.aborts).toHaveLength(2));
        const t1 = await send(r, 1);

        gw.accept(t0.gwRun.runId);
        await stop(r, t1.ws);
        await t1.handling;
        expect(t0.gwRun.state).toBe("aborted");
        // OpenClaw starts this turn now.
        gw.accept(t1.gwRun.runId);
        await vi.waitFor(() => expect(t1.gwRun.state).toBe("aborted"), { timeout: 5_000 });
        expect(gw.runTool(t1.gwRun.runId, "odoo_write")).toBe(false);
        await t1.run.abortFollowUp;

        expect(t1.gwRun.toolsRun).toEqual([]);
        expect(gw.aborts).toContainEqual({
          sessionKey,
          runId: t1.gwRun.runId,
          aborted: true,
        });
        // The only success on the trail is the abort that stopped THIS turn —
        // not a row crediting it with the earlier turn's stop.
        expect(auditRows("chat.run_aborted").filter((row) => row.outcome === "success")).toEqual([
          expect.objectContaining({
            detail: expect.objectContaining({
              runId: t1.gwRun.runId,
              followUp: "aborted_by_run_id",
            }),
          }),
        ]);
      }
    );

    it.each(stoppers)(
      "is neither aborted again nor recorded as completed when %s lands after the reply streamed in full",
      async (_label, stop) => {
        // OpenClaw finished the reply and the tab has all of it, but the pipe
        // is still asking OpenClaw for the run's files, so it has not sent
        // `complete` yet: the stop button still shows. A stop now stops
        // nothing, because nothing is running — that is not a reply that
        // "completed with nobody receiving it".
        const artifacts = holdArtifacts();
        const r = router();
        const t0 = await send(r, 0);
        gw.accept(t0.gwRun.runId);
        gw.emitText(t0.gwRun.runId, "All booked.");
        gw.finish(t0.gwRun.runId);
        await vi.waitFor(() => expect(artifacts.polling()).toBe(true));
        expect(activeRuns.get(sessionKey)).toBeDefined();

        await stop(r, t0.ws);
        artifacts.release();
        await t0.handling;
        await t0.run.abortFollowUp;

        expect(t0.ws.sent.some((f) => f.includes("All booked."))).toBe(true);
        expect(gw.aborts.filter((a) => a.runId !== undefined)).toEqual([]);
        expect(gw.calls.some((c) => c.method === "agent.wait")).toBe(false);
        expect(auditRows("chat.run_completed_after_disconnect")).toEqual([]);
        expect(auditRows("chat.run_aborted")).toEqual([]);
      }
    );

    it.each(stoppers)(
      "is not aborted again when %s lands after OpenClaw confirmed the first stop",
      async (label, stop) => {
        // The user stopped the reply and OpenClaw confirmed it, but the pipe is
        // still asking OpenClaw for the run's files, so the run is still
        // registered. A second stop — deactivation, or a click in another tab —
        // finds nothing running. Aborting again would get `aborted: false` and
        // end the trail on a failed abort, which reads "the stop was never
        // confirmed" — false.
        const artifacts = holdArtifacts();
        const r = router();
        const t0 = await send(r, 0);
        gw.accept(t0.gwRun.runId);
        gw.emitText(t0.gwRun.runId, "Working");
        await vi.waitFor(() => expect(t0.run.firstChunkAt).not.toBeNull());
        await r.handleMessage(t0.ws, { type: "abort", agentId: "agent-1" } as never);
        await vi.waitFor(() => expect(artifacts.polling()).toBe(true));
        expect(activeRuns.get(sessionKey)).toBe(t0.run);
        expect(t0.run.abortConfirmed).toBe(true);
        const chatAbort = vi.spyOn(client, "chatAbort");

        const result = await stop(r, t0.ws);
        artifacts.release();
        await t0.handling;
        await t0.run.abortFollowUp;

        // No abort named the run again (a click with nothing in flight still
        // reaches the gateway by session — a safe no-op).
        expect(chatAbort.mock.calls.filter(([, runId]) => runId !== undefined)).toEqual([]);
        expect(gw.aborts.filter((a) => a.runId !== undefined)).toEqual([
          { sessionKey, runId: t0.gwRun.runId, aborted: true },
        ]);
        // What the docs say a second stop sends: a click, like any click with
        // nothing in flight, still sends OpenClaw's abort by session;
        // deactivation sends nothing at all.
        if (label === "the stop button") {
          expect(chatAbort.mock.calls).toEqual([[sessionKey, undefined]]);
        } else {
          expect(chatAbort).not.toHaveBeenCalled();
        }
        // Deactivation writes one row per run it returns; there is none.
        if (label === "deactivation") expect(result).toEqual([]);
        // The trail ends on the confirmed stop.
        expect(auditRows("chat.run_aborted")).toEqual([
          expect.objectContaining({
            outcome: "success",
            detail: expect.objectContaining({ runId: t0.gwRun.runId, reason: "user_request" }),
          }),
        ]);
      }
    );

    /**
     * Let the first `chat.abort` reach OpenClaw and be answered, but hold the
     * answer back from Pinchy until `release()`: the stop has taken effect,
     * and Pinchy does not know it yet.
     */
    function holdFirstAbortAnswer() {
      let release!: () => void;
      const held = new Promise<void>((res) => (release = res));
      let aborts = 0;
      const request = client.request.bind(client);
      (client as unknown as { request: typeof client.request }).request = (async (
        method: string,
        params?: unknown
      ) => {
        if (method === "chat.abort" && aborts++ === 0) {
          const answer = await request(method as never, params as never);
          await held;
          return answer;
        }
        return request(method as never, params as never);
      }) as never;
      return { release };
    }

    it.each([
      [0, 1],
      [1, 0],
    ] as const)(
      "ends the trail on the confirmed stop when a second stop lands while the first's answer is on its way (stoppers %i then %i)",
      async (firstIndex, secondIndex) => {
        // The stop button and deactivation (either first): the first abort
        // stops the run, and while OpenClaw's `aborted: true` is still on its
        // way the run still looks in flight — so the second stop aborts it
        // again by runId and gets `aborted: false`. A failed row after the
        // first one's success would read "the stop was never confirmed".
        const artifacts = holdArtifacts();
        const r = router();
        const t0 = await send(r, 0);
        gw.accept(t0.gwRun.runId);
        gw.emitText(t0.gwRun.runId, "Working");
        await vi.waitFor(() => expect(t0.run.firstChunkAt).not.toBeNull());
        const firstAnswer = holdFirstAbortAnswer();
        const [, firstStop] = stoppers[firstIndex];
        const [, secondStop] = stoppers[secondIndex];

        const first = firstStop(r, t0.ws);
        await vi.waitFor(() =>
          expect(gw.aborts).toEqual([{ sessionKey, runId: t0.gwRun.runId, aborted: true }])
        );
        const second = secondStop(r, t0.ws);
        await vi.waitFor(() => expect(gw.aborts).toHaveLength(2));
        firstAnswer.release();
        const results = await Promise.all([first, second]);
        artifacts.release();
        await t0.handling;
        await t0.run.abortFollowUp;

        expect(t0.gwRun.toolsRun).toEqual([]);
        // Nothing pursued the run after it: it was stopped.
        expect(gw.aborts).toHaveLength(2);
        // One row for the stop: the button's own, or the one the deactivation
        // route writes for the run it returns — and nothing after it.
        const deactivationResult = results[firstIndex === 1 ? 0 : 1] as Array<{
          outcome: string;
        }>;
        const buttonRows = auditRows("chat.run_aborted");
        if (firstIndex === 0) {
          expect(buttonRows).toEqual([
            expect.objectContaining({
              outcome: "success",
              detail: expect.objectContaining({ runId: t0.gwRun.runId, reason: "user_request" }),
            }),
          ]);
          expect(deactivationResult).toEqual([]);
        } else {
          expect(deactivationResult).toEqual([
            expect.objectContaining({ runId: t0.gwRun.runId, outcome: "success" }),
          ]);
          expect(buttonRows).toEqual([]);
        }
      }
    );

    it.each(stoppers)(
      "is still aborted when %s lands after a stop OpenClaw did not confirm",
      async (label, stop) => {
        // The first stop reached OpenClaw before it accepted the run, so it
        // stopped nothing — the run is still on its way. A second stop must not
        // treat it as stopped.
        const artifacts = holdArtifacts();
        const r = router();
        const t0 = await send(r, 0);
        await r.handleMessage(t0.ws, { type: "abort", agentId: "agent-1" } as never);
        await vi.waitFor(() => expect(artifacts.polling()).toBe(true));
        expect(activeRuns.get(sessionKey)).toBe(t0.run);
        expect(t0.run.abortConfirmed).not.toBe(true);
        const chatAbort = vi.spyOn(client, "chatAbort");

        const result = await stop(r, t0.ws);

        expect(chatAbort).toHaveBeenCalledWith(sessionKey, t0.gwRun.runId);
        if (label === "deactivation") {
          expect(result).toEqual([expect.objectContaining({ runId: t0.gwRun.runId })]);
        } else {
          expect(auditRows("chat.run_aborted")).toHaveLength(2);
        }

        // OpenClaw starts it now, and the follow-up stops it.
        gw.accept(t0.gwRun.runId);
        await vi.waitFor(() => expect(t0.gwRun.state).toBe("aborted"), { timeout: 5_000 });
        artifacts.release();
        await t0.handling;
        await t0.run.abortFollowUp;
        expect(auditRows("chat.run_aborted").at(-1)).toEqual(
          expect.objectContaining({
            outcome: "success",
            detail: expect.objectContaining({
              runId: t0.gwRun.runId,
              followUp: "aborted_by_run_id",
            }),
          })
        );
      }
    );

    it("is not aborted at all when nobody stopped it", async () => {
      const r = router();
      const { handling, gwRun } = await send(r, 0);

      gw.accept(gwRun.runId);
      gw.emitText(gwRun.runId, "Booked.");
      gw.finish(gwRun.runId);
      await handling;

      expect(gw.aborts).toEqual([]);
    });

    describe("a history re-pull right after the user stopped a reply (#1301)", () => {
      // Stopping a reply clears the client's running flag, which re-opens its
      // history catch-up: the poke for the aborted partial, or a window focus,
      // re-pulls history while the stopped run is still registered (its pipe
      // is still asking OpenClaw for the run's files). The re-pull asks
      // `agent.wait` about that run, and OpenClaw answers a stopped run with
      // `status: "error"` and `stopReason: "rpc"`. That must never reach the
      // chat as a failure: not on the stopped turn, and not on the turn the
      // user sent next, which is still running.

      /** Hold every `method` request until `release()`. */
      function holdRequest(method: string) {
        let release!: () => void;
        const held = new Promise<void>((res) => (release = res));
        let reached = false;
        const request = client.request.bind(client);
        (client as unknown as { request: typeof client.request }).request = (async (
          m: string,
          params?: unknown
        ) => {
          if (m === method) {
            reached = true;
            await held;
          }
          return request(m as never, params as never);
        }) as never;
        return { reached: () => reached, release };
      }

      function failedVerdicts(ws: MockWs) {
        return ws.sent
          .map((f) => JSON.parse(f) as Record<string, unknown>)
          .filter((f) => f.type === "liveness" && f.state === "failed");
      }

      /** A started reply on `ws`, stopped by the user, still registered. */
      async function stoppedReply(r: ClientRouter) {
        const artifacts = holdArtifacts();
        const t0 = await send(r, 0);
        gw.accept(t0.gwRun.runId);
        gw.emitText(t0.gwRun.runId, "Booking the first invoice");
        await vi.waitFor(() =>
          expect(t0.ws.sent.some((f) => f.includes("Booking the first invoice"))).toBe(true)
        );
        await r.handleMessage(t0.ws, { type: "abort", agentId: "agent-1" } as never);
        await vi.waitFor(() => expect(t0.gwRun.state).toBe("aborted"));
        await vi.waitFor(() => expect(artifacts.polling()).toBe(true));
        expect(activeRuns.get(sessionKey)?.runId).toBe(t0.gwRun.runId);
        return { ...t0, artifacts };
      }

      it("does not report the stopped reply as failed", async () => {
        const r = router();
        const t0 = await stoppedReply(r);

        await r.handleMessage(t0.ws, { type: "history", agentId: "agent-1" });
        t0.artifacts.release();
        await t0.handling;

        expect(failedVerdicts(t0.ws)).toEqual([]);
        expect(t0.ws.sent.some((f) => f.includes('"rpc"'))).toBe(false);
      });

      /** Every frame `ws` received from index `from` on. */
      function framesSince(ws: MockWs, from: number) {
        return ws.sent.slice(from).map((f) => JSON.parse(f) as Record<string, unknown>);
      }

      /**
       * The user sends the next message while a history re-pull is under way;
       * resolves once that turn is streaming.
       */
      async function nextTurnDuringRepull(r: ClientRouter, ws: MockWs) {
        const history = holdRequest("chat.history");
        const repull = r.handleMessage(ws, { type: "history", agentId: "agent-1" });
        await vi.waitFor(() => expect(history.reached()).toBe(true));
        const handling = r.handleMessage(ws, {
          type: "message",
          content: "Actually, just list them",
          agentId: "agent-1",
        });
        await vi.waitFor(() => expect(gw.runAt(1)).toBeDefined());
        const gwRun = gw.runAt(1)!;
        gw.accept(gwRun.runId);
        gw.emitText(gwRun.runId, "Here they are");
        await vi.waitFor(() => expect(ws.sent.some((f) => f.includes("Here they are"))).toBe(true));
        return { history, repull, handling, gwRun };
      }

      it("sends the next turn no verdict about the stopped reply", async () => {
        const r = router();
        const t0 = await stoppedReply(r);
        const t1 = await nextTurnDuringRepull(r, t0.ws);

        // The re-pull now asks about the stopped reply, while the next one runs.
        const from = t0.ws.sent.length;
        t1.history.release();
        await t1.repull;
        // Not even `completed`: it would end the turn that is still running.
        expect(framesSince(t0.ws, from).filter((f) => f.type === "liveness")).toEqual([]);

        t0.artifacts.release();
        await t0.handling;
        gw.finish(t1.gwRun.runId);
        await t1.handling;
        expect(failedVerdicts(t0.ws)).toEqual([]);
        expect(t0.ws.sent.some((f) => f.includes('"rpc"'))).toBe(false);
      });

      it("does not end the next turn when the stopped reply's pipe winds down", async () => {
        const r = router();
        const t0 = await stoppedReply(r);
        const t1 = await nextTurnDuringRepull(r, t0.ws);
        t1.history.release();
        await t1.repull;

        // The stopped reply's file delivery returns while the next turn runs.
        const from = t0.ws.sent.length;
        t0.artifacts.release();
        await t0.handling;
        const terminal = (f: Record<string, unknown>) =>
          f.type === "complete" || f.type === "liveness" || f.type === "error";
        expect(framesSince(t0.ws, from).filter(terminal)).toEqual([]);

        // The next turn still ends on its own `complete`.
        gw.finish(t1.gwRun.runId);
        await t1.handling;
        expect(framesSince(t0.ws, from).filter((f) => f.type === "complete")).toHaveLength(1);
      });

      it("does not fail the next turn when the reply was stopped before its first word", async () => {
        const artifacts = holdArtifacts();
        const r = router();
        const t0 = await send(r, 0);
        gw.accept(t0.gwRun.runId, { silent: true });
        await r.handleMessage(t0.ws, { type: "abort", agentId: "agent-1" } as never);
        await vi.waitFor(() => expect(artifacts.polling()).toBe(true));

        const t1 = await nextTurnDuringRepull(r, t0.ws);
        t1.history.release();
        await t1.repull;
        const from = t0.ws.sent.length;
        artifacts.release();
        await t0.handling;

        // A stop with no words is still a stop, not "the model did not produce
        // a response" — even once the next turn holds the session.
        expect(
          framesSince(t0.ws, from).filter((f) => f.type === "error" || f.type === "liveness")
        ).toEqual([]);
        gw.finish(t1.gwRun.runId);
        await t1.handling;
        expect(failedVerdicts(t0.ws)).toEqual([]);
      });
    });

    describe("after the dispatch-race retry sent it again", () => {
      // OpenClaw accepted the first attempt and failed it resolving the model
      // ("Unknown model" — the provider block had not applied yet), so the
      // retry dispatched the reply again, which OpenClaw runs under a NEW
      // runId. The registry was reconciled to the first one on its ack; a stop
      // that names that finished attempt stops nothing.
      async function retriedRun() {
        const r = router();
        const first = await send(r, 0);
        gw.accept(first.gwRun.runId);
        gw.fail(first.gwRun.runId, "FailoverError: Unknown model: acme/not-yet-applied");
        await vi.waitFor(() => expect(gw.runAt(1)).toBeDefined(), { timeout: 5_000 });
        return { r, ...first, retry: gw.runAt(1)! };
      }

      it.each(stoppers)(
        "stops the attempt OpenClaw is running when %s stops it mid-reply",
        async (_label, stop) => {
          const { r, ws, handling, run, retry } = await retriedRun();
          gw.accept(retry.runId);
          gw.emitText(retry.runId, "Booking the invoices…");
          await vi.waitFor(() =>
            expect(ws.sent.some((f) => f.includes("Booking the invoices"))).toBe(true)
          );

          await stop(r, ws);
          await handling;
          await run.abortFollowUp;

          expect(gw.aborts[0]).toEqual({ sessionKey, runId: retry.runId, aborted: true });
          expect(retry.state).toBe("aborted");
          expect(gw.runTool(retry.runId, "odoo_write")).toBe(false);
          expect(retry.toolsRun).toEqual([]);
          expect(auditRows("chat.run_completed_after_disconnect")).toEqual([]);
        }
      );

      it.each(stoppers)(
        "stops the attempt when %s lands while OpenClaw is still preparing it",
        async (_label, stop) => {
          const { r, ws, handling, run, retry } = await retriedRun();

          await stop(r, ws);
          await handling;
          // OpenClaw finishes preparing the retried attempt and starts it.
          gw.accept(retry.runId);
          await vi.waitFor(() => expect(retry.state).toBe("aborted"), { timeout: 5_000 });
          expect(gw.runTool(retry.runId, "odoo_write")).toBe(false);
          await run.abortFollowUp;

          expect(retry.toolsRun).toEqual([]);
          expect(gw.aborts.filter((a) => a.aborted)).toEqual([
            { sessionKey, runId: retry.runId, aborted: true },
          ]);
          expect(auditRows("chat.run_completed_after_disconnect")).toEqual([]);
        }
      );
    });

    it.each(stoppers)(
      "stops following up once OpenClaw turns the stopped dispatch away (%s)",
      async (_label, stop) => {
        // OpenClaw rejects a dispatch during validation (`respond(false)`, e.g.
        // an unknown agent id) before any run exists, so `agent.wait` never
        // reports it over. The rejection is the run's terminal answer.
        const r = router();
        const { ws, handling, gwRun, run } = await send(r, 0);
        await stop(r, ws);
        await handling;
        await vi.waitFor(() => expect(gw.aborts).toHaveLength(2));

        gw.reject(gwRun.runId, "invalid agent params: unknown agent id agent-1");
        const ended = await Promise.race([
          run.abortFollowUp!.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4_000)),
        ]);

        expect(ended).toBe(true);
      }
    );

    describe("when the abort did not stop the reply and it finished", () => {
      // The stopped run's stream ended with the client's own `done` the moment
      // the abort went out, so the stream knows nothing about how the reply
      // ended. The follow-up asks OpenClaw (`agent.wait`): a reply that
      // finished anyway completed for nobody, and the trail says so next to
      // the `chat.run_aborted` failure row.
      const failures: Array<
        [string, (gwRun: FakeRun) => { before: () => void; after: () => void }]
      > = [
        [
          "the abort RPC threw",
          (gwRun) => ({ before: () => gw.failNextAbort(), after: () => gw.finish(gwRun.runId) }),
        ],
        [
          "OpenClaw answered aborted: false",
          // It had just finished; its last frames were still on the way.
          (gwRun) => ({ before: () => gw.finish(gwRun.runId, { silent: true }), after: () => {} }),
        ],
      ];

      async function startedRun() {
        const r = router();
        const sent = await send(r, 0);
        gw.accept(sent.gwRun.runId);
        gw.emitText(sent.gwRun.runId, "Booking the invoices…");
        await vi.waitFor(() =>
          expect(activeRuns.get(sessionKey)?.firstChunkAt).toEqual(expect.any(Number))
        );
        const closeTab = () => {
          (sent.ws as unknown as { readyState: number }).readyState = 3; // CLOSED
          activeRuns.removeListenerFromAll(sent.ws);
        };
        return { r, ...sent, closeTab };
      }

      it.each(failures)(
        "is recorded as completed after deactivation when %s and the reply finished",
        async (_label, failure) => {
          const { handling, gwRun, run, closeTab } = await startedRun();
          const { before, after } = failure(gwRun);

          before();
          closeTab();
          const aborted = await stoppers[1][1](router(), createMockWs());
          expect((aborted as Array<{ outcome: string }>).map((a) => a.outcome)).toEqual([
            "failure",
          ]);
          after();
          await handling;
          await run.abortFollowUp;

          const rows = auditRows("chat.run_completed_after_disconnect");
          expect(rows).toHaveLength(1);
          expect(rows[0].detail.runId).toBe(gwRun.runId);
        }
      );

      it.each(failures)(
        "is recorded as completed after a stop click when %s and the reply finished",
        async (_label, failure) => {
          const { r, ws, handling, gwRun, run, closeTab } = await startedRun();
          const { before, after } = failure(gwRun);

          before();
          await r.handleMessage(ws, { type: "abort", agentId: "agent-1" } as never);
          closeTab();
          after();
          await handling;
          await run.abortFollowUp;

          expect(auditRows("chat.run_completed_after_disconnect")).toHaveLength(1);
        }
      );
    });
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
