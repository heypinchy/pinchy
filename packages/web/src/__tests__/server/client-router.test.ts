import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockChat, mockReadSessionHistory, mockGetOrCreateSession, mockFindFirst } = vi.hoisted(
  () => ({
    mockChat: vi.fn(),
    mockReadSessionHistory: vi.fn(),
    mockGetOrCreateSession: vi.fn(),
    mockFindFirst: vi.fn(),
  })
);

vi.mock("openclaw-node", () => ({
  OpenClawClient: vi.fn().mockImplementation(() => ({
    chat: mockChat,
    isConnected: true,
  })),
}));

vi.mock("@/lib/session-history", () => ({
  readSessionHistory: mockReadSessionHistory,
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
    isConnected: boolean;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenClawClient = {
      chat: mockChat,
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
    });
  });

  it("should use server-side session for history", async () => {
    const clientWs = createMockClientWs();
    const historyMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    mockReadSessionHistory.mockReturnValue(historyMessages);

    await router.handleMessage(clientWs as any, {
      type: "history",
      content: "",
      agentId: "agent-1",
    });

    expect(mockGetOrCreateSession).toHaveBeenCalledWith("user-1", "agent-1");
    expect(mockReadSessionHistory).toHaveBeenCalledWith("server-session-key");
    const sent = clientWs.sent.map((s) => JSON.parse(s));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("history");
    expect(sent[0].messages).toEqual(historyMessages);
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
    expect(messages[0].message).toBe("OpenClaw unavailable");
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
    mockReadSessionHistory.mockReturnValue([]);

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

    expect(mockChat).toHaveBeenCalledWith("Hi", { sessionKey: "server-session-key" });
    expect(mockReadSessionHistory).not.toHaveBeenCalled();
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
    });
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
