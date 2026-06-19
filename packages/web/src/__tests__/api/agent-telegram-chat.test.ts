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

// drizzle expression builders are no-ops here — the mocked query chain ignores
// them and returns fixed rows per table.
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
  // desc tags its argument so the test can assert newest-first ordering.
  desc: (col: unknown) => ({ __desc: col }),
}));

// Schema sentinels: the route only needs object identity to pick the table.
vi.mock("@/db/schema", () => ({
  channelLinks: { __table: "channel_links", channel: {}, userId: {} },
  channelMessages: {
    __table: "channel_messages",
    direction: {},
    content: {},
    sentAt: {},
    agentId: {},
    channel: {},
    peerId: {},
  },
}));

// Two queries run: channel_links (peer lookup) then channel_messages (transcript).
// The chain is awaitable (`then`) and chainable (`where/orderBy/limit`) so both
// the `.where()`-terminated links query and the `.limit()`-terminated messages
// query resolve to the right rows by table identity.
let linkRows: unknown[];
let messageRows: unknown[];
let messagesFail = false;
const fromCalls: unknown[] = [];
const messagesWhereArgs: unknown[] = [];
const messagesOrderBy: unknown[] = [];
vi.mock("@/db", async () => {
  const schema = (await import("@/db/schema")) as {
    channelLinks: unknown;
    channelMessages: unknown;
  };
  const makeChain = (table: unknown) => {
    const isMessages = table === schema.channelMessages;
    const chain: Record<string, unknown> = {
      where: (...a: unknown[]) => {
        if (isMessages) messagesWhereArgs.push(...a);
        return chain;
      },
      orderBy: (...a: unknown[]) => {
        if (isMessages) messagesOrderBy.push(...a);
        return chain;
      },
      limit: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (isMessages && messagesFail) return reject?.(new Error("db down"));
        return resolve(isMessages ? messageRows : linkRows);
      },
    };
    return chain;
  };
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          fromCalls.push(table);
          return makeChain(table);
        },
      }),
    },
  };
});

const mockGetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeRequest() {
  return new NextRequest("http://localhost/api/agents/agent-1/telegram-chat", { method: "GET" });
}

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/agents/[agentId]/telegram-chat", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/telegram-chat/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    fromCalls.length = 0;
    messagesWhereArgs.length = 0;
    messagesOrderBy.length = 0;
    messagesFail = false;
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "user@test.com", role: "member" },
    });
    mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Smithers" });
    // This user has one linked Telegram peer (mixed case to prove lowercasing).
    linkRows = [{ channel: "telegram", userId: "user-1", channelUserId: "TG-Peer-111" }];
    // Pinchy-owned transcript. The route queries newest-first (desc + limit) to
    // render the most RECENT messages, so the mock returns rows newest-first;
    // the route must reverse them back to chronological order for rendering.
    messageRows = [
      { direction: "outbound", content: "Hi there!", sentAt: new Date(2000) },
      { direction: "inbound", content: "Hello from Telegram", sentAt: new Date(1000) },
    ];
    mockGetSetting.mockResolvedValue("smithers_bot");

    GET = (await import("@/app/api/agents/[agentId]/telegram-chat/route")).GET;
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(401);
  });

  it("propagates the access decision from getAgentWithAccess (403/404)", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(403);
  });

  it("renders the Pinchy-owned transcript: inbound→user, outbound→assistant, in order", async () => {
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(200);

    // Reads from Pinchy's own channel_messages store, NOT OpenClaw.
    const { channelMessages } = (await import("@/db/schema")) as { channelMessages: unknown };
    expect(fromCalls).toContain(channelMessages);

    // Recency: the query orders newest-first (desc) + limit, so a long
    // conversation shows the most RECENT backlog, not the oldest. The mock
    // returns rows newest-first; the response must be chronological (reversed).
    expect(messagesOrderBy).toContainEqual({ __desc: expect.anything() });
    const body = await res.json();
    expect(body.messages).toEqual([
      { role: "user", text: "Hello from Telegram", timestamp: 1000 },
      { role: "assistant", text: "Hi there!", timestamp: 2000 },
    ]);
  });

  it("returns 404 when the authed user has no linked Telegram conversation", async () => {
    linkRows = [];
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("No linked Telegram conversation");
    // Never query the transcript without a resolved peer.
    const { channelMessages } = (await import("@/db/schema")) as { channelMessages: unknown };
    expect(fromCalls).not.toContain(channelMessages);
  });

  it("empty transcript renders as an empty message list (still 200)", async () => {
    messageRows = [];
    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it("derives the peer from the AUTHED user only — a second user's transcript query uses THEIR peer, never the first user's", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "user-2", email: "other@test.com", role: "member" },
    });
    linkRows = [{ channel: "telegram", userId: "user-2", channelUserId: "tg-peer-222" }];

    const res = await GET(makeRequest(), ctx as never);
    expect(res.status).toBe(200);

    // The transcript query is keyed by user-2's peer (222), never user-1's (111).
    const where = JSON.stringify(messagesWhereArgs);
    expect(where).toContain("tg-peer-222");
    expect(where).not.toContain("tg-peer-111");
  });

  it("returns 502 (retryable) when the transcript query fails", async () => {
    messagesFail = true;
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
