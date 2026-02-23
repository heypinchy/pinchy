import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const { mockChat, mockSessionsHistory, mockSessionsList, mockFindFirst, mockAppendAuditLog } =
  vi.hoisted(() => ({
    mockChat: vi.fn(),
    mockSessionsHistory: vi.fn(),
    mockSessionsList: vi.fn(),
    mockFindFirst: vi.fn(),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("@/lib/agent-access", () => ({
  assertAgentAccess: vi.fn((agent, userId, userRole) => {
    if (userRole === "admin") return;
    if (!agent.isPersonal) return;
    if (agent.ownerId === userId) return;
    throw new Error("Access denied");
  }),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findFirst: mockFindFirst,
      },
    },
  },
}));

vi.mock("@/db/schema", () => ({
  agents: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: mockAppendAuditLog,
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
    sessionCache.refresh([{ key: "agent:agent-1:user-user-1" }]);
    mockOpenClawClient = createMockOpenClawClient(true);
    router = new ClientRouter(mockOpenClawClient as any, "user-1", "user", sessionCache);

    // Default: agent exists and is accessible
    mockFindFirst.mockResolvedValue(defaultAgent);
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
      sessionKey: "agent:agent-1:user-user-1",
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
    expect(mockSessionsHistory).toHaveBeenCalledWith("agent:agent-1:user-user-1");
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

  it("should include consistent messageId in all chunks", async () => {
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
    const messageIds = messages.map((m: any) => m.messageId);
    expect(new Set(messageIds).size).toBe(1);
    expect(messageIds[0]).toBeTruthy();
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
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("error");
    expect(messages[0].message).toBe("Something went wrong. Please try again.");
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
      sessionKey: "agent:agent-1:user-user-1",
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
      sessionKey: "agent:agent-1:user-user-1",
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
      sessionKey: "agent:agent-1:user-user-1",
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
      sessionKey: "agent:agent-1:user-user-1",
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

  it("should return empty history when session not in cache", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "user", freshCache);
    const clientWs = createMockClientWs();

    // Cache is stale (never refreshed) and sessions.list returns no matching session
    mockSessionsList.mockResolvedValue({ sessions: [] });

    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    expect(mockSessionsHistory).not.toHaveBeenCalled();
    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([]);
  });

  it("should return greeting message in history when session not in cache", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "user", freshCache);
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: "Hello! I'm Smithers, your AI assistant. How can I help?",
    });

    // Cache is stale, sessions.list returns no matching session
    mockSessionsList.mockResolvedValue({ sessions: [] });

    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    expect(mockSessionsHistory).not.toHaveBeenCalled();
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

  it("should return empty history when session not in cache and agent has no greeting", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "user", freshCache);
    const clientWs = createMockClientWs();
    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: null,
    });

    // Cache is stale, sessions.list returns no matching session
    mockSessionsList.mockResolvedValue({ sessions: [] });

    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    expect(mockSessionsHistory).not.toHaveBeenCalled();
    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([]);
  });

  it("should include extraSystemPrompt with greeting context on first message", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "user", freshCache);
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
      sessionKey: "agent:agent-1:user-user-1",
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
      sessionKey: "agent:agent-1:user-user-1",
    });
  });

  it("should NOT include extraSystemPrompt when agent has no greeting", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "user", freshCache);
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
      sessionKey: "agent:agent-1:user-user-1",
    });
  });

  it("should add session key to cache after successful chat", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "user", freshCache);
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    // Before chat: key is not in cache
    expect(freshCache.has("agent:agent-1:user-user-1")).toBe(false);

    await freshRouter.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    // After chat completes: key should be in cache
    expect(freshCache.has("agent:agent-1:user-user-1")).toBe(true);
  });

  it("should send error when history fetch fails", async () => {
    const clientWs = createMockClientWs();
    mockSessionsHistory.mockRejectedValue(new Error("Gateway unavailable"));

    await router.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("error");
    expect(sent[0].message).toBe("Something went wrong. Please try again.");
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
    expect(messages[0].type).toBe("error");
    expect(messages[0].message).not.toContain("ECONNREFUSED");
    expect(messages[0].message).not.toContain("127.0.0.1");
    expect(messages[0].message).toBe("Something went wrong. Please try again.");
  });

  it("should sanitize history error messages before sending to client", async () => {
    const clientWs = createMockClientWs();
    mockSessionsHistory.mockRejectedValue(new Error("Internal: /root/.openclaw/config error"));

    await router.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent[0].type).toBe("error");
    expect(sent[0].message).not.toContain("/root/");
    expect(sent[0].message).toBe("Something went wrong. Please try again.");
  });

  it("should wait for reconnect and succeed when OpenClaw reconnects in time", async () => {
    // Start disconnected — sessions.history throws like real client
    const disconnectedClient = createMockOpenClawClient(false);
    const disconnectedRouter = new ClientRouter(
      disconnectedClient as any,
      "user-1",
      "user",
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

  it("should return error after timeout when OpenClaw does not reconnect", async () => {
    vi.useFakeTimers();

    const disconnectedClient = createMockOpenClawClient(false);
    const disconnectedRouter = new ClientRouter(
      disconnectedClient as any,
      "user-1",
      "user",
      sessionCache
    );

    mockSessionsHistory.mockRejectedValue(new Error("Not connected to OpenClaw Gateway"));

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
    expect(sent[0].type).toBe("error");
    expect(sent[0].message).toContain("not available");

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
    });
  });

  it("should log audit event when agent uses a tool", async () => {
    const clientWs = createMockClientWs();
    async function* fakeStream() {
      yield { type: "tool_use" as const, text: "search_web" };
      yield { type: "tool_result" as const, text: "result data" };
      yield { type: "text" as const, text: "Here are the results." };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Search for something",
      agentId: "agent-1",
    });

    expect(mockAppendAuditLog).toHaveBeenCalledTimes(2);
    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      actorType: "agent",
      actorId: "agent-1",
      eventType: "tool.execute",
      resource: "agent:agent-1",
      detail: { chunkType: "tool_use", text: "search_web" },
    });
    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      actorType: "agent",
      actorId: "agent-1",
      eventType: "tool.execute",
      resource: "agent:agent-1",
      detail: { chunkType: "tool_result", text: "result data" },
    });
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

  it("should call sessions.list when cache is stale for history", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "user", freshCache);
    mockSessionsList.mockResolvedValue({
      sessions: [{ key: "agent:agent-1:user-user-1" }],
    });
    mockSessionsHistory.mockResolvedValue({
      messages: [{ role: "user", content: "Hi" }],
    });

    const clientWs = createMockClientWs();
    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    expect(mockSessionsList).toHaveBeenCalled();
    expect(mockSessionsHistory).toHaveBeenCalledWith("agent:agent-1:user-user-1");
  });

  it("should return greeting when sessions.list fails", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "user", freshCache);

    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: "Hello!",
    });
    mockSessionsList.mockRejectedValue(new Error("Gateway timeout"));

    const clientWs = createMockClientWs();
    await freshRouter.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual([{ role: "assistant", content: "Hello!" }]);
  });

  it("should use session key format agent:<agentId>:user-<userId> for per-user scoping", async () => {
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
    expect(sessionKey).toMatch(/^agent:.+:user-.+$/);
    expect(sessionKey).toBe("agent:agent-1:user-user-1");
  });

  it("should find session when sessions.list returns user-scoped keys", async () => {
    // Sessions in OpenClaw use the format agent:<id>:user-<userId>.
    // The router must generate keys in the same format to find existing sessions.
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "user", freshCache);

    // OpenClaw returns sessions with its native key format
    mockSessionsList.mockResolvedValue({
      sessions: [{ key: "agent:agent-1:user-user-1" }],
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

  it("should send error to client when stream yields an error chunk", async () => {
    const clientWs = createMockClientWs();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    async function* fakeStream() {
      yield { type: "error" as const, text: "INVALID_REQUEST: model overloaded" };
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
    expect(errorMsg.message).toContain("Something went wrong");
    expect(errorMsg.message).not.toContain("INVALID_REQUEST");
    expect(errorMsg.message).not.toContain("overloaded");
    expect(errorMsg.messageId).toBeTruthy();

    // Should log the actual error server-side
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw error chunk"),
      expect.stringContaining("INVALID_REQUEST")
    );

    consoleSpy.mockRestore();
  });

  it("should return empty history when sessions.list fails and no greeting", async () => {
    const freshCache = new SessionCache();
    const freshRouter = new ClientRouter(mockOpenClawClient as any, "user-1", "user", freshCache);

    mockFindFirst.mockResolvedValue({
      ...defaultAgent,
      greetingMessage: null,
    });
    mockSessionsList.mockRejectedValue(new Error("Gateway timeout"));

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
});
