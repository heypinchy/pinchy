/**
 * Tests for PROTOCOL_OUTDATED error frame behavior in the WS handler.
 *
 * The legacy attachment path (image_url base64 content parts) was removed in
 * favor of the two-phase upload / materializeAttachments path. Any client
 * still sending a structured content array with image_url parts is running
 * outdated code and must receive a PROTOCOL_OUTDATED error — it must NOT be
 * forwarded to OpenClaw or generate an audit entry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const {
  mockChat,
  mockSessionsHistory,
  mockFindFirst,
  mockUserFindFirst,
  mockAppendAuditLog,
  mockGetUserGroupIds,
  mockGetAgentGroupIds,
  mockMaterializeAttachments,
} = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockSessionsHistory: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  mockGetUserGroupIds: vi.fn().mockResolvedValue([]),
  mockGetAgentGroupIds: vi.fn().mockResolvedValue([]),
  mockMaterializeAttachments: vi.fn().mockResolvedValue({ chatAttachments: [], workspaceRefs: [] }),
}));

vi.mock("@/lib/agent-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-access")>();
  return {
    ...actual,
    assertAgentAccess: vi.fn(),
  };
});

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(true),
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

vi.mock("@/lib/audit", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: (...args: unknown[]) => mockGetUserGroupIds(...args),
  getAgentGroupIds: (...args: unknown[]) => mockGetAgentGroupIds(...args),
}));

vi.mock("@/server/model-unavailable-throttle", () => ({
  shouldEmitModelUnavailableAudit: vi.fn().mockReturnValue(false),
  shouldEmitSilentStreamAudit: vi.fn().mockReturnValue(false),
}));

vi.mock("@/server/attachment-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/attachment-pipeline")>();
  return {
    ...actual,
    materializeAttachments: mockMaterializeAttachments,
  };
});

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

function createMockOpenClawClient(connected = true) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    chat: mockChat,
    sessions: { history: mockSessionsHistory, list: vi.fn().mockResolvedValue({ sessions: [] }) },
    isConnected: connected,
  });
}

const defaultAgent = {
  id: "agent-1",
  name: "Smithers",
  ownerId: null,
  isPersonal: false,
  greetingMessage: "Hello.",
};

describe("PROTOCOL_OUTDATED — legacy image_url frames", () => {
  let router: ClientRouter;
  let mockOpenClawClient: ReturnType<typeof createMockOpenClawClient>;
  let sessionCache: SessionCache;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionCache = new SessionCache();
    sessionCache.refresh([{ key: "agent:agent-1:direct:user-1" }]);
    mockOpenClawClient = createMockOpenClawClient(true);
    router = new ClientRouter(mockOpenClawClient as any, "user-1", "member", sessionCache);
    mockFindFirst.mockResolvedValue(defaultAgent);
    mockUserFindFirst.mockResolvedValue({ id: "user-1", context: null });
    mockSessionsHistory.mockResolvedValue({ messages: [] });
  });

  it("sends PROTOCOL_OUTDATED and returns when content contains an image_url part", async () => {
    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "error", code: "PROTOCOL_OUTDATED" });
  });

  it("does NOT call OpenClaw chat when PROTOCOL_OUTDATED is triggered", async () => {
    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
      agentId: "agent-1",
    });

    expect(mockChat).not.toHaveBeenCalled();
  });

  it("does NOT write an audit log when PROTOCOL_OUTDATED is triggered", async () => {
    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
      agentId: "agent-1",
    });

    // Only the access-check audit might be written, but no chat-related audit should fire.
    // The PROTOCOL_OUTDATED path exits before any attachment or chat audit calls.
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("sends PROTOCOL_OUTDATED for image_url-only content (no text part)", async () => {
    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: [{ type: "image_url", image_url: { url: "data:application/pdf;base64,abc" } }],
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    expect(messages).toHaveLength(1);
    expect(messages[0].code).toBe("PROTOCOL_OUTDATED");
  });

  it("does NOT reject plain string content (text-only message, normal path)", async () => {
    async function* fakeStream() {
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Hello, plain text",
      agentId: "agent-1",
    });

    // No PROTOCOL_OUTDATED — it should proceed to OpenClaw
    const messages = clientWs.sent.map((s) => JSON.parse(s));
    expect(messages.some((m) => m.code === "PROTOCOL_OUTDATED")).toBe(false);
    expect(mockChat).toHaveBeenCalled();
  });

  it("does NOT reject structured content with only text parts (no image_url)", async () => {
    async function* fakeStream() {
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: [{ type: "text", text: "Just text in array" }],
      agentId: "agent-1",
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    expect(messages.some((m) => m.code === "PROTOCOL_OUTDATED")).toBe(false);
    expect(mockChat).toHaveBeenCalled();
  });
});

describe("attachmentIds — new two-phase upload path", () => {
  let router: ClientRouter;
  let mockOpenClawClient: ReturnType<typeof createMockOpenClawClient>;
  let sessionCache: SessionCache;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionCache = new SessionCache();
    sessionCache.refresh([{ key: "agent:agent-1:direct:user-1" }]);
    mockOpenClawClient = createMockOpenClawClient(true);
    router = new ClientRouter(mockOpenClawClient as any, "user-1", "member", sessionCache);
    mockFindFirst.mockResolvedValue(defaultAgent);
    mockUserFindFirst.mockResolvedValue({ id: "user-1", context: null });
    mockSessionsHistory.mockResolvedValue({ messages: [] });
  });

  it("calls materializeAttachments when attachmentIds is present and non-empty", async () => {
    mockMaterializeAttachments.mockResolvedValue({ chatAttachments: [], workspaceRefs: [] });
    async function* fakeStream() {
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const clientWs = createMockClientWs();
    const attachmentId = "550e8400-e29b-41d4-a716-446655440000";

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Please analyze this file",
      agentId: "agent-1",
      attachmentIds: [attachmentId],
    });

    expect(mockMaterializeAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        userId: "user-1",
        attachmentIds: [attachmentId],
        agentName: "Smithers",
      })
    );
  });

  it("skips materializeAttachments when attachmentIds is empty array", async () => {
    async function* fakeStream() {
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "No attachments",
      agentId: "agent-1",
      attachmentIds: [],
    });

    expect(mockMaterializeAttachments).not.toHaveBeenCalled();
  });

  it("skips materializeAttachments when attachmentIds is absent", async () => {
    async function* fakeStream() {
      yield { type: "done" as const, text: "" };
    }
    mockChat.mockReturnValue(fakeStream());

    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "No attachments",
      agentId: "agent-1",
    });

    expect(mockMaterializeAttachments).not.toHaveBeenCalled();
  });

  it("sends attachment_not_found error when AttachmentNotFoundError is thrown", async () => {
    const { AttachmentNotFoundError } = await import("@/server/attachment-pipeline");
    mockMaterializeAttachments.mockRejectedValue(
      new AttachmentNotFoundError(["550e8400-e29b-41d4-a716-446655440000"])
    );

    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Analyze this",
      agentId: "agent-1",
      attachmentIds: ["550e8400-e29b-41d4-a716-446655440000"],
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.code).toBe("attachment_not_found");
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("sends attachment_expired error when AttachmentExpiredError is thrown", async () => {
    const { AttachmentExpiredError } = await import("@/server/attachment-pipeline");
    mockMaterializeAttachments.mockRejectedValue(
      new AttachmentExpiredError(["550e8400-e29b-41d4-a716-446655440000"])
    );

    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Analyze this",
      agentId: "agent-1",
      attachmentIds: ["550e8400-e29b-41d4-a716-446655440000"],
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.code).toBe("attachment_expired");
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("sends attachment_already_attached error when AttachmentAlreadyAttachedError is thrown", async () => {
    const { AttachmentAlreadyAttachedError } = await import("@/server/attachment-pipeline");
    mockMaterializeAttachments.mockRejectedValue(
      new AttachmentAlreadyAttachedError(["550e8400-e29b-41d4-a716-446655440000"])
    );

    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Analyze this",
      agentId: "agent-1",
      attachmentIds: ["550e8400-e29b-41d4-a716-446655440000"],
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.code).toBe("attachment_already_attached");
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("sends attachment_invalid when materializeAttachments throws unexpected error", async () => {
    mockMaterializeAttachments.mockRejectedValueOnce(new Error("unexpected disk error"));

    const clientWs = createMockClientWs();

    await router.handleMessage(clientWs as any, {
      type: "message",
      content: "Analyze this",
      agentId: "agent-1",
      attachmentIds: ["550e8400-e29b-41d4-a716-446655440000"],
    });

    const messages = clientWs.sent.map((s) => JSON.parse(s));
    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.code).toBe("attachment_invalid");
    expect(mockChat).not.toHaveBeenCalled();
  });
});
