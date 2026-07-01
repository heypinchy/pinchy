import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

const mockList = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => ({ sessions: { list: mockList } }),
}));

const mockWhere = vi.fn();
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: (...args: unknown[]) => mockWhere(...args),
      }),
    }),
  },
}));

import { listUserAgentChats } from "@/lib/chats/list-user-agent-chats";

// ── Fixtures ─────────────────────────────────────────────────────────────

/**
 * A mixed `sessions.list` payload spanning every classification branch. The
 * user is `user-1`; their linked Telegram peer is `tg-peer-111`.
 */
function mixedSessions() {
  return {
    sessions: [
      {
        key: "agent:agent-1:direct:user-1:chat-abc",
        sessionId: "s-web-new",
        label: "Quarterly report",
        lastInteractionAt: 5000,
      },
      { key: "agent:agent-1:direct:user-1", sessionId: "s-web-legacy", lastInteractionAt: 1000 },
      {
        key: "agent:agent-1:direct:tg-peer-111",
        sessionId: "s-telegram",
        label: "Telegram chat",
        lastInteractionAt: 3000,
      },
      // excluded: another user, unlinked peer, cron, subagent, other agent
      { key: "agent:agent-1:direct:user-2:chat-zzz", sessionId: "s-other-user" },
      { key: "agent:agent-1:direct:tg-peer-999", sessionId: "s-unlinked-peer" },
      { key: "agent:agent-1:cron:nightly", sessionId: "s-cron" },
      { key: "agent:agent-2:direct:user-1:chat-other", sessionId: "s-other-agent" },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("listUserAgentChats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockResolvedValue([
      { channel: "telegram", userId: "user-1", channelUserId: "tg-peer-111" },
    ]);
    mockList.mockResolvedValue(mixedSessions());
  });

  it("returns only the user's own web + telegram chats for this agent", async () => {
    const { chats } = await listUserAgentChats("agent-1", "user-1");
    const ids = chats.map((c) => c.sessionId).sort();
    expect(ids).toEqual(["s-telegram", "s-web-legacy", "s-web-new"]);
  });

  it("classifies web chats writable and telegram read-only, with chatId", async () => {
    const { chats } = await listUserAgentChats("agent-1", "user-1");
    const byId = new Map(chats.map((c) => [c.sessionId, c]));
    expect(byId.get("s-web-new")).toMatchObject({
      origin: "web",
      writable: true,
      chatId: "chat-abc",
    });
    expect(byId.get("s-web-legacy")).toMatchObject({ origin: "web", chatId: null });
    expect(byId.get("s-telegram")).toMatchObject({ origin: "telegram", writable: false });
  });

  it("exposes labels keyed by session key for callers that derive titles", async () => {
    const { labelByKey } = await listUserAgentChats("agent-1", "user-1");
    expect(labelByKey.get("agent:agent-1:direct:user-1:chat-abc")).toBe("Quarterly report");
    expect(labelByKey.get("agent:agent-1:direct:user-1")).toBeNull();
  });

  it("propagates OpenClaw failures so callers can map them to 502", async () => {
    mockList.mockRejectedValueOnce(new Error("OpenClaw WS disconnected"));
    await expect(listUserAgentChats("agent-1", "user-1")).rejects.toThrow();
  });
});
