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

const mockGetActive = vi.fn();
const mockDismiss = vi.fn();
vi.mock("@/server/chat-session-errors", () => ({
  getActiveChatSessionError: (...args: unknown[]) => mockGetActive(...args),
  dismissChatSessionError: (...args: unknown[]) => mockDismiss(...args),
}));

const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args) };
});

function getRequest(url = "http://localhost/api/agents/agent-1/active-error") {
  return new NextRequest(url, { method: "GET" });
}
function deleteRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/agents/agent-1/active-error", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

const activeRow = {
  id: "err-1",
  agentName: "Penny",
  errorClass: "transient",
  transientReason: "rate_limit",
  providerError: "API rate limit reached",
  sideEffects: true,
  model: "ollama-cloud/gemini-3-flash",
  clientMessageId: "cm-1",
  createdAt: new Date("2026-06-18T09:38:43Z"),
};

describe("/api/agents/[agentId]/active-error", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/active-error/route").GET;
  let DELETE: typeof import("@/app/api/agents/[agentId]/active-error/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    mockGetAgentWithAccess.mockResolvedValue({ id: "agent-1", name: "Penny" });
    const mod = await import("@/app/api/agents/[agentId]/active-error/route");
    GET = mod.GET;
    DELETE = mod.DELETE;
  });

  describe("GET", () => {
    it("returns 401 when unauthenticated", async () => {
      mockGetSession.mockResolvedValueOnce(null);
      const res = await GET(getRequest(), ctx as never);
      expect(res.status).toBe(401);
    });

    it("propagates the access decision (403/404)", async () => {
      mockGetAgentWithAccess.mockResolvedValueOnce(
        NextResponse.json({ error: "Forbidden" }, { status: 403 })
      );
      const res = await GET(getRequest(), ctx as never);
      expect(res.status).toBe(403);
      expect(mockGetActive).not.toHaveBeenCalled();
    });

    it("returns the active error for the caller's per-user session", async () => {
      mockGetActive.mockResolvedValueOnce(activeRow);
      const res = await GET(getRequest(), ctx as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toMatchObject({
        id: "err-1",
        transientReason: "rate_limit",
        sideEffects: true,
        agentName: "Penny",
      });
      expect(mockGetActive).toHaveBeenCalledWith("agent:agent-1:direct:user-1");
    });

    it("scopes the lookup to the chatId when provided", async () => {
      mockGetActive.mockResolvedValueOnce(null);
      await GET(
        getRequest("http://localhost/api/agents/agent-1/active-error?chatId=chat-7"),
        ctx as never
      );
      expect(mockGetActive).toHaveBeenCalledWith("agent:agent-1:direct:user-1:chat-7");
    });

    it("returns null when the session has no active error", async () => {
      mockGetActive.mockResolvedValueOnce(null);
      const res = await GET(getRequest(), ctx as never);
      const body = await res.json();
      expect(body.error).toBeNull();
    });
  });

  describe("DELETE (dismiss)", () => {
    it("returns 401 when unauthenticated", async () => {
      mockGetSession.mockResolvedValueOnce(null);
      const res = await DELETE(deleteRequest({ id: "err-1" }), ctx as never);
      expect(res.status).toBe(401);
      expect(mockDismiss).not.toHaveBeenCalled();
    });

    it("dismisses the error scoped to the owner and audits it", async () => {
      mockDismiss.mockResolvedValueOnce({ ...activeRow, dismissedAt: new Date() });
      const res = await DELETE(deleteRequest({ id: "err-1" }), ctx as never);
      expect(res.status).toBe(200);
      expect(mockDismiss).toHaveBeenCalledWith({ id: "err-1", userId: "user-1" });
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "chat.error_dismissed", outcome: "success" })
      );
    });

    it("returns 404 when no matching error is owned by the user", async () => {
      mockDismiss.mockResolvedValueOnce(null);
      const res = await DELETE(deleteRequest({ id: "err-x" }), ctx as never);
      expect(res.status).toBe(404);
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("rejects a missing id with a 400", async () => {
      const res = await DELETE(deleteRequest({}), ctx as never);
      expect(res.status).toBe(400);
    });
  });
});
