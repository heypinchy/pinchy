import { describe, it, expect, vi, beforeEach } from "vitest";

const mockChat = vi.fn();
vi.mock("openclaw-node", () => ({
  OpenClawClient: vi.fn().mockImplementation(() => ({
    chat: mockChat,
    isConnected: true,
  })),
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

describe("ClientRouter", () => {
  let router: ClientRouter;
  let mockOpenClawClient: { chat: typeof mockChat; isConnected: boolean };

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenClawClient = { chat: mockChat, isConnected: true };
    router = new ClientRouter(mockOpenClawClient as any);
  });

  it("should forward browser message to openclaw with provided sessionKey", async () => {
    async function* fakeStream() {
      yield { type: "text" as const, text: "Hello!" };
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    await router.handleMessage(createMockClientWs() as any, {
      type: "message",
      content: "Hi Smithers",
      agentId: "agent-1",
      sessionKey: "my-session-uuid",
    });

    expect(mockChat).toHaveBeenCalledWith("Hi Smithers", {
      sessionKey: "my-session-uuid",
    });
  });

  it("should forward browser message to openclaw without sessionKey when not provided", async () => {
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

    expect(mockChat).toHaveBeenCalledWith("Hi Smithers", {});
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
});
