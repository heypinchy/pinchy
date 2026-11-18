// The duplicate-write retry gate, asked at the moment the user reaches for
// Retry rather than at the moment the run failed (#1013).
//
// The window this answers over comes from the stored run, never from the
// caller. A `?since=` parameter would have been simpler and would also have
// turned this into an oracle: "did agent X run a tool between T1 and T2" is a
// question a non-admin cannot otherwise ask (`/api/audit` is admin-only), and
// on a SHARED agent the answer is about a colleague's activity.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

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

const mockResolveRetryGate = vi.fn();
vi.mock("@/server/chat-session-errors", () => ({
  resolveRetryGate: (...args: unknown[]) => mockResolveRetryGate(...args),
}));

function getRequest(url = "http://localhost/api/agents/agent-1/retry-gate") {
  return new NextRequest(url, { method: "GET" });
}
const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

describe("/api/agents/[agentId]/retry-gate", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/retry-gate/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Penny" });
    mockResolveRetryGate.mockResolvedValue(false);
    const mod = await import("@/app/api/agents/[agentId]/retry-gate/route");
    GET = mod.GET;
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET(getRequest(), ctx as never);
    expect(res.status).toBe(401);
    expect(mockResolveRetryGate).not.toHaveBeenCalled();
  });

  it("propagates the access decision without answering", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );
    const res = await GET(getRequest(), ctx as never);
    expect(res.status).toBe(403);
    expect(mockResolveRetryGate).not.toHaveBeenCalled();
  });

  it("reports that a retry may duplicate writes", async () => {
    mockResolveRetryGate.mockResolvedValueOnce(true);
    const res = await GET(getRequest(), ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sideEffects: true });
  });

  it("asks about the caller's OWN session, built server-side", async () => {
    // The session key embeds the caller's id, so one user can never read
    // another's run — and the caller has no way to name a different one.
    await GET(getRequest(), ctx as never);
    expect(mockResolveRetryGate).toHaveBeenCalledWith({
      sessionKey: "agent:agent-1:direct:user-1",
      agentId: "agent-1",
    });
  });

  it("scopes to the chat the user is looking at", async () => {
    await GET(
      getRequest("http://localhost/api/agents/agent-1/retry-gate?chatId=chat-7"),
      ctx as never
    );
    expect(mockResolveRetryGate).toHaveBeenCalledWith({
      sessionKey: "agent:agent-1:direct:user-1:chat-7",
      agentId: "agent-1",
    });
  });

  it("takes no time window from the caller", async () => {
    // A `since` in the query string must change nothing. If it ever does, this
    // endpoint has become a queryable history of a shared agent's tool use.
    await GET(
      getRequest("http://localhost/api/agents/agent-1/retry-gate?since=1970-01-01T00:00:00.000Z"),
      ctx as never
    );
    expect(mockResolveRetryGate).toHaveBeenCalledWith({
      sessionKey: "agent:agent-1:direct:user-1",
      agentId: "agent-1",
    });
  });
});
