import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const {
  mockChat,
  mockSessionsHistory,
  mockSessionsList,
  mockFindFirst,
  mockUserFindFirst,
  mockAppendAuditLog,
  mockGetUserGroupIds,
  mockGetAgentGroupIds,
  mockShouldEmitModelUnavailableAudit,
} = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockSessionsHistory: vi.fn(),
  mockSessionsList: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  mockGetUserGroupIds: vi.fn().mockResolvedValue([]),
  mockGetAgentGroupIds: vi.fn().mockResolvedValue([]),
  mockShouldEmitModelUnavailableAudit: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/agent-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-access")>();
  return {
    ...actual,
    assertAgentAccess: vi.fn(
      (
        agent: { isPersonal?: boolean; ownerId?: string; visibility?: string },
        userId: string,
        userRole: string,
        userGroupIds: string[] = [],
        agentGroupIds: string[] = [],
        enterprise: boolean = true
      ) => {
        if (userRole === "admin") return;
        if (agent.isPersonal) {
          if (agent.ownerId === userId) return;
          throw new Error("Access denied");
        }
        const vis = actual.effectiveVisibility(agent.visibility, enterprise);
        if (vis === "restricted") {
          if (userGroupIds.some((gId: string) => agentGroupIds.includes(gId))) return;
          throw new Error("Access denied");
        }
      }
    ),
  };
});

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findFirst: mockFindFirst,
      },
      users: {
        findFirst: mockUserFindFirst,
      },
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

vi.mock("@/lib/audit", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: (...args: unknown[]) => mockGetUserGroupIds(...args),
  getAgentGroupIds: (...args: unknown[]) => mockGetAgentGroupIds(...args),
}));

vi.mock("@/server/model-unavailable-throttle", () => ({
  shouldEmitModelUnavailableAudit: (...args: unknown[]) =>
    mockShouldEmitModelUnavailableAudit(...args),
}));

vi.mock("@/lib/upload-validation", () => ({
  validateUploadBuffer: vi.fn(async (_buf: Buffer, claimedMime: string) => claimedMime),
  sanitizeFilename: vi.fn((name: string) => name),
}));

vi.mock("@/lib/uploads", () => ({
  persistAttachment: vi.fn(async ({ filename }: { filename: string }) => ({
    relativePath: `uploads/${filename}`,
    reused: false,
    contentHash: "fakehash",
  })),
}));

import { ClientRouter } from "@/server/client-router";
import { SessionCache } from "@/server/session-cache";

function createMockClientWs() {
  const sent: string[] = [];
  return {
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
    sent,
    readyState: 1,
  };
}

const defaultAgent = {
  id: "agent-1",
  name: "Smithers",
  ownerId: null,
  isPersonal: false,
  greetingMessage: "Hello.",
};

// Helper for tests that need to disconnect mid-stream. Yields each chunk
// from `chunks` after one macrotask tick (setImmediate) — that gap is the
// test's window to mutate clientWs.readyState before the next yield.
// Using setImmediate rather than Promise.resolve() ensures the test's own
// setImmediate fires in between stream chunks (microtasks wouldn't suffice
// because the for-await loop drains all microtasks before yielding to the
// event loop).
async function* steppedStream<T>(chunks: T[]): AsyncGenerator<T> {
  for (const chunk of chunks) {
    await new Promise<void>((r) => setImmediate(r));
    yield chunk;
  }
}

function createMockOpenClawClient(connected = true) {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    chat: mockChat,
    sessions: { history: mockSessionsHistory, list: mockSessionsList },
    isConnected: connected,
  });
  return client;
}

describe("ClientRouter", () => {
  let router: ClientRouter;
  let mockOpenClawClient: ReturnType<typeof createMockOpenClawClient>;
  let sessionCache: SessionCache;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionCache = new SessionCache();
    // Default: session exists and cache is fresh (equivalent to runtimeActivated: true)
    sessionCache.refresh([{ key: "agent:agent-1:direct:user-1" }]);
    mockOpenClawClient = createMockOpenClawClient(true);
    router = new ClientRouter(mockOpenClawClient as any, "user-1", "member", sessionCache);

    // Default: agent exists and is accessible
    mockFindFirst.mockResolvedValue(defaultAgent);
    // Default: user has no context
    mockUserFindFirst.mockResolvedValue({ id: "user-1", context: null });
    // Default: empty history for history-mode requests
    mockSessionsHistory.mockResolvedValue({ messages: [] });
  });

  it("should return error when agent not found", async () => {
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue(null);

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "nonexistent-agent",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("error");
    expect(messages[0].message).toBe("Agent not found");
  });

  it("should return access denied for unauthorized user", async () => {
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue({
      id: "agent-1",
      name: "Personal Agent",
      ownerId: "other-user",
      isPersonal: true,
    });

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("error");
    expect(messages[0].message).toBe("Access denied");
  });

  it("should allow access to restricted agent when user is in matching group", async () => {
    const restrictedAgent = {
      id: "agent-restricted",
      name: "Restricted Agent",
      ownerId: null,
      isPersonal: false,
      visibility: "restricted",
      greetingMessage: null,
    };
    mockFindFirst.mockResolvedValue(restrictedAgent);
    mockGetUserGroupIds.mockResolvedValue(["g1", "g2"]);
    mockGetAgentGroupIds.mockResolvedValue(["g2", "g3"]);

    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const clientWs = createMockClientWs();
    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-restricted",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    expect(messages.some((m) => m.type === "chunk")).toBe(true);
    expect(messages.some((m) => m.type === "error")).toBe(false);
  });

  it("should pass agentId and sessionKey to OpenClaw chat", async () => {
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: "Hi Smithers",
      agentId: "agent-1",
    });

    expect(mockChat).toHaveBeenCalledWith("Hi Smithers", {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:direct:user-1",
    });
  });

  it("should fetch history via openclawClient.sessions.history", async () => {
    const clientWs = createMockClientWs();
    mockSessionsHistory.mockResolvedValue({
      messages: [
        { role: "user", content: "Hello", timestamp: 1708460000000 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi there!" }],
          timestamp: 1708460001000,
        },
      ],
    });

    await router.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    // Session is in cache, so sessions.list should NOT be called
    expect(mockSessionsList).not.toHaveBeenCalled();
    expect(mockSessionsHistory).toHaveBeenCalledWith("agent:agent-1:direct:user-1");
    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([
      { role: "user", content: "Hello", timestamp: 1708460000000 },
      { role: "assistant", content: "Hi there!", timestamp: 1708460001000 },
    ]);
  });

  it("should send streamed chunks to browser client", async () => {
    const clientWs = createMockClientWs();
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello " };
      yield { type: "text" as const, text: "there!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const textChunks = messages.filter((m: any) => m.type === "chunk");
    expect(textChunks).toHaveLength(2);
    expect(textChunks[0].content).toBe("Hello ");
    expect(textChunks[1].content).toBe("there!");
  });

  it("should strip <final> tags from streamed chunks", async () => {
    const clientWs = createMockClientWs();
    async function* fakeStream() {
      yield { type: "text" as const, text: "<final>" };
      yield { type: "text" as const, text: "Hello there!" };
      yield { type: "text" as const, text: "</final>" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      agentId: "agent-1",
      content: "hi",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const textChunks = messages.filter((m: any) => m.type === "chunk");
    const allText = textChunks.map((c: any) => c.content).join("");
    expect(allText).not.toContain("<final>");
    expect(allText).not.toContain("</final>");
    expect(allText).toContain("Hello there!");
  });

  it("should strip <final> tags when they appear mid-chunk", async () => {
    const clientWs = createMockClientWs();
    async function* fakeStream() {
      yield { type: "text" as const, text: "<final>Right away!" };
      yield { type: "text" as const, text: " How can I help?</final>" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      agentId: "agent-1",
      content: "hi",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const textChunks = messages.filter((m: any) => m.type === "chunk");
    const allText = textChunks.map((c: any) => c.content).join("");
    expect(allText).toBe("Right away! How can I help?");
  });

  it("should include consistent messageId within a single turn", async () => {
    const clientWs = createMockClientWs();
    async function* fakeStream() {
      yield { type: "text" as const, text: "a" };
      yield { type: "text" as const, text: "b" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    // Stream terminators (complete) have no messageId — only turn-bound
    // frames (thinking, chunk, done) carry one. They must all share the
    // same messageId so the browser can merge chunks into one assistant
    // message.
    const turnFrames = messages.filter((m: any) => ["thinking", "chunk", "done"].includes(m.type));
    const messageIds = turnFrames.map((m: any) => m.messageId);
    expect(new Set(messageIds).size).toBe(1);
    expect(messageIds[0]).toBeTruthy();
  });

  it("should assign different messageIds to each agent turn in a multi-turn stream", async () => {
    const clientWs = createMockClientWs();
    async function* fakeStream() {
      // Turn 1: agent searches documents
      yield { type: "text" as const, text: "Let me search..." };
      yield { type: "done" as const, text: "" };
      // Turn 2: agent gives final answer
      yield { type: "text" as const, text: "The house is 231m²." };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "How big is the house?",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const turn1Chunks = messages.filter(
      (m: any) => m.type === "chunk" && m.content.includes("search")
    );
    const turn2Chunks = messages.filter(
      (m: any) => m.type === "chunk" && m.content.includes("231")
    );
    const doneMessages = messages.filter((m: any) => m.type === "done");

    // Each turn should have its own messageId
    expect(turn1Chunks[0].messageId).not.toBe(turn2Chunks[0].messageId);

    // Chunks within a turn share the same messageId
    expect(turn1Chunks[0].messageId).toBe(doneMessages[0].messageId);
    expect(turn2Chunks[0].messageId).toBe(doneMessages[1].messageId);

    // Both messageIds should be truthy
    expect(turn1Chunks[0].messageId).toBeTruthy();
    expect(turn2Chunks[0].messageId).toBeTruthy();
  });

  it("should keep the browser WebSocket alive during long stream pauses by sending periodic thinking heartbeats", async () => {
    vi.useFakeTimers();
    try {
      const clientWs = createMockClientWs();
      let resolveFirstChunk: () => void = () => {};
      let resolveSecondChunk: () => void = () => {};
      const firstChunkArrived = new Promise<void>((r) => (resolveFirstChunk = r));
      const secondChunkArrived = new Promise<void>((r) => (resolveSecondChunk = r));

      async function* fakeStream() {
        // First quick text chunk so the stream is past the initial thinking
        yield { type: "text" as const, text: "Let me look that up." };
        yield { type: "done" as const, text: "" };
        resolveFirstChunk();
        // Long pause: simulates local LLM doing inference for a follow-up turn
        // — during this time the server must keep the browser socket alive.
        await new Promise<void>((r) => setTimeout(r, 60_000));
        yield { type: "text" as const, text: "Here is the answer." };
        yield { type: "done" as const, text: "" };
        resolveSecondChunk();
      }
      mockChat.mockReturnValue(fakeStream());

      const handlePromise = router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      // Let the generator produce its first chunks
      await vi.advanceTimersByTimeAsync(0);
      await firstChunkArrived;

      const sentBeforePause = clientWs.sent.length;

      // Advance well past one heartbeat interval (15s) but before the
      // generator's 60s sleep ends. The server must have sent at least one
      // additional thinking frame in this window.
      await vi.advanceTimersByTimeAsync(20_000);

      const sentDuringPause = clientWs.sent.slice(sentBeforePause).map((s) => JSON.parse(s));
      const heartbeats = sentDuringPause.filter((m: any) => m.type === "thinking");
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);

      // Drain the rest
      await vi.advanceTimersByTimeAsync(60_000);
      await secondChunkArrived;
      await handlePromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("should clear the heartbeat interval after the stream ends so no timer leaks", async () => {
    vi.useFakeTimers();
    try {
      const clientWs = createMockClientWs();
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hi" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      const beforeTimers = vi.getTimerCount();
      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });
      // The heartbeat interval must be cleaned up — otherwise long-lived
      // sessions would accumulate timers for every message sent.
      expect(vi.getTimerCount()).toBe(beforeTimers);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should clear the heartbeat interval when the client disconnects mid-stream", async () => {
    vi.useFakeTimers();
    try {
      const clientWs = createMockClientWs();
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hi" };
        // Simulate client close mid-stream
        clientWs.readyState = 3; // CLOSED
        yield { type: "text" as const, text: "more" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      const beforeTimers = vi.getTimerCount();
      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });
      expect(vi.getTimerCount()).toBe(beforeTimers);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should clear the heartbeat interval when the stream throws", async () => {
    vi.useFakeTimers();
    try {
      const clientWs = createMockClientWs();
      mockChat.mockImplementation(async function* () {
        yield { type: "text" as const, text: "part" };
        throw new Error("upstream kaboom");
      });

      const beforeTimers = vi.getTimerCount();
      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });
      expect(vi.getTimerCount()).toBe(beforeTimers);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should not send heartbeats before the first chunk arrives so the client stuck-timer fires when OpenClaw hangs", async () => {
    vi.useFakeTimers();
    try {
      const clientWs = createMockClientWs();
      let resolveStream: () => void = () => {};

      async function* hangingStream() {
        // Never yields a chunk — simulates OpenClaw being unresponsive after a restart
        await new Promise<void>((r) => (resolveStream = r));
      }
      mockChat.mockReturnValue(hangingStream());

      const handlePromise = router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      // Let synchronous code (including initial thinking) run
      await vi.advanceTimersByTimeAsync(0);

      const afterInitial = clientWs.sent.map((s) => JSON.parse(s));
      expect(afterInitial.filter((m: any) => m.type === "thinking")).toHaveLength(1);

      // Advance well past one heartbeat interval — no additional thinking should
      // fire because no chunk has arrived from OpenClaw yet. Without this fix the
      // heartbeat would reset the client stuck-timer indefinitely.
      await vi.advanceTimersByTimeAsync(20_000);

      const afterInterval = clientWs.sent.map((s) => JSON.parse(s));
      expect(afterInterval.filter((m: any) => m.type === "thinking")).toHaveLength(1);

      // Clean up
      resolveStream();
      await handlePromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("should send a thinking message before consuming the stream so the UI can show a spinner", async () => {
    const clientWs = createMockClientWs();
    let firstSent: unknown = null;
    let textChunkSeen = false;
    async function* fakeStream() {
      // Capture what was sent before the first text chunk arrived
      firstSent = clientWs.sent.length > 0 ? JSON.parse(clientWs.sent[0]) : null;
      textChunkSeen = true;
      yield { type: "text" as const, text: "Hello" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    expect(textChunkSeen).toBe(true);
    expect(firstSent).toMatchObject({ type: "thinking" });
    // Thinking message must share the messageId with the chunks that follow
    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const thinkingMsg = messages.find((m: any) => m.type === "thinking");
    const chunkMsg = messages.find((m: any) => m.type === "chunk");
    expect(thinkingMsg.messageId).toBeTruthy();
    expect(chunkMsg.messageId).toBe(thinkingMsg.messageId);
  });

  it("should send a done message after stream completes", async () => {
    const clientWs = createMockClientWs();
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const doneMsg = messages.find((m: any) => m.type === "done");
    expect(doneMsg).toBeDefined();
    expect(doneMsg.messageId).toBeTruthy();
  });

  it("should send a single 'complete' message after the entire stream ends", async () => {
    const clientWs = createMockClientWs();
    async function* fakeStream() {
      // Multi-turn: two intra-stream done events, but the stream as a whole
      // only really ends when the iterator is exhausted.
      yield { type: "text" as const, text: "Let me search..." };
      yield { type: "done" as const, text: "" };
      yield { type: "text" as const, text: "Found it." };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const completeMessages = messages.filter((m: any) => m.type === "complete");
    expect(completeMessages).toHaveLength(1);
    // The complete event must be the very last thing sent so the client can
    // safely turn off the spinner only when no more chunks are coming.
    expect(messages[messages.length - 1].type).toBe("complete");
  });

  it("should not send a 'complete' message when the stream errors", async () => {
    const clientWs = createMockClientWs();
    mockChat.mockImplementation(async function* () {
      throw new Error("upstream failure");
    });

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const completeMessages = messages.filter((m: any) => m.type === "complete");
    expect(completeMessages).toHaveLength(0);
  });

  it("should send error to browser on stream failure", async () => {
    const clientWs = createMockClientWs();
    mockChat.mockImplementation(async function* () {
      throw new Error("OpenClaw unavailable");
    });

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const errorMessages = messages.filter((m: any) => m.type === "error");
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0].message).toBe("Something went wrong. Please try again.");
  });

  it("should not send to client if WebSocket is not open", async () => {
    const clientWs = createMockClientWs();
    clientWs.readyState = 3; // CLOSED

    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    expect(clientWs.send).not.toHaveBeenCalled();
  });

  it("should drain the full stream even when the client WebSocket closes mid-stream, but only forward frames while WS is open", async () => {
    const clientWs = createMockClientWs();
    let chunksYielded = 0;

    async function* fakeStream() {
      chunksYielded++;
      yield { type: "text" as const, text: "First " };
      // Simulate WS closing after first chunk is consumed
      clientWs.readyState = 3; // CLOSED
      chunksYielded++;
      yield { type: "text" as const, text: "Second " };
      chunksYielded++;
      yield { type: "text" as const, text: "Third" };
      chunksYielded++;
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    // Stream must be drained to its natural end regardless of WS state
    // (issue #199 Layer B — server-side accounting must keep up with OpenClaw).
    expect(chunksYielded).toBe(4);
    // Only frames sent while the WS was open should have reached the client
    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const textChunks = messages.filter((m: any) => m.type === "chunk");
    expect(textChunks).toHaveLength(1);
    expect(textChunks[0].content).toBe("First ");
  });

  it("should return empty history when session has no messages", async () => {
    vi.useFakeTimers();
    try {
      const clientWs = createMockClientWs();
      mockSessionsHistory.mockResolvedValue({ messages: [] });

      const messagePromise = router.handleMessage(clientWs as any, {
        type: "history",
        agentId: "agent-1",
      });
      await vi.advanceTimersByTimeAsync(2100);
      await messagePromise;

      const sent = clientWs.sent.map((s) => JSON.parse(s));
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe("history");
      expect(sent[0].messages).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should still handle regular message type after adding history support", async () => {
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const clientWs = createMockClientWs();
    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    expect(mockChat).toHaveBeenCalledWith("Hi", {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:direct:user-1",
    });
    expect(mockSessionsHistory).not.toHaveBeenCalled();
    const messages = clientWs.sent.map((s) => JSON.parse(s));
    expect(messages.some((m: any) => m.type === "chunk")).toBe(true);
  });

  it("should send images as attachments to openclaw", async () => {
    async function* fakeStream() {
      yield { type: "text" as const, text: "I see the image" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const structuredContent = [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
    ];

    await router.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: structuredContent,
      agentId: "agent-1",
    });

    // The user text now carries an appended <pinchy:attachments> block so the
    // file metadata is preserved per-message in OpenClaw's session JSONL (see
    // attachment-pipeline.ts buildAttachmentBlock for the rationale). The
    // inline `attachments` option is still set for vision models that read
    // images directly.
    const [text, options] = mockChat.mock.calls[0];
    expect(text).toMatch(/^What is this\?\n\n<pinchy:attachments>/);
    expect(text).toContain("</pinchy:attachments>");
    expect(options).toMatchObject({
      agentId: "agent-1",
      sessionKey: "agent:agent-1:direct:user-1",
      attachments: [{ mimeType: "image/png", fileName: "upload", content: "abc123" }],
    });
  });

  it("should join multiple text parts from structured content with spaces", async () => {
    async function* fakeStream() {
      yield { type: "text" as const, text: "OK" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const structuredContent = [
      { type: "text", text: "First part." },
      { type: "text", text: "Second part." },
    ];

    await router.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: structuredContent,
      agentId: "agent-1",
    });

    expect(mockChat).toHaveBeenCalledWith("First part. Second part.", {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:direct:user-1",
    });
  });

  it("should append a <pinchy:attachments> block to the user text so file metadata is recorded per-message in session history", async () => {
    // Without per-message file metadata, OpenClaw's JSONL only stores the user
    // text — so on Turn 2, when reading history, the agent has no record of
    // which file Turn 1 was about. Embedding the block in the user text fixes
    // both the agent's history view AND chip rendering on reload, without a
    // separate persistence layer.
    async function* fakeStream() {
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const PDF_DATA = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n").toString("base64")}`;
    await router.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: [
        { type: "text", text: "Was steht hier?" },
        { type: "image_url", image_url: { url: PDF_DATA } },
      ],
      filenames: ["invoice.pdf"],
      agentId: "agent-1",
    });

    const [text, options] = mockChat.mock.calls[0];
    expect(text).toContain("Was steht hier?");
    expect(text).toContain("<pinchy:attachments>");
    expect(text).toContain("</pinchy:attachments>");
    expect(text).toContain("uploads/invoice.pdf");
    expect(text).toContain("application/pdf");
    expect(text).toMatch(/\bpdf\b/);
    // The legacy `extraSystemPrompt`-side upload hint is gone — file
    // attribution lives in the message itself now. If extraSystemPrompt is
    // present (e.g. for greeting/user context) it must NOT carry the path.
    if (typeof options.extraSystemPrompt === "string") {
      expect(options.extraSystemPrompt).not.toContain("uploads/invoice.pdf");
    }
  });

  it("should strip <pinchy:attachments> block from history user messages and surface it as a files field", async () => {
    // On reload, the chat must show the file chip on the user's bubble even
    // though OpenClaw's JSONL only knows the message text. We round-trip the
    // metadata via the in-message block: the server parses it out before
    // sending history to the browser so the user never sees the markup, and
    // populates `files` so the UI can render the chip.
    const clientWs = createMockClientWs();
    mockSessionsHistory.mockResolvedValue({
      messages: [
        {
          role: "user",
          content:
            "Was steht in dieser Datei?\n\n<pinchy:attachments>\n" +
            "The user attached these files (already saved into your workspace). Read each file with the listed built-in tool, using the exact absolute path:\n" +
            "- `/root/.openclaw/workspaces/agent-1/uploads/invoice.pdf` (application/pdf, 240 KB) — analyze with `pdf`\n" +
            "\nIf you delegate this task to a sub-agent or another tool, pass these exact paths verbatim — do not retype from memory.\n" +
            "</pinchy:attachments>",
          timestamp: 1708460000000,
        },
      ],
    });

    await router.handleMessage(clientWs as any, { type: "history", agentId: "agent-1" });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent[0].messages).toHaveLength(1);
    const userMsg = sent[0].messages[0];
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("Was steht in dieser Datei?");
    expect(userMsg.files).toEqual([{ filename: "invoice.pdf", mimeType: "application/pdf" }]);
  });

  it("should omit attachments when content has no images", async () => {
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    expect(mockChat).toHaveBeenCalledWith("Hi", {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:direct:user-1",
    });
  });

  it("should extract text from content block arrays in history", async () => {
    const clientWs = createMockClientWs();
    mockSessionsHistory.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think..." },
            { type: "text", text: "Here is the answer." },
            { type: "text", text: "And more." },
          ],
        },
      ],
    });

    await router.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent[0].messages).toEqual([
      { role: "assistant", content: "Here is the answer. And more.", timestamp: undefined },
    ]);
  });

  it("should strip <final> tags from history messages", async () => {
    const clientWs = createMockClientWs();
    mockSessionsHistory.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: "<final>Right away! How can I help?</final>",
        },
      ],
    });

    await router.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent[0].messages[0].content).toBe("Right away! How can I help?");
  });

  it("should strip timestamp prefix from user messages in history", async () => {
    const clientWs = createMockClientWs();
    mockSessionsHistory.mockResolvedValue({
      messages: [
        {
          role: "user",
          content: "[Fri 2026-02-20 21:30 UTC] Hello!",
          timestamp: 1708460000000,
        },
      ],
    });

    await router.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent[0].messages[0].content).toBe("Hello!");
  });

  it("should skip non-user/assistant roles in history", async () => {
    const clientWs = createMockClientWs();
    mockSessionsHistory.mockResolvedValue({
      messages: [
        { role: "user", content: "Hi" },
        { role: "toolResult", content: "some data" },
        { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
      ],
    });

    await router.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent[0].messages).toHaveLength(2);
    expect(sent[0].messages[0].role).toBe("user");
    expect(sent[0].messages[1].role).toBe("assistant");
  });

  it("should fetch history from OpenClaw even when session not in cache", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);
    const clientWs = createMockClientWs();

    // Cache is stale and sessions.list returns no matching session
    mockSessionsList.mockResolvedValue({ sessions: [] });
    // But OpenClaw actually has history for this session
    mockSessionsHistory.mockResolvedValue({
      messages: [
        { role: "user", content: "Hello", timestamp: "2025-01-01T00:00:00Z" },
        { role: "assistant", content: "Hi there!", timestamp: "2025-01-01T00:00:01Z" },
      ],
    });

    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    expect(mockSessionsHistory).toHaveBeenCalledWith("agent:agent-1:direct:user-1");
    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toHaveLength(2);
    expect(sent[0].messages[0].content).toBe("Hello");
    expect(sent[0].messages[1].content).toBe("Hi there!");
  });

  it("should return greeting when OpenClaw has no history for session", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: "Hello! I'm Smithers, your AI assistant. How can I help?",
    });

    // OpenClaw returns empty history
    mockSessionsHistory.mockResolvedValue({ messages: [] });

    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    expect(mockSessionsHistory).toHaveBeenCalledWith("agent:agent-1:direct:user-1");
    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([
      {
        role: "assistant",
        content: "Hello! I'm Smithers, your AI assistant. How can I help?",
      },
    ]);
  });

  it("should include extraSystemPrompt with greeting context on first message", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: "Hello! I'm Smithers.",
    });
    async function* fakeStream() {
      yield { type: "text" as const, text: "Sure!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await freshRouter.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: "What can you do?",
      agentId: "agent-1",
    });

    expect(mockChat).toHaveBeenCalledWith("What can you do?", {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:direct:user-1",
      extraSystemPrompt: expect.stringContaining("Hello! I'm Smithers."),
    });
  });

  it("should NOT include extraSystemPrompt on subsequent messages", async () => {
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    expect(mockChat).toHaveBeenCalledWith("Hi", {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:direct:user-1",
    });
  });

  it("should NOT include extraSystemPrompt when agent has no greeting", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: null,
    });
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await freshRouter.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    expect(mockChat).toHaveBeenCalledWith("Hi", {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:direct:user-1",
    });
  });

  it("should add session key to cache after successful chat", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    // Before chat: key is not in cache
    expect(freshCache.has("agent:agent-1:direct:user-1")).toBe(false);

    await freshRouter.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    // After chat completes: key should be in cache
    expect(freshCache.has("agent:agent-1:direct:user-1")).toBe(true);
  });

  it("should fall back to empty history when history fetch fails and no greeting", async () => {
    vi.useFakeTimers();
    try {
      const clientWs = createMockClientWs();
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        greetingMessage: null,
      });
      mockSessionsHistory.mockRejectedValue(new Error("Gateway unavailable"));

      const messagePromise = router.handleMessage(clientWs as any, {
        type: "history",
        agentId: "agent-1",
      });
      await vi.advanceTimersByTimeAsync(2100);
      await messagePromise;

      const sent = clientWs.sent.map((s) => JSON.parse(s));
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe("history");
      expect(sent[0].messages).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should sanitize internal error messages before sending to client", async () => {
    const clientWs = createMockClientWs();
    mockChat.mockImplementation(async function* () {
      throw new Error("ECONNREFUSED 127.0.0.1:18789 - WebSocket connection failed");
    });

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const errorMsg = messages.find((m: any) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.message).not.toContain("ECONNREFUSED");
    expect(errorMsg.message).not.toContain("127.0.0.1");
    expect(errorMsg.message).toBe("Something went wrong. Please try again.");
  });

  it("should fall back to greeting when history fetch throws for unknown session", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: "Hello!",
    });
    mockSessionsHistory.mockRejectedValue(new Error("Internal: /root/.openclaw/config error"));

    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([{ role: "assistant", content: "Hello!" }]);
  });

  it("should retry history fetch when session is known to cache but first attempt fails", async () => {
    vi.useFakeTimers();
    try {
      // Session was previously active (known to cache)
      sessionCache.add("agent:agent-1:direct:user-1");

      const clientWs = createMockClientWs();
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        greetingMessage: "Hello!",
      });

      // First call fails (OpenClaw still restarting), second succeeds
      mockSessionsHistory
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValueOnce({
          messages: [
            { role: "user", content: "Hi there" },
            { role: "assistant", content: "Hello! How can I help?" },
          ],
        });

      const messagePromise = router.handleMessage(clientWs as any, {
        type: "history",
        agentId: "agent-1",
      });
      await vi.advanceTimersByTimeAsync(2100);
      await messagePromise;

      expect(mockSessionsHistory).toHaveBeenCalledTimes(2);
      const sent = clientWs.sent.map((s) => JSON.parse(s));
      expect(sent[0].type).toBe("history");
      expect(sent[0].messages).toHaveLength(2);
      expect(sent[0].messages[0].content).toBe("Hi there");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should retry when session is known to cache but history returns empty", async () => {
    vi.useFakeTimers();
    try {
      sessionCache.add("agent:agent-1:direct:user-1");

      const clientWs = createMockClientWs();
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        greetingMessage: "Hello!",
      });

      // First call returns empty (OpenClaw hasn't indexed yet), second returns history
      mockSessionsHistory.mockResolvedValueOnce({ messages: [] }).mockResolvedValueOnce({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hey!" },
        ],
      });

      const messagePromise = router.handleMessage(clientWs as any, {
        type: "history",
        agentId: "agent-1",
      });
      await vi.advanceTimersByTimeAsync(2100);
      await messagePromise;

      expect(mockSessionsHistory).toHaveBeenCalledTimes(2);
      const sent = clientWs.sent.map((s) => JSON.parse(s));
      expect(sent[0].type).toBe("history");
      expect(sent[0].messages).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should send empty history (not greeting) when session known but retry also fails", async () => {
    vi.useFakeTimers();
    try {
      sessionCache.add("agent:agent-1:direct:user-1");

      const clientWs = createMockClientWs();
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        greetingMessage: "Hello!",
      });

      // Both attempts fail
      mockSessionsHistory
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"));

      const messagePromise = router.handleMessage(clientWs as any, {
        type: "history",
        agentId: "agent-1",
      });
      await vi.advanceTimersByTimeAsync(2100);
      await messagePromise;

      expect(mockSessionsHistory).toHaveBeenCalledTimes(2);
      const sent = clientWs.sent.map((s) => JSON.parse(s));
      expect(sent[0].type).toBe("history");
      // Session is known — signal client to retry rather than overwriting real history.
      expect(sent[0].messages).toEqual([]);
      expect(sent[0].sessionKnown).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should send empty history (not greeting) when session known but history remains empty after retry", async () => {
    // This is the core settings-save bug: after permissions change, OpenClaw restarts.
    // The browser WS reconnects but history is temporarily unavailable during the restart.
    // The server must NOT send a greeting — the client will preserve its existing messages.
    vi.useFakeTimers();
    try {
      sessionCache.add("agent:agent-1:direct:user-1");

      const clientWs = createMockClientWs();
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        greetingMessage: "Hello! I'm Smithers.",
      });

      // Both history fetches return empty (OpenClaw still restarting)
      mockSessionsHistory.mockResolvedValue({ messages: [] });

      const messagePromise = router.handleMessage(clientWs as any, {
        type: "history",
        agentId: "agent-1",
      });
      await vi.advanceTimersByTimeAsync(2100);
      await messagePromise;

      expect(mockSessionsHistory).toHaveBeenCalledTimes(2);
      const sent = clientWs.sent.map((s) => JSON.parse(s));
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe("history");
      // Must send empty array — NOT the greeting. Signal client to retry.
      expect(sent[0].messages).toEqual([]);
      expect(sent[0].sessionKnown).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should retry history via sessions.list fallback when cache is empty but session exists in OpenClaw", async () => {
    // Scenario: Pinchy was restarted (empty cache). seedSessionCache() raced with
    // this request and lost — the session exists in OpenClaw but the cache is empty.
    // sessions.list() is the live fallback check.
    vi.useFakeTimers();
    try {
      const freshCache = new SessionCache();
      const freshRouter = new ClientRouter(
        mockOpenClawClient as any,
        "user-1",
        "member",
        freshCache
      );
      const clientWs = createMockClientWs();
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        greetingMessage: "Hello!",
      });

      // First sessions.history() returns empty (OpenClaw still re-indexing after restart)
      // Second call (after retry delay) returns the actual history
      mockSessionsHistory.mockResolvedValueOnce({ messages: [] }).mockResolvedValueOnce({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hey there!" },
        ],
      });

      // sessions.list() confirms the session exists
      mockSessionsList.mockResolvedValue({
        sessions: [{ key: "agent:agent-1:direct:user-1" }],
      });

      const messagePromise = freshRouter.handleMessage(clientWs as any, {
        type: "history",
        agentId: "agent-1",
      });
      await vi.advanceTimersByTimeAsync(2100);
      await messagePromise;

      expect(mockSessionsList).toHaveBeenCalledOnce();
      expect(mockSessionsHistory).toHaveBeenCalledTimes(2);
      const sent = clientWs.sent.map((s) => JSON.parse(s));
      expect(sent[0].type).toBe("history");
      expect(sent[0].messages).toHaveLength(2);
      expect(sent[0].messages[0].content).toBe("Hi");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should send greeting immediately when cache is empty and session not in sessions.list", async () => {
    // No session in cache and sessions.list confirms it doesn't exist — new session,
    // show greeting without retry delay.
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: "Hello!",
    });

    // No history and session does not exist
    mockSessionsHistory.mockResolvedValue({ messages: [] });
    mockSessionsList.mockResolvedValue({ sessions: [] });

    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    expect(mockSessionsList).toHaveBeenCalledOnce();
    expect(mockSessionsHistory).toHaveBeenCalledTimes(1); // no retry
    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([{ role: "assistant", content: "Hello!" }]);
  });

  it("should wait for reconnect and succeed when OpenClaw reconnects in time", async () => {
    // Start disconnected — sessions.history throws like real client
    const disconnectedClient = createMockOpenClawClient(false);
    const disconnectedRouter = new ClientRouter(
      disconnectedClient as any,
      "user-1",
      "member",
      sessionCache
    );

    mockSessionsHistory.mockResolvedValue({ messages: [] });

    // Simulate reconnect after 50ms
    setTimeout(() => {
      disconnectedClient.isConnected = true;
      disconnectedClient.emit("connected");
    }, 50);

    const clientWs = createMockClientWs();
    await disconnectedRouter.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
  });

  it("should send empty history (not greeting) after timeout when session is known but OpenClaw unavailable", async () => {
    // Session is in cache (from beforeEach), so even if OpenClaw times out we must
    // not replace real history with a greeting on reconnect.
    vi.useFakeTimers();

    const disconnectedClient = createMockOpenClawClient(false);
    const disconnectedRouter = new ClientRouter(
      disconnectedClient as any,
      "user-1",
      "member",
      sessionCache
    );
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: "Hello!",
    });

    const clientWs = createMockClientWs();
    const messagePromise = disconnectedRouter.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    // Advance past the connection timeout (10s) + retry delay (2s)
    await vi.advanceTimersByTimeAsync(13_000);
    await messagePromise;

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    // Session known — signal client to retry rather than overwriting real history.
    expect(sent[0].messages).toEqual([]);
    expect(sent[0].sessionKnown).toBe(true);

    vi.useRealTimers();
  });

  describe("empty-history invariant (issue #197)", () => {
    // The browser uses `sessionKnown: true` to escape "starting" with an
    // empty thread. If the server ever ships an empty history without that
    // flag while OpenClaw is connected, the chat would sit in "starting"
    // forever. These tests pin the invariant: any empty-history emission
    // either carries `sessionKnown: true` OR happens with OpenClaw down.
    it("emits sessionKnown:true when empty history comes back via cache fallback", async () => {
      vi.useFakeTimers();
      try {
        const freshCache = new SessionCache();
        const freshRouter = new ClientRouter(
          mockOpenClawClient as any,
          "user-1",
          "member",
          freshCache
        );
        const clientWs = createMockClientWs();
        mockFindFirst.mockResolvedValue({
          ...defaultAgent,
          greetingMessage: "Hello!",
        });
        // Cache is empty; live sessions.list reveals the session does exist.
        mockSessionsList.mockResolvedValue({
          sessions: [{ key: "agent:agent-1:direct:user-1" }],
        });
        // Both fetches return empty — restart-race not yet resolved.
        mockSessionsHistory.mockResolvedValue({ messages: [] });

        const messagePromise = freshRouter.handleMessage(clientWs as any, {
          type: "history",
          agentId: "agent-1",
        });
        await vi.advanceTimersByTimeAsync(2100);
        await messagePromise;

        const sent = clientWs.sent.map((s) => JSON.parse(s));
        expect(sent).toHaveLength(1);
        expect(sent[0].messages).toEqual([]);
        expect(sent[0].sessionKnown).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never emits empty messages without sessionKnown when OpenClaw is connected", async () => {
      // Brute-force regression guard: every code path that fires while
      // OpenClaw is connected must either send messages or set sessionKnown.
      // Three failure shapes that previously could land us in "empty no
      // sessionKnown": throw on first fetch with cold cache, throw on retry
      // with warm cache, and steady-state empty with warm cache.
      vi.useFakeTimers();
      try {
        const cases: Array<() => void> = [
          // Cold cache + history throws → must fall back to greeting (not empty).
          () => {
            sessionCache = new SessionCache();
            mockSessionsHistory.mockRejectedValue(new Error("transient"));
            mockSessionsList.mockResolvedValue({ sessions: [] });
          },
          // Warm cache + history throws on both attempts.
          () => {
            mockSessionsHistory
              .mockRejectedValueOnce(new Error("fail 1"))
              .mockRejectedValueOnce(new Error("fail 2"));
          },
          // Warm cache + history returns empty on both attempts.
          () => {
            mockSessionsHistory.mockResolvedValue({ messages: [] });
          },
        ];

        for (const setup of cases) {
          mockFindFirst.mockResolvedValue({ ...defaultAgent, greetingMessage: "Hi!" });
          mockUserFindFirst.mockResolvedValue({ id: "user-1", context: null });
          mockSessionsHistory.mockReset();
          mockSessionsList.mockReset();
          setup();

          const localRouter = new ClientRouter(
            mockOpenClawClient as any,
            "user-1",
            "member",
            sessionCache
          );
          const clientWs = createMockClientWs();
          const promise = localRouter.handleMessage(clientWs as any, {
            type: "history",
            agentId: "agent-1",
          });
          await vi.advanceTimersByTimeAsync(3000);
          await promise;

          const sent = clientWs.sent.map((s) => JSON.parse(s));
          expect(sent).toHaveLength(1);
          const frame = sent[0];
          expect(frame.type).toBe("history");
          // Either the chat has content, or we explicitly told the client
          // it's a known-empty session — never the silent-empty shape.
          const hasContent = (frame.messages?.length ?? 0) > 0;
          const flaggedKnown = frame.sessionKnown === true;
          expect(hasContent || flaggedKnown).toBe(true);
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("should log audit event when agent access is denied", async () => {
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue({
      id: "agent-1",
      name: "Personal Agent",
      ownerId: "other-user",
      isPersonal: true,
    });

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "user-1",
      eventType: "tool.denied",
      resource: "agent:agent-1",
      detail: { reason: "access_denied" },
      outcome: "failure",
    });
  });

  it("should not write tool.execute audit events in client router", async () => {
    const clientWs = createMockClientWs();
    async function* fakeStream() {
      yield { type: "tool_use" as const, text: "search_web" };
      yield { type: "tool_result" as const, text: "search_web: Found 10 results" };
      yield { type: "text" as const, text: "Here are the results." };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Search for something",
      agentId: "agent-1",
    });

    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("should not derive tool usage from session history in client router", async () => {
    const clientWs = createMockClientWs();
    const now = Date.now();

    async function* fakeStream() {
      yield { type: "text" as const, text: "Answer text only" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());
    mockSessionsHistory.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          timestamp: now,
          content: [
            {
              type: "toolCall",
              id: "tool-call-1",
              name: "pinchy_read",
              arguments: { path: "/data/sample-docs/vacation-policy.md" },
            },
          ],
        },
        {
          role: "toolResult",
          timestamp: now,
          toolCallId: "tool-call-1",
          toolName: "pinchy_read",
          isError: false,
          content: [{ type: "text", text: "Vacation policy content" }],
        },
      ],
    });

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Question",
      agentId: "agent-1",
    });

    expect(mockAppendAuditLog).not.toHaveBeenCalled();
    expect(mockSessionsHistory).not.toHaveBeenCalled();
  });

  it("should allow admin to access personal agents of other users", async () => {
    const adminRouter = new ClientRouter(
      mockOpenClawClient as any,
      "admin-user",
      "admin",
      sessionCache
    );
    mockFindFirst.mockResolvedValue({
      id: "agent-1",
      name: "Personal Agent",
      ownerId: "other-user",
      isPersonal: true,
    });

    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const clientWs = createMockClientWs();
    await adminRouter.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    expect(messages.some((m: any) => m.type === "chunk")).toBe(true);
  });

  it("should fetch history directly without calling sessions.list", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);
    mockSessionsHistory.mockResolvedValue({
      messages: [{ role: "user", content: "Hi", timestamp: "2025-01-01T00:00:00Z" }],
    });

    const clientWs = createMockClientWs();
    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    expect(mockSessionsList).not.toHaveBeenCalled();
    expect(mockSessionsHistory).toHaveBeenCalledWith("agent:agent-1:direct:user-1");
  });

  it("should use session key format agent:<agentId>:direct:<userId> for per-user scoping", async () => {
    // This test ensures the session key includes both agentId and userId.
    // The agentId segment must match OpenClaw's validation (agentId param == agentId in key).
    // The user scope ensures each user gets their own session per agent.
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const sessionKey = mockChat.mock.calls[0][1].sessionKey;
    expect(sessionKey).toMatch(/^agent:.+:direct:.+$/);
    expect(sessionKey).toBe("agent:agent-1:direct:user-1");
  });

  it("should find session when sessions.list returns user-scoped keys", async () => {
    // Sessions in OpenClaw use the format agent:<id>:direct:<userId>.
    // The router must generate keys in the same format to find existing sessions.
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);

    // OpenClaw returns sessions with its native key format
    mockSessionsList.mockResolvedValue({
      sessions: [{ key: "agent:agent-1:direct:user-1" }],
    });
    mockSessionsHistory.mockResolvedValue({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
      ],
    });

    const clientWs = createMockClientWs();
    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      agentId: "agent-1",
    });

    // Must have called sessions.history (not fallen back to greeting/empty)
    expect(mockSessionsHistory).toHaveBeenCalled();
    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent[0].messages).toHaveLength(2);
  });

  it("should forward provider error text from error chunk with agent name", async () => {
    const clientWs = createMockClientWs();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function* fakeStream() {
      yield {
        type: "error" as const,
        text: "Your credit balance is too low to access the API",
      };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const errorMsg = messages.find((m: any) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.agentName).toBe("Smithers");
    expect(errorMsg.providerError).toContain("Your credit balance is too low");
    expect(errorMsg.hint).toBe("Please contact your administrator.");
    expect(errorMsg.messageId).toBeTruthy();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw error chunk"),
      expect.stringContaining("credit balance")
    );

    consoleSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("should return admin hint for provider errors when user is admin", async () => {
    const adminRouter = new ClientRouter(
      mockOpenClawClient as any,
      "admin-user",
      "admin",
      sessionCache
    );
    const clientWs = createMockClientWs();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    async function* fakeStream() {
      yield { type: "error" as const, text: "Invalid API key provided" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await adminRouter.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const errorMsg = messages.find((m: any) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.hint).toBe("Go to Settings > Providers to check your API configuration.");

    consoleSpy.mockRestore();
  });

  it("should return try-again hint for transient errors", async () => {
    const clientWs = createMockClientWs();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    async function* fakeStream() {
      yield { type: "error" as const, text: "Rate limit exceeded, please try again later" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const errorMsg = messages.find((m: any) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.hint).toBe("Try again in a moment.");

    consoleSpy.mockRestore();
  });

  it("should return null hint for unrecognized errors", async () => {
    const clientWs = createMockClientWs();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    async function* fakeStream() {
      yield { type: "error" as const, text: "Something completely unexpected happened" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const errorMsg = messages.find((m: any) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.agentName).toBe("Smithers");
    expect(errorMsg.providerError).toContain("Something completely unexpected happened");
    expect(errorMsg.hint).toBeNull();

    consoleSpy.mockRestore();
  });

  describe("per-user context injection for shared agents", () => {
    it("should include user context in extraSystemPrompt for shared agents", async () => {
      mockUserFindFirst.mockResolvedValue({
        id: "user-1",
        context: "I'm a designer who prefers visual examples.",
      });
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        isPersonal: false,
      });
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockChat).toHaveBeenCalledWith(
        "Hi",
        expect.objectContaining({
          extraSystemPrompt: expect.stringContaining("I'm a designer who prefers visual examples."),
        })
      );
    });

    it("should NOT include user context for personal agents", async () => {
      mockUserFindFirst.mockResolvedValue({
        id: "user-1",
        context: "I'm a designer who prefers visual examples.",
      });
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        isPersonal: true,
        ownerId: "user-1",
      });
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockChat).toHaveBeenCalledWith("Hi", {
        agentId: "agent-1",
        sessionKey: "agent:agent-1:direct:user-1",
      });
      // User IS fetched (for name injection), but context is not injected for personal agents
      expect(mockUserFindFirst).toHaveBeenCalled();
    });

    it("should NOT include user context when user has no context set", async () => {
      mockUserFindFirst.mockResolvedValue({ id: "user-1", context: null });
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockChat).toHaveBeenCalledWith("Hi", {
        agentId: "agent-1",
        sessionKey: "agent:agent-1:direct:user-1",
      });
    });

    it("should combine user context and greeting on first message to shared agent", async () => {
      const freshCache = new SessionCache();
      const freshRouter = new ClientRouter(
        mockOpenClawClient as any,
        "user-1",
        "member",
        freshCache
      );
      mockUserFindFirst.mockResolvedValue({
        id: "user-1",
        context: "I'm a backend engineer.",
      });
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        isPersonal: false,
        greetingMessage: "Hello! How can I help?",
      });
      async function* fakeStream() {
        yield { type: "text" as const, text: "Sure!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await freshRouter.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Help me debug",
        agentId: "agent-1",
      });

      const callArgs = mockChat.mock.calls[0][1];
      expect(callArgs.extraSystemPrompt).toContain("I'm a backend engineer.");
      expect(callArgs.extraSystemPrompt).toContain("Hello! How can I help?");
    });

    it("should include user context on every message, not just the first", async () => {
      mockUserFindFirst.mockResolvedValue({
        id: "user-1",
        context: "I'm a designer.",
      });
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        isPersonal: false,
      });

      // First message
      async function* fakeStream1() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream1());
      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      // Second message (session is now in cache)
      async function* fakeStream2() {
        yield { type: "text" as const, text: "Sure!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream2());
      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Follow up",
        agentId: "agent-1",
      });

      // Both calls should include user context
      expect(mockChat).toHaveBeenCalledTimes(2);
      expect(mockChat.mock.calls[0][1].extraSystemPrompt).toContain("I'm a designer.");
      expect(mockChat.mock.calls[1][1].extraSystemPrompt).toContain("I'm a designer.");
    });
  });

  describe("user name injection", () => {
    it("should inject user name in extraSystemPrompt for personal agents", async () => {
      mockUserFindFirst.mockResolvedValue({ id: "user-1", name: "Alice", context: null });
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        isPersonal: true,
        ownerId: "user-1",
      });
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockChat).toHaveBeenCalledWith(
        "Hi",
        expect.objectContaining({
          extraSystemPrompt: expect.stringContaining("Alice"),
        })
      );
    });

    it("should inject user name in extraSystemPrompt for shared agents", async () => {
      mockUserFindFirst.mockResolvedValue({ id: "user-1", name: "Bob", context: null });
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        isPersonal: false,
      });
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockChat).toHaveBeenCalledWith(
        "Hi",
        expect.objectContaining({
          extraSystemPrompt: expect.stringContaining("Bob"),
        })
      );
    });

    it("should NOT inject name when user has no name set", async () => {
      mockUserFindFirst.mockResolvedValue({ id: "user-1", name: null, context: null });
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockChat).toHaveBeenCalledWith("Hi", {
        agentId: "agent-1",
        sessionKey: "agent:agent-1:direct:user-1",
      });
    });
  });

  describe("{user} placeholder in greeting messages", () => {
    it("should resolve {user} in greeting with user's name when showing history", async () => {
      const freshCache = new SessionCache();
      const freshRouter = new ClientRouter(
        mockOpenClawClient as any,
        "user-1",
        "member",
        freshCache
      );
      mockUserFindFirst.mockResolvedValue({ id: "user-1", name: "Clemens", context: null });
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        greetingMessage: "Good day, {user}. I'm Smithers. How may I help?",
      });
      mockSessionsList.mockResolvedValue({ sessions: [] });

      const clientWs = createMockClientWs();
      await freshRouter.handleMessage(clientWs as any, {
        type: "history",
        agentId: "agent-1",
      });

      const sent = clientWs.sent.map((s) => JSON.parse(s));
      expect(sent[0].messages[0].content).toBe("Good day, Clemens. I'm Smithers. How may I help?");
    });

    it("should resolve {user} in extraSystemPrompt greeting context on first message", async () => {
      const freshCache = new SessionCache();
      const freshRouter = new ClientRouter(
        mockOpenClawClient as any,
        "user-1",
        "member",
        freshCache
      );
      mockUserFindFirst.mockResolvedValue({ id: "user-1", name: "Clemens", context: null });
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        greetingMessage: "Good day, {user}. I'm Smithers. How may I help?",
      });
      async function* fakeStream() {
        yield { type: "text" as const, text: "Of course!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await freshRouter.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      const callArgs = mockChat.mock.calls[0][1];
      expect(callArgs.extraSystemPrompt).toContain("Good day, Clemens.");
      expect(callArgs.extraSystemPrompt).not.toContain("{user}");
    });

    it("should gracefully remove {user} from greeting when user has no name", async () => {
      const freshCache = new SessionCache();
      const freshRouter = new ClientRouter(
        mockOpenClawClient as any,
        "user-1",
        "member",
        freshCache
      );
      mockUserFindFirst.mockResolvedValue({ id: "user-1", name: null, context: null });
      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        greetingMessage: "Good day, {user}. I'm Smithers. How may I help?",
      });
      mockSessionsList.mockResolvedValue({ sessions: [] });

      const clientWs = createMockClientWs();
      await freshRouter.handleMessage(clientWs as any, {
        type: "history",
        agentId: "agent-1",
      });

      const sent = clientWs.sent.map((s) => JSON.parse(s));
      const greeting = sent[0].messages[0].content;
      expect(greeting).not.toContain("{user}");
      expect(greeting).toContain("I'm Smithers");
    });
  });

  describe("userMessagePersisted ack", () => {
    it("sends { type: 'ack', clientMessageId } to browser when stream yields userMessagePersisted", async () => {
      const clientWs = createMockClientWs();
      async function* fakeStream() {
        yield { type: "userMessagePersisted" as const, clientMessageId: "k1" };
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
        clientMessageId: "k1",
      });

      const messages = clientWs.sent.map((s) => JSON.parse(s));
      const ackMsg = messages.find((m: any) => m.type === "ack");
      expect(ackMsg).toBeDefined();
      expect(ackMsg).toEqual({ type: "ack", clientMessageId: "k1" });
    });

    it("does NOT forward the raw userMessagePersisted chunk to the browser", async () => {
      const clientWs = createMockClientWs();
      async function* fakeStream() {
        yield { type: "userMessagePersisted" as const, clientMessageId: "k1" };
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
        clientMessageId: "k1",
      });

      const messages = clientWs.sent.map((s) => JSON.parse(s));
      expect(messages.some((m: any) => m.type === "userMessagePersisted")).toBe(false);
    });
  });

  describe("clientMessageId forwarding", () => {
    it("forwards clientMessageId from browser WS frame to openclaw.chat()", async () => {
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
        clientMessageId: "uuid-123",
      });

      expect(mockChat).toHaveBeenCalledWith(
        "Hi",
        expect.objectContaining({ clientMessageId: "uuid-123" })
      );
    });

    it("omits clientMessageId from openclaw.chat() when not provided by browser", async () => {
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      const callArgs = mockChat.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty("clientMessageId");
    });
  });

  describe("chat.retry_triggered audit log", () => {
    it("appends audit log on retry-resend with implicit fallback reason 'send_failure'", async () => {
      async function* fakeStream() {
        yield { type: "userMessagePersisted" as const, clientMessageId: "msg-id-1" };
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
        clientMessageId: "msg-id-1",
        isRetry: true,
      });

      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: "user",
          actorId: "user-1",
          eventType: "chat.retry_triggered",
          resource: "agent:agent-1",
          outcome: "success",
          detail: expect.objectContaining({
            agent: { id: "agent-1", name: "Smithers" },
            sessionKey: "agent:agent-1:direct:user-1",
            reason: "send_failure",
          }),
        })
      );
    });

    it("appends audit log with explicit reason 'orphan'", async () => {
      async function* fakeStream() {
        yield { type: "userMessagePersisted" as const, clientMessageId: "msg-id-1" };
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
        clientMessageId: "msg-id-1",
        isRetry: true,
        retryReason: "orphan",
      });

      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "chat.retry_triggered",
          detail: expect.objectContaining({ reason: "orphan" }),
        })
      );
    });

    it("appends audit log with explicit reason 'partial_stream_failure'", async () => {
      async function* fakeStream() {
        yield { type: "userMessagePersisted" as const, clientMessageId: "msg-id-1" };
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
        clientMessageId: "msg-id-1",
        isRetry: true,
        retryReason: "partial_stream_failure",
      });

      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "chat.retry_triggered",
          detail: expect.objectContaining({ reason: "partial_stream_failure" }),
        })
      );
    });

    // Trust-boundary guard: TypeScript's union (`"orphan" | "partial_stream_failure"
    // | "send_failure"`) is erased at runtime, so a malicious or buggy client could
    // POST arbitrary strings as retryReason. Without server-side validation, those
    // would land in HMAC-signed audit rows.
    it("rejects unknown retryReason and falls back to 'send_failure' in audit log", async () => {
      async function* fakeStream() {
        yield { type: "userMessagePersisted" as const, clientMessageId: "msg-id-1" };
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
        clientMessageId: "msg-id-1",
        isRetry: true,
        retryReason: "<script>alert(1)</script>" as any,
      });

      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "chat.retry_triggered",
          detail: expect.objectContaining({ reason: "send_failure" }),
        })
      );
    });

    it("does NOT append audit log for normal (non-retry) message sends", async () => {
      async function* fakeStream() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(createMockClientWs() as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });
  });

  describe("error chunk handling", () => {
    it("should send error to client on error chunk (no retry)", async () => {
      const clientWs = createMockClientWs();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockChat.mockImplementation(() => {
        return (async function* () {
          yield { type: "error" as const, text: "JSON parse error" };
        })();
      });

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      const messages = clientWs.sent.map((s) => JSON.parse(s));
      const errorMsg = messages.find((m: any) => m.type === "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.agentName).toBe("Smithers");
      expect(errorMsg.providerError).toBe("JSON parse error");
      // No retry — single attempt only
      expect(mockChat).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
    });

    it("should not send error on successful stream", async () => {
      const clientWs = createMockClientWs();

      async function* fakeStream() {
        yield { type: "text" as const, text: "Hello!" };
        yield { type: "done" as const, text: "" };
      }
      mockChat.mockReturnValue(fakeStream());

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockChat).toHaveBeenCalledTimes(1);
      const messages = clientWs.sent.map((s) => JSON.parse(s));
      expect(messages.some((m: any) => m.type === "done")).toBe(true);
      expect(messages.some((m: any) => m.type === "error")).toBe(false);
    });

    it("should stop streaming when browser disconnects", async () => {
      const clientWs = createMockClientWs();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockChat.mockImplementation(() => {
        return (async function* () {
          // Close the WS during the stream
          clientWs.readyState = 3; // CLOSED
          yield { type: "error" as const, text: "JSON parse error" };
        })();
      });

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      // Should only call chat once (no retries)
      expect(mockChat).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
    });

    it("should send error on thrown exceptions", async () => {
      const clientWs = createMockClientWs();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockChat.mockImplementation(async function* () {
        throw new Error("ECONNREFUSED");
      });

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockChat).toHaveBeenCalledTimes(1);
      const messages = clientWs.sent.map((s) => JSON.parse(s));
      expect(messages.some((m: any) => m.type === "error")).toBe(true);

      consoleSpy.mockRestore();
    });

    it("should include modelUnavailable in error frame when error chunk signals HTTP 5xx", async () => {
      const clientWs = createMockClientWs();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        model: "ollama-cloud/deepseek-v4-pro",
      });

      mockChat.mockImplementation(() => {
        return (async function* () {
          yield {
            type: "error" as const,
            text: 'HTTP 500: "Internal Server Error (ref: x-1)"',
          };
        })();
      });

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      const messages = clientWs.sent.map((s) => JSON.parse(s));
      const errorMsg = messages.find((m: any) => m.type === "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.modelUnavailable).toEqual({
        kind: "model_unavailable",
        model: "ollama-cloud/deepseek-v4-pro",
        httpStatus: 500,
        ref: "x-1",
      });

      consoleSpy.mockRestore();
    });

    it("should NOT include modelUnavailable in error frame when error is not HTTP 5xx", async () => {
      const clientWs = createMockClientWs();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        model: "ollama-cloud/deepseek-v4-pro",
      });

      mockChat.mockImplementation(() => {
        return (async function* () {
          yield {
            type: "error" as const,
            text: "Your credit balance is too low to access the API",
          };
        })();
      });

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      const messages = clientWs.sent.map((s) => JSON.parse(s));
      const errorMsg = messages.find((m: any) => m.type === "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg).not.toHaveProperty("modelUnavailable");

      consoleSpy.mockRestore();
    });
  });

  describe("pipeStream — consumer disconnect", () => {
    it("keeps draining the OpenClaw stream after the browser WS closes, so sessionCache records the completed turn", async () => {
      // This is the upstream half of the #199 Layer A regression guard pair:
      // Layer B (this test) populates the cache on disconnect; Layer A
      // (handleHistory regression-guards block below) consumes it on reload.
      // Together they prevent the "user message gone after reload" symptom.
      // Fresh cache so the test proves the add() actually happens here, not
      // pre-seeded by beforeEach.
      const freshCache = new SessionCache();
      const localRouter = new ClientRouter(
        mockOpenClawClient as any,
        "user-1",
        "member",
        freshCache
      );

      const clientWs = createMockClientWs();
      mockChat.mockReturnValue(
        steppedStream([
          { type: "text" as const, text: "tok-1" },
          { type: "text" as const, text: "tok-2" },
          { type: "done" as const, text: "" },
        ])
      );

      const handlePromise = localRouter.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      // Let at least one chunk be consumed, then "the browser navigates away"
      await new Promise((r) => setImmediate(r));
      clientWs.readyState = 3; // CLOSED

      await handlePromise;

      expect(freshCache.has("agent:agent-1:direct:user-1")).toBe(true);
    });

    it("does not send any frames to the browser WS after it has closed", async () => {
      const clientWs = createMockClientWs();
      mockChat.mockReturnValue(
        steppedStream([
          { type: "text" as const, text: "before-close" },
          { type: "text" as const, text: "after-close-1" },
          { type: "text" as const, text: "after-close-2" },
          { type: "done" as const, text: "" },
        ])
      );

      const handlePromise = router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      // Allow the first chunk to be forwarded
      await new Promise((r) => setImmediate(r));
      const sendCallsBeforeClose = clientWs.send.mock.calls.length;
      clientWs.readyState = 3; // CLOSED

      await handlePromise;

      expect(clientWs.send.mock.calls.length).toBe(sendCallsBeforeClose);
    });

    it("logs OpenClaw error chunks even when the consumer has already disconnected", async () => {
      // Observability invariant: with the drain-always loop, error chunks
      // arriving after the browser navigates away are exactly the chunks an
      // operator most needs to see — there's no UI to surface them. The
      // server-side console.error must therefore be unconditional, not
      // gated by readyState.
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const clientWs = createMockClientWs();
        mockChat.mockReturnValue(
          steppedStream([
            { type: "text" as const, text: "before-close" },
            { type: "error" as const, text: "upstream provider exploded" },
          ])
        );

        const handlePromise = router.handleMessage(clientWs as any, {
          type: "message",
          content: "Hi",
          agentId: "agent-1",
        });

        // Allow the first chunk to be consumed, then close the WS before the
        // error chunk arrives.
        await new Promise((r) => setImmediate(r));
        clientWs.readyState = 3; // CLOSED

        await handlePromise;

        const errorLogged = consoleSpy.mock.calls.some(
          (call) =>
            typeof call[0] === "string" &&
            call[0].includes("OpenClaw error chunk:") &&
            call[1] === "upstream provider exploded"
        );
        expect(errorLogged).toBe(true);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it("does not record the session in cache when the turn errors without a done chunk", async () => {
      // Errored turns are not "completed" from Pinchy's perspective —
      // sessionCache only tracks turns that reached a done chunk. This
      // test pins the behavior so a future drain-loop refactor can't
      // accidentally cache failed turns.
      const freshCache = new SessionCache();
      const localRouter = new ClientRouter(
        mockOpenClawClient as any,
        "user-1",
        "member",
        freshCache
      );

      const clientWs = createMockClientWs();
      mockChat.mockReturnValue(
        steppedStream([
          { type: "text" as const, text: "partial" },
          { type: "error" as const, text: "upstream blew up" },
        ])
      );

      // Suppress the now-unconditional console.error for cleanliness.
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await localRouter.handleMessage(clientWs as any, {
          type: "message",
          content: "Hi",
          agentId: "agent-1",
        });

        expect(freshCache.has("agent:agent-1:direct:user-1")).toBe(false);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it("clears the keep-alive heartbeat interval even when the consumer disconnects mid-stream", async () => {
      // setInterval/clearInterval are called from inside pipeStream; we
      // observe via vi.useFakeTimers + getTimerCount(). When the heartbeat
      // is cleared, the active timer count returns to zero.
      // Only fake setInterval/clearInterval so that steppedStream's
      // setImmediate calls remain real and can be awaited normally.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

      try {
        const clientWs = createMockClientWs();
        mockChat.mockReturnValue(
          steppedStream([
            { type: "text" as const, text: "first" },
            { type: "done" as const, text: "" },
          ])
        );

        const handlePromise = router.handleMessage(clientWs as any, {
          type: "message",
          content: "Hi",
          agentId: "agent-1",
        });

        // Consume the first chunk under fake timers
        await new Promise((r) => setImmediate(r));
        clientWs.readyState = 3; // CLOSED
        await handlePromise;

        // After pipeStream's finally, no leftover intervals
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("handleHistory — Layer A regression guards (#199)", () => {
    it("returns messages (not greeting) when sessionCache.has=true and history populates on the 2s retry", async () => {
      // Layer A symptom: after a mid-stream disconnect (handled by Layer B's
      // drain-always loop), the next reload calls handleHistory. If
      // sessions.history is briefly empty (OpenClaw hasn't re-indexed yet),
      // the cache hit must trigger the 2s retry — NOT a greeting fallback.
      // Without this branch, the user message visibly disappears on reload.
      //
      // Note: the cold-cache path (cache miss within 30s TTL after Pinchy
      // restart, sessions.list() falls back to live OpenClaw state) is
      // already covered by the existing "should retry history via
      // sessions.list fallback when cache is empty but session exists in
      // OpenClaw" test above. This test pins the *hot-cache* path, which is
      // the one Layer B's drain-always primes.
      const freshCache = new SessionCache();
      const sessionKey = "agent:agent-1:direct:user-1";
      freshCache.add(sessionKey); // simulate Layer-B's done-chunk effect

      const localRouter = new ClientRouter(
        mockOpenClawClient as any,
        "user-1",
        "member",
        freshCache
      );

      const clientWs = createMockClientWs();
      const agentWithGreeting = { ...defaultAgent, greetingMessage: "Hello." };
      mockFindFirst.mockResolvedValue(agentWithGreeting);

      // First call: empty (race window). Second call (after 2s retry): populated.
      mockSessionsHistory.mockResolvedValueOnce({ messages: [] }).mockResolvedValueOnce({
        messages: [
          { role: "user", content: "Hi", timestamp: 1 },
          { role: "assistant", content: "Hello!", timestamp: 2 },
        ],
      });

      // Speed up the 2s setTimeout in handleHistory.
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        const handlePromise = localRouter.handleMessage(clientWs as any, {
          type: "history",
          agentId: "agent-1",
        });
        await vi.advanceTimersByTimeAsync(2100);
        await handlePromise;
      } finally {
        vi.useRealTimers();
      }

      const sent = clientWs.sent.map((s) => JSON.parse(s));
      const historyFrames = sent.filter((m) => m.type === "history");
      expect(historyFrames).toHaveLength(1);

      // Strict shape assertion — pins both messages by role and content so a
      // future regression where the greeting is two frames (e.g. system primer
      // + greeting text) can't silently match a length-2 array.
      expect(historyFrames[0].messages).toEqual([
        { role: "user", content: "Hi", timestamp: 1 },
        { role: "assistant", content: "Hello!", timestamp: 2 },
      ]);

      // Belt-and-braces: the agent's greeting text must NOT appear on the wire,
      // proving sendGreeting() was not called as a fallback.
      const greetingFrames = sent.filter(
        (m) =>
          m.type === "history" &&
          m.messages.length === 1 &&
          m.messages[0].content === agentWithGreeting.greetingMessage
      );
      expect(greetingFrames).toHaveLength(0);

      // sessions.list() must NOT be called — the cache hit is supposed to
      // short-circuit the live fallback. (If it's called anyway, the test
      // would still pass on outcome, but the test would no longer be pinning
      // the cache-hit branch specifically.)
      expect(mockSessionsList).not.toHaveBeenCalled();
    });
  });

  describe("agent.model_unavailable audit log", () => {
    it("writes audit log with eventType agent.model_unavailable and outcome failure when HTTP 5xx error chunk arrives", async () => {
      const clientWs = createMockClientWs();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        model: "ollama-cloud/deepseek-v4-pro",
      });
      mockShouldEmitModelUnavailableAudit.mockReturnValue(true);

      mockChat.mockImplementation(() => {
        return (async function* () {
          yield {
            type: "error" as const,
            text: 'HTTP 503: "Service Unavailable (ref: err-42)"',
          };
        })();
      });

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: "user",
          actorId: "user-1",
          eventType: "agent.model_unavailable",
          resource: "agent:agent-1",
          outcome: "failure",
          detail: expect.objectContaining({
            agent: { id: "agent-1", name: "Smithers" },
            model: "ollama-cloud/deepseek-v4-pro",
            providerError: expect.stringContaining("HTTP 503"),
            httpStatus: 503,
            ref: "err-42",
          }),
        })
      );

      consoleSpy.mockRestore();
    });

    it("does NOT write audit log when throttle suppresses the event", async () => {
      const clientWs = createMockClientWs();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        model: "ollama-cloud/deepseek-v4-pro",
      });
      mockShouldEmitModelUnavailableAudit.mockReturnValue(false);

      mockChat.mockImplementation(() => {
        return (async function* () {
          yield {
            type: "error" as const,
            text: 'HTTP 500: "Internal Server Error"',
          };
        })();
      });

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockAppendAuditLog).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "agent.model_unavailable" })
      );

      consoleSpy.mockRestore();
    });

    it("does NOT write audit log when error chunk is not HTTP 5xx (no modelUnavailable)", async () => {
      const clientWs = createMockClientWs();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        model: "ollama-cloud/deepseek-v4-pro",
      });

      mockChat.mockImplementation(() => {
        return (async function* () {
          yield {
            type: "error" as const,
            text: "Your credit balance is too low to access the API",
          };
        })();
      });

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockAppendAuditLog).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "agent.model_unavailable" })
      );

      consoleSpy.mockRestore();
    });

    it("truncates providerError to 1024 chars in audit detail", async () => {
      const clientWs = createMockClientWs();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        model: "ollama-cloud/x",
      });
      mockShouldEmitModelUnavailableAudit.mockReturnValue(true);

      const longError = `HTTP 500: "${"x".repeat(2000)}"`;
      mockChat.mockImplementation(() => {
        return (async function* () {
          yield { type: "error" as const, text: longError };
        })();
      });

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "agent.model_unavailable",
          detail: expect.objectContaining({
            providerError: expect.stringMatching(/^.{1,1024}$/),
          }),
        })
      );
      const call = mockAppendAuditLog.mock.calls.find(
        (c: any[]) => c[0]?.eventType === "agent.model_unavailable"
      );
      expect(call![0].detail.providerError.length).toBeLessThanOrEqual(1024);

      consoleSpy.mockRestore();
    });

    it("does NOT include modelUnavailable and does NOT audit when agent.model is null even on HTTP 5xx", async () => {
      // Edge case: an agent in the DB with model=null falls through to the
      // provider's default at runtime. classifyModelError requires a non-empty
      // model identifier (we can't tell the user *which* model failed if we
      // don't know it), so it returns null. As a result no modelUnavailable
      // payload is added to the error frame and no audit is written.
      // This pins the contract: null model + 5xx = legacy plain error path.
      const clientWs = createMockClientWs();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFindFirst.mockResolvedValue({
        ...defaultAgent,
        model: null,
      });
      mockShouldEmitModelUnavailableAudit.mockReturnValue(true);

      mockChat.mockImplementation(() => {
        return (async function* () {
          yield {
            type: "error" as const,
            text: 'HTTP 500: "Internal Server Error (ref: x-2)"',
          };
        })();
      });

      await router.handleMessage(clientWs as any, {
        type: "message",
        content: "Hi",
        agentId: "agent-1",
      });

      // Error frame is sent, but without a modelUnavailable payload
      const messages = clientWs.sent.map((s) => JSON.parse(s));
      const errorMsg = messages.find((m: any) => m.type === "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg).not.toHaveProperty("modelUnavailable");

      // No audit entry of this type
      expect(mockAppendAuditLog).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "agent.model_unavailable" })
      );

      consoleSpy.mockRestore();
    });
  });
});
