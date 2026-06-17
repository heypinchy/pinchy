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

const mockList = vi.fn();
const mockHistory = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => ({ sessions: { list: mockList, history: mockHistory } }),
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

// ── Helpers ──────────────────────────────────────────────────────────────

function makeRequest() {
  return new NextRequest("http://localhost/api/agents/agent-1/chats", {
    method: "GET",
  });
}

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

/**
 * A mixed `sessions.list` payload spanning every classification branch, so a
 * single assertion proves both the cross-user AND cross-agent authorization
 * boundary. The authed user is `user-1`; their linked Telegram peer is
 * `tg-peer-111` (OpenClaw principals are a single key segment — no colons).
 * The classifier lowercases the principal, so the link set is compared
 * lowercased.
 */
function mixedSessions() {
  return {
    sessions: [
      // authed user's web chat WITH a chatId (newer)
      {
        key: "agent:agent-1:direct:user-1:chat-abc",
        sessionId: "s-web-new",
        label: "Quarterly report",
        lastInteractionAt: 5000,
      },
      // authed user's LEGACY web chat (no chatId, older)
      {
        key: "agent:agent-1:direct:user-1",
        sessionId: "s-web-legacy",
        lastInteractionAt: 1000,
      },
      // authed user's linked Telegram peer (read-only, middle recency)
      {
        key: "agent:agent-1:direct:tg-peer-111",
        sessionId: "s-telegram",
        label: "Telegram chat",
        lastInteractionAt: 3000,
      },
      // ANOTHER user's web chat — must be excluded (cross-user isolation)
      {
        key: "agent:agent-1:direct:user-2:chat-zzz",
        sessionId: "s-other-user",
        lastInteractionAt: 9000,
      },
      // an UNLINKED Telegram peer — must be excluded
      {
        key: "agent:agent-1:direct:tg-peer-999",
        sessionId: "s-unlinked-peer",
        lastInteractionAt: 9000,
      },
      // a cron key — must be excluded
      {
        key: "agent:agent-1:cron:nightly",
        sessionId: "s-cron",
        lastInteractionAt: 9000,
      },
      // a subagent key — must be excluded
      {
        key: "agent:agent-1:subagent:helper",
        sessionId: "s-subagent",
        lastInteractionAt: 9000,
      },
      // the authed user's chat under a DIFFERENT agent — must be excluded
      // (cross-agent isolation)
      {
        key: "agent:agent-2:direct:user-1:chat-other",
        sessionId: "s-other-agent",
        lastInteractionAt: 9000,
      },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/agents/[agentId]/chats", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/chats/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Fresh module per test so the route's process-local title cache (keyed by
    // sessionId, 60s TTL) doesn't leak a derived title from one test into the
    // next (several tests reuse the s-web-legacy sessionId).
    vi.resetModules();
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "user@test.com", role: "member" },
    });
    mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Smithers" });
    // This user has one linked Telegram peer.
    mockWhere.mockResolvedValue([
      { channel: "telegram", userId: "user-1", channelUserId: "tg-peer-111" },
    ]);
    mockList.mockResolvedValue(mixedSessions());
    // Default: no transcript, so labelless chats stay title-null unless a test
    // opts a session into a first-user-message history below.
    mockHistory.mockResolvedValue({ messages: [] });

    const mod = await import("@/app/api/agents/[agentId]/chats/route");
    GET = mod.GET;
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("propagates the access decision from getAgentWithAccess (403/404)", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("enforces cross-user AND cross-agent isolation: returns only the user's own chats for this agent", async () => {
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    const sessionIds = body.chats.map((c: { sessionId: string }) => c.sessionId);

    // ONLY the authed user's chats for agent-1.
    expect(sessionIds).toEqual(expect.arrayContaining(["s-web-new", "s-web-legacy", "s-telegram"]));
    expect(sessionIds).toHaveLength(3);

    // Cross-user: another user's chat is excluded.
    expect(sessionIds).not.toContain("s-other-user");
    // Cross-agent: the user's own chat under agent-2 is excluded.
    expect(sessionIds).not.toContain("s-other-agent");
    // Other exclusions: unlinked peer, cron, subagent.
    expect(sessionIds).not.toContain("s-unlinked-peer");
    expect(sessionIds).not.toContain("s-cron");
    expect(sessionIds).not.toContain("s-subagent");
  });

  it("sorts chats by lastInteractionAt descending", async () => {
    const res = await GET(makeRequest(), ctx as never);
    const body = await res.json();
    const ids = body.chats.map((c: { sessionId: string }) => c.sessionId);
    // 5000 (web-new) > 3000 (telegram) > 1000 (web-legacy)
    expect(ids).toEqual(["s-web-new", "s-telegram", "s-web-legacy"]);
  });

  it("marks Telegram chats read-only and web chats writable, carrying the title", async () => {
    const res = await GET(makeRequest(), ctx as never);
    const body = await res.json();
    const byId = new Map(body.chats.map((c: { sessionId: string }) => [c.sessionId, c]));

    const telegram = byId.get("s-telegram") as { writable: boolean; title: string | null };
    expect(telegram.writable).toBe(false);
    expect(telegram.title).toBe("Telegram chat");

    const web = byId.get("s-web-new") as { writable: boolean; title: string | null };
    expect(web.writable).toBe(true);
    expect(web.title).toBe("Quarterly report");

    // Legacy web chat has no label → title is null.
    const legacy = byId.get("s-web-legacy") as { title: string | null };
    expect(legacy.title).toBeNull();
  });

  it("returns 502 when OpenClaw sessions.list fails", async () => {
    mockList.mockRejectedValueOnce(new Error("OpenClaw WS disconnected"));
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(502);
  });

  // ── Fix 2: derive list titles from the first user message ────────────────

  describe("title derivation from the first user message", () => {
    /**
     * Route `mockHistory` per session KEY. Web chats are keyed
     * `agent:agent-1:direct:user-1[:<chatId>]`. Anything not mapped returns an
     * empty transcript.
     */
    function historyByKey(entries: Record<string, { role: string; content: unknown }[]>) {
      const map = new Map(Object.entries(entries));
      mockHistory.mockImplementation(async (key: string) => ({ messages: map.get(key) ?? [] }));
    }

    it("derives a labelless web chat's title from its first user message", async () => {
      // s-web-legacy is the labelless web chat keyed at `…:direct:user-1`.
      historyByKey({
        "agent:agent-1:direct:user-1": [
          { role: "assistant", content: "Hi, how can I help?" },
          { role: "user", content: "What were our Q3 sales numbers?" },
          { role: "assistant", content: "Let me check." },
        ],
      });

      const res = await GET(makeRequest(), ctx as never);
      const body = await res.json();
      const byId = new Map(body.chats.map((c: { sessionId: string }) => [c.sessionId, c]));

      const legacy = byId.get("s-web-legacy") as { title: string | null };
      expect(legacy.title).toBe("What were our Q3 sales numbers?");
    });

    it("truncates a long first user message to ~60 chars", async () => {
      const long =
        "Please summarize the entire quarterly earnings report including every regional breakdown and footnote";
      historyByKey({ "agent:agent-1:direct:user-1": [{ role: "user", content: long }] });

      const res = await GET(makeRequest(), ctx as never);
      const body = await res.json();
      const byId = new Map(body.chats.map((c: { sessionId: string }) => [c.sessionId, c]));
      const legacy = byId.get("s-web-legacy") as { title: string | null };

      expect(legacy.title).not.toBeNull();
      expect(legacy.title!.length).toBeLessThanOrEqual(61); // 60 + an ellipsis char
      expect(legacy.title!).toMatch(/^Please summarize the entire quarterly earnings/);
      expect(legacy.title!.endsWith("…")).toBe(true);
    });

    it("keeps the saved label and does NOT read history when a label exists", async () => {
      // s-web-new HAS a label ("Quarterly report"); its history must not be read.
      const res = await GET(makeRequest(), ctx as never);
      const body = await res.json();
      const byId = new Map(body.chats.map((c: { sessionId: string }) => [c.sessionId, c]));

      const web = byId.get("s-web-new") as { title: string | null };
      expect(web.title).toBe("Quarterly report");

      // The labelled chat's session key was never passed to sessions.history.
      const fetchedKeys = mockHistory.mock.calls.map((c) => c[0]);
      expect(fetchedKeys).not.toContain("agent:agent-1:direct:user-1:chat-abc");
    });

    it("leaves title null for a labelless chat with no user message", async () => {
      // Default mockHistory returns empty messages → no first user message.
      const res = await GET(makeRequest(), ctx as never);
      const body = await res.json();
      const byId = new Map(body.chats.map((c: { sessionId: string }) => [c.sessionId, c]));

      const legacy = byId.get("s-web-legacy") as { title: string | null };
      expect(legacy.title).toBeNull();
    });

    it("does NOT read history for Telegram chats — their title stays the label", async () => {
      const res = await GET(makeRequest(), ctx as never);
      const body = await res.json();
      const byId = new Map(body.chats.map((c: { sessionId: string }) => [c.sessionId, c]));

      const telegram = byId.get("s-telegram") as { title: string | null };
      expect(telegram.title).toBe("Telegram chat");

      // The Telegram peer's session key was never passed to sessions.history.
      const fetchedKeys = mockHistory.mock.calls.map((c) => c[0]);
      expect(fetchedKeys).not.toContain("agent:agent-1:direct:tg-peer-111");
    });

    it("still returns chats when history reads fail (title falls back to null)", async () => {
      mockHistory.mockRejectedValue(new Error("history unavailable"));
      const res = await GET(makeRequest(), ctx as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      const byId = new Map(body.chats.map((c: { sessionId: string }) => [c.sessionId, c]));
      const legacy = byId.get("s-web-legacy") as { title: string | null };
      expect(legacy.title).toBeNull();
    });
  });
});
