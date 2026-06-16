import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: () => mockGetSession(),
}));

const mockGetAgentWithAccess = vi.fn();
vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: (...args: unknown[]) => mockGetAgentWithAccess(...args),
}));

const mockHistory = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => ({ sessions: { history: mockHistory } }),
}));

// `db.select().from().where()` returns the linked channel rows for THIS user.
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

// `getSetting("telegram_bot_username:<agentId>")` resolves the bot username.
const mockGetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeRequest() {
  return new NextRequest("http://localhost/api/agents/agent-1/telegram-chat", {
    method: "GET",
  });
}

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

/**
 * A realistic OpenClaw `sessions.history` payload mixing the shapes the live
 * web chat already normalizes: a user turn with OpenClaw's `[timestamp]`
 * prefix, an assistant turn wrapped in `<final>` tags, and tool/system noise
 * that must be dropped.
 */
function transcriptPayload() {
  return {
    messages: [
      { role: "user", content: "[2026-06-16T10:00:00Z] Hello from Telegram", timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "<final>Hi there!</final>" }],
        timestamp: 2000,
      },
      // tool/system noise the read-only view drops, exactly like the live chat
      { role: "tool", content: "tool result blob", timestamp: 1500 },
      { role: "system", content: "system prompt", timestamp: 500 },
    ],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/agents/[agentId]/telegram-chat", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/telegram-chat/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "user@test.com", role: "member" },
    });
    mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Smithers" });
    // This user has one linked Telegram peer (note mixed case to prove lowercasing).
    mockWhere.mockResolvedValue([
      { channel: "telegram", userId: "user-1", channelUserId: "TG-Peer-111" },
    ]);
    mockHistory.mockResolvedValue(transcriptPayload());
    mockGetSetting.mockResolvedValue("smithers_bot");

    const mod = await import("@/app/api/agents/[agentId]/telegram-chat/route");
    GET = mod.GET;
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(401);
    expect(mockHistory).not.toHaveBeenCalled();
  });

  it("propagates the access decision from getAgentWithAccess (403/404)", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(403);
    expect(mockHistory).not.toHaveBeenCalled();
  });

  it("resolves the session key from the authed user's link and returns mapped messages", async () => {
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(200);

    // Session key is server-derived: agent:<agentId>:direct:<lowercased peerId>.
    expect(mockHistory).toHaveBeenCalledWith("agent:agent-1:direct:tg-peer-111", expect.anything());

    const body = await res.json();
    expect(body.messages).toEqual([
      { role: "user", text: "Hello from Telegram", timestamp: 1000 },
      { role: "assistant", text: "Hi there!", timestamp: 2000 },
    ]);
  });

  it("returns 404 when the authed user has no linked Telegram conversation", async () => {
    mockWhere.mockResolvedValueOnce([]);
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("No linked Telegram conversation");
    // Never hit OpenClaw without a resolved peer.
    expect(mockHistory).not.toHaveBeenCalled();
  });

  it("derives the peer from the AUTHED user only — a second user gets THEIR peer, never the first user's", async () => {
    // A different authed user with their OWN, different link.
    mockGetSession.mockResolvedValueOnce({
      user: { id: "user-2", email: "other@test.com", role: "member" },
    });
    mockWhere.mockResolvedValueOnce([
      { channel: "telegram", userId: "user-2", channelUserId: "tg-peer-222" },
    ]);

    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(200);

    // The session key uses user-2's peer (222), NOT user-1's peer (111).
    expect(mockHistory).toHaveBeenCalledWith("agent:agent-1:direct:tg-peer-222", expect.anything());
    const calledKey = mockHistory.mock.calls[0][0] as string;
    expect(calledKey).not.toContain("tg-peer-111");
  });

  it("returns 502 when OpenClaw sessions.history fails", async () => {
    mockHistory.mockRejectedValueOnce(new Error("OpenClaw WS disconnected"));
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(502);
  });

  it("returns a botDeepLink when the bot username resolves", async () => {
    const res = await GET(makeRequest(), ctx as never);
    const body = await res.json();
    expect(body.botDeepLink).toBe("https://t.me/smithers_bot");
  });

  it("returns botDeepLink null when no bot username is configured", async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), ctx as never);
    const body = await res.json();
    expect(body.botDeepLink).toBeNull();
  });
});
