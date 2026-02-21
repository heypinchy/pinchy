import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockChat, mockSessionsHistory, mockGetOrCreateSession, mockFindFirst } = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockSessionsHistory: vi.fn(),
  mockGetOrCreateSession: vi.fn(),
  mockFindFirst: vi.fn(),
}));

vi.mock("@/lib/agent-access", () => ({
  assertAgentAccess: vi.fn((agent, userId, userRole) => {
    if (userRole === "admin") return;
    if (!agent.isPersonal) return;
    if (agent.ownerId === userId) return;
    throw new Error("Access denied");
  }),
}));

vi.mock("@/lib/chat-sessions", () => ({
  getOrCreateSession: mockGetOrCreateSession,
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

import { ClientRouter } from "@/server/client-router";

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
};

describe("ClientRouter", () => {
  let router: ClientRouter;
  let mockOpenClawClient: {
    chat: typeof mockChat;
    sessions: { history: typeof mockSessionsHistory };
    isConnected: boolean;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenClawClient = {
      chat: mockChat,
      sessions: { history: mockSessionsHistory },
      isConnected: true,
    };
    router = new ClientRouter(mockOpenClawClient as any, "user-1", "user");

    // Default: agent exists and is accessible
    mockFindFirst.mockResolvedValue(defaultAgent);

    // Default: session exists
    mockGetOrCreateSession.mockResolvedValue({
      id: "session-id",
      sessionKey: "server-session-key",
      userId: "user-1",
      agentId: "agent-1",
    });
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

  it("should use server-side session key for OpenClaw chat", async () => {
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

    expect(mockGetOrCreateSession).toHaveBeenCalledWith("user-1", "agent-1");
    expect(mockChat).toHaveBeenCalledWith("Hi Smithers", {
      sessionKey: "server-session-key",
      agentId: "agent-1",
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

    expect(mockGetOrCreateSession).toHaveBeenCalledWith("user-1", "agent-1");
    expect(mockSessionsHistory).toHaveBeenCalledWith("server-session-key");
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
      sessionKey: "server-session-key",
      agentId: "agent-1",
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
      sessionKey: "server-session-key",
      agentId: "agent-1",
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
      sessionKey: "server-session-key",
      agentId: "agent-1",
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
      sessionKey: "server-session-key",
      agentId: "agent-1",
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

  it("should allow admin to access personal agents of other users", async () => {
    const adminRouter = new ClientRouter(mockOpenClawClient as any, "admin-user", "admin");
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
    mockGetOrCreateSession.mockResolvedValue({
      id: "session-id",
      sessionKey: "admin-session-key",
      userId: "admin-user",
      agentId: "agent-1",
    });

    const clientWs = createMockClientWs();
    await adminRouter.handleMessage(clientWs as any, {
      type: "message",
      content: "Hi",
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    expect(messages.some((m: any) => m.type === "chunk")).toBe(true);
  });
});
