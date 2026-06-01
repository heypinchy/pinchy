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

const mockCompact = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => ({ sessions: { compact: mockCompact } }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/agents/agent-1/sessions/compact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

// ── Tests ────────────────────────────────────────────────────────────────

describe("POST /api/agents/[agentId]/sessions/compact", () => {
  let POST: typeof import("@/app/api/agents/[agentId]/sessions/compact/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset modules so the per-session compaction throttle (module-level state
    // in @/lib/compact-throttle) starts fresh each test and doesn't leak a
    // recorded timestamp from one test into the next.
    vi.resetModules();
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "user@test.com", role: "member" },
    });
    // Default: access granted (getAgentWithAccess returns the agent row).
    mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Smithers" });
    mockCompact.mockResolvedValue({ ok: true });

    const mod = await import("@/app/api/agents/[agentId]/sessions/compact/route");
    POST = mod.POST;
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(401);
    expect(mockCompact).not.toHaveBeenCalled();
  });

  it("propagates the access decision from getAgentWithAccess (403/404)", async () => {
    mockGetAgentWithAccess.mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(403);
    expect(mockCompact).not.toHaveBeenCalled();
  });

  it("compacts the per-user session and returns 200 on success", async () => {
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(200);
    // Per-user session scoping: agent:<agentId>:direct:<userId>.
    expect(mockCompact).toHaveBeenCalledTimes(1);
    expect(mockCompact.mock.calls[0][0]).toBe("agent:agent-1:direct:user-1");
  });

  it("forwards maxLines to OpenClaw when provided", async () => {
    await POST(makeRequest({ maxLines: 200 }), ctx as never);
    expect(mockCompact).toHaveBeenCalledWith("agent:agent-1:direct:user-1", { maxLines: 200 });
  });

  it("returns 400 on an invalid body (maxLines not a positive int)", async () => {
    const res = await POST(makeRequest({ maxLines: -5 }), ctx as never);
    expect(res.status).toBe(400);
    expect(mockCompact).not.toHaveBeenCalled();
  });

  it("returns 502 (not 500) when OpenClaw compaction fails — UI can toast it", async () => {
    mockCompact.mockRejectedValueOnce(new Error("OpenClaw WS disconnected"));
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(502);
  });

  it("throttles a rapid second compaction of the same session (429, no second OC call)", async () => {
    const first = await POST(makeRequest(), ctx as never);
    expect(first.status).toBe(200);
    expect(mockCompact).toHaveBeenCalledTimes(1);

    // A second compaction of the same per-user session within the throttle
    // window is rejected BEFORE reaching OpenClaw — the UI debounces the button,
    // this guards direct API spamming from fanning out sessions.compact RPCs.
    const second = await POST(makeRequest(), ctx as never);
    expect(second.status).toBe(429);
    expect(mockCompact).toHaveBeenCalledTimes(1);
  });
});
