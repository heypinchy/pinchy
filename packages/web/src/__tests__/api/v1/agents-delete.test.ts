import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * DELETE /api/v1/agents/[agentId] — key-authenticated agent deletion (#572,
 * Task 4.4).
 *
 * Mirrors the session `DELETE /api/agents/[agentId]`: same `deleteAgent()`
 * service, but a machine actor (`actorType: "api_key"`, design D2) and a
 * different answer for personal agents. A leaked `agents:delete` key must not
 * be able to delete users' personal agents, and the guard is the lookup scope
 * (`getAgent(id, { scope: "shared" })` never returns one) rather than a branch
 * in the route — so this suite pins the scope literal, and pins that the
 * resulting 404 is indistinguishable from an unknown id. Mirrors the
 * payload-assertion style of `agents-create.test.ts`.
 */

const { mockVerifyApiKey } = vi.hoisted(() => ({
  mockVerifyApiKey: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
  auth: {
    api: {
      verifyApiKey: mockVerifyApiKey,
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents")>();
  return {
    ...actual,
    getAgent: vi.fn(),
    deleteAgent: vi.fn(),
  };
});

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { DELETE } from "@/app/api/v1/agents/[agentId]/route";
import { getAgent, deleteAgent } from "@/lib/agents";
import { appendAuditLog } from "@/lib/audit";
import { revalidatePath } from "next/cache";

// ── Helpers ─────────────────────────────────────────────────────────────

function deleteRequest(
  headers: Record<string, string> = { Authorization: "Bearer pinchy_good" }
): NextRequest {
  return new NextRequest("http://localhost/api/v1/agents/agent-1", {
    method: "DELETE",
    headers,
  });
}

function ctx(agentId = "agent-1") {
  return { params: Promise.resolve({ agentId }) };
}

/** A successful verifyApiKey result with overridable `key` fields. */
function verifiedKey(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    error: null,
    key: {
      id: "key-1",
      name: "Provisioning Key",
      referenceId: "pinchy:service-account",
      permissions: { agents: ["delete"] },
      ...overrides,
    },
  };
}

const mockAgent = {
  id: "agent-1",
  name: "Shared Agent",
  isPersonal: false,
};

describe("DELETE /api/v1/agents/[agentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with { success: true } and deletes the agent for a valid agents:delete key", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(getAgent).mockResolvedValueOnce(mockAgent as never);
    vi.mocked(deleteAgent).mockResolvedValueOnce(mockAgent as never);

    const response = await DELETE(deleteRequest(), ctx("agent-1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(deleteAgent).toHaveBeenCalledWith("agent-1");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  // ── Headline assertion: the audit surface Pinchy sells ──────────────────

  it("audits agent.deleted with actorType 'api_key', the key snapshot, the pre-delete name, and NO issuer", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(getAgent).mockResolvedValueOnce(mockAgent as never);
    vi.mocked(deleteAgent).mockResolvedValueOnce(mockAgent as never);

    const response = await DELETE(deleteRequest(), ctx("agent-1"));
    expect(response.status).toBe(200);

    // Exact-match: the absence of an `issuer` field is as load-bearing as the
    // presence of `apiKey`. A key belongs to the org, not to whoever created
    // it (lib/api-key-identity.ts), so nothing here may claim a human
    // delegated this deletion — the key is the actor (design D2), and its own
    // snapshot stays readable after the key itself is revoked.
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "api_key",
      actorId: "key-1",
      eventType: "agent.deleted",
      resource: "agent:agent-1",
      outcome: "success",
      detail: {
        name: "Shared Agent",
        apiKey: { id: "key-1", name: "Provisioning Key" },
      },
    });
  });

  it("returns 404 when the agent does not exist, without deleting or auditing", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(getAgent).mockResolvedValueOnce(undefined);

    const response = await DELETE(deleteRequest(), ctx("nonexistent"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found" });
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  // ── Governance guard: a leaked key must not touch personal agents ───────

  it("asks for the 'shared' scope, which is what keeps personal agents unreachable", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(getAgent).mockResolvedValueOnce(mockAgent as never);
    vi.mocked(deleteAgent).mockResolvedValueOnce(mockAgent as never);

    await DELETE(deleteRequest(), ctx("agent-1"));

    // The guard is the lookup scope, not a branch in the route: a personal
    // agent never comes back, so there is nothing to forget to check. That
    // makes this literal load-bearing — with "all" the route would happily
    // delete a user's personal agent.
    expect(getAgent).toHaveBeenCalledWith("agent-1", { scope: "shared" });
  });

  it("404s a personal agent identically to a nonexistent one, without deleting or auditing", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    // `scope: "shared"` yields undefined for a personal agent — the route
    // cannot distinguish it from an unknown id, and must not try to. A
    // distinguishable answer (the previous 400 "Personal agents cannot be
    // deleted") is an oracle: a key holder could probe ids and learn which
    // ones are users' personal agents. The session route can afford that
    // message because its admin caller already sees every agent; a key does
    // not (GET /api/v1/agents omits them), so here it would leak.
    vi.mocked(getAgent).mockResolvedValueOnce(undefined);

    const response = await DELETE(deleteRequest(), ctx("someones-personal-agent"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found" });
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden when the key is missing the agents:delete scope", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey({ permissions: { agents: ["read"] } }));

    const response = await DELETE(deleteRequest(), ctx("agent-1"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(getAgent).not.toHaveBeenCalled();
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  it("returns 401 Unauthorized when no API key is present", async () => {
    const response = await DELETE(deleteRequest({}), ctx("agent-1"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
    expect(deleteAgent).not.toHaveBeenCalled();
  });
});
