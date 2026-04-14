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
} = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockSessionsHistory: vi.fn(),
  mockSessionsList: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  mockGetUserGroupIds: vi.fn().mockResolvedValue([]),
  mockGetAgentGroupIds: vi.fn().mockResolvedValue([]),
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
  greetingMessage: null,
};

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
      content: "",
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

  it("should stop consuming stream early when client WebSocket closes mid-stream", async () => {
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

    // Should stop consuming after detecting the closed WS, not drain the entire stream
    expect(chunksYielded).toBe(2);
    // Only the first chunk should have been sent
    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const textChunks = messages.filter((m: any) => m.type === "chunk");
    expect(textChunks).toHaveLength(1);
    expect(textChunks[0].content).toBe("First ");
  });

  it("should return empty history when session has no messages", async () => {
    const clientWs = createMockClientWs();
    mockSessionsHistory.mockResolvedValue({ messages: [] });

    await router.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([]);
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

    expect(mockChat).toHaveBeenCalledWith("What is this?", {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:direct:user-1",
      attachments: [{ mimeType: "image/png", content: "abc123" }],
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
      content: "",
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
      content: "",
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
      content: "",
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
      content: "",
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
      content: "",
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
      content: "",
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

  it("should return empty history when no history and agent has no greeting", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: null,
    });

    // OpenClaw returns empty history
    mockSessionsHistory.mockResolvedValue({ messages: [] });

    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    expect(mockSessionsHistory).toHaveBeenCalledWith("agent:agent-1:direct:user-1");
    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([]);
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
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: null,
    });
    mockSessionsHistory.mockRejectedValue(new Error("Gateway unavailable"));

    await router.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([]);
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

  it("should fall back to greeting when history fetch throws an error", async () => {
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: "Hello!",
    });
    mockSessionsHistory.mockRejectedValue(new Error("Internal: /root/.openclaw/config error"));

    await router.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

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
      content: "",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
  });

  it("should return greeting after timeout when OpenClaw does not reconnect for history", async () => {
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
      content: "",
      agentId: "agent-1",
    });

    // Advance past the connection timeout
    await vi.advanceTimersByTimeAsync(11_000);
    await messagePromise;

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([{ role: "assistant", content: "Hello!" }]);

    vi.useRealTimers();
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
      content: "",
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
      content: "",
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

  it("should return empty history when history fetch fails and no greeting", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "member", freshCache);

    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: null,
    });
    mockSessionsHistory.mockRejectedValue(new Error("Gateway timeout"));

    const clientWs = createMockClientWs();
    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([]);
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
        content: "",
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
        content: "",
        agentId: "agent-1",
      });

      const sent = clientWs.sent.map((s) => JSON.parse(s));
      const greeting = sent[0].messages[0].content;
      expect(greeting).not.toContain("{user}");
      expect(greeting).toContain("I'm Smithers");
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
  });
});
