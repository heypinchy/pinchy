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

const mockReset = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => ({ sessions: { reset: mockReset } }),
}));

const mockDeferAuditLog = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/agents/agent-1/sessions/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

// ── Tests ────────────────────────────────────────────────────────────────

describe("POST /api/agents/[agentId]/sessions/reset", () => {
  let POST: typeof import("@/app/api/agents/[agentId]/sessions/reset/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "user@test.com", role: "member" },
    });
    mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Smithers" });
    mockReset.mockResolvedValue({ ok: true });

    const mod = await import("@/app/api/agents/[agentId]/sessions/reset/route");
    POST = mod.POST;
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(401);
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockDeferAuditLog).not.toHaveBeenCalled();
  });

  it("propagates the access decision from getAgentWithAccess (403/404)", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(403);
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockDeferAuditLog).not.toHaveBeenCalled();
  });

  it("resets the per-user session in place with reason 'reset' and returns 200", async () => {
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(200);
    // Per-user session scoping, identical to compact: agent:<agentId>:direct:<userId>.
    // reason:"reset" tells OpenClaw this is a manual context clear (not the
    // daily auto-rotation, which Pinchy disables).
    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledWith("agent:agent-1:direct:user-1", { reason: "reset" });
  });

  it("resets the per-CHAT session when a chatId is provided (#611)", async () => {
    const res = await POST(makeRequest({ chatId: "chat-abc" }), ctx as never);
    expect(res.status).toBe(200);
    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockReset.mock.calls[0][0]).toBe("agent:agent-1:direct:user-1:chat-abc");
  });

  it("audits the reset as chat.session_reset with outcome success", async () => {
    await POST(makeRequest({ chatId: "chat-abc" }), ctx as never);
    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({
      actorType: "user",
      actorId: "user-1",
      eventType: "chat.session_reset",
      resource: "agent:agent-1",
      outcome: "success",
    });
    // Snapshot the agent name beside its id, and record which chat was reset.
    expect(entry.detail).toMatchObject({
      agent: { id: "agent-1", name: "Smithers" },
      chatId: "chat-abc",
    });
  });

  it("records chatId as null in the audit detail for the default session", async () => {
    await POST(makeRequest(), ctx as never);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.detail).toMatchObject({ chatId: null });
  });

  it("rejects an invalid chatId (400, no OC call, no audit)", async () => {
    const res = await POST(makeRequest({ chatId: "bad:id" }), ctx as never);
    expect(res.status).toBe(400);
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockDeferAuditLog).not.toHaveBeenCalled();
  });

  it("returns 502 (not 500) when OpenClaw reset fails, and does NOT audit a success", async () => {
    mockReset.mockRejectedValueOnce(new Error("OpenClaw WS disconnected"));
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(502);
    // The reset never took effect, so there is no state change to record.
    expect(mockDeferAuditLog).not.toHaveBeenCalled();
  });
});
