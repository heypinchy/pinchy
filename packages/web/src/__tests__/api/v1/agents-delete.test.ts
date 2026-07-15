import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * DELETE /api/v1/agents/[agentId] — key-authenticated agent deletion (#572,
 * Task 4.4).
 *
 * Mirrors the session `DELETE /api/agents/[agentId]`: same `isPersonal`
 * guard (a leaked `agents:delete` key must not be able to delete users'
 * personal agents), same `deleteAgent()` service — but a machine actor
 * (`actorType: "api_key"`) plus issuer delegation (design D2), mirroring the
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

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));
vi.mock("@/db", () => ({
  db: {
    select: mockDbSelect,
  },
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
      referenceId: "user-1",
      permissions: { agents: ["delete"] },
      ...overrides,
    },
  };
}

/** Sets the PERSISTENT (not one-time) default for every
 * `db.select(...).from(...).where(...)` call (the issuer-name lookup) — used
 * by `beforeEach` so tests that don't care about the issuer lookup get a
 * stable resolvable user without needing to configure it themselves.
 * Mirrors `agents-create.test.ts`, now that `resolveIssuer` is shared. */
function setDefaultIssuerRow(row: { name: string } | undefined) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(row ? [row] : []),
    }),
  });
}

const mockAgent = {
  id: "agent-1",
  name: "Shared Agent",
  isPersonal: false,
};

const personalAgent = {
  id: "agent-1",
  name: "Someone's Personal Agent",
  isPersonal: true,
  ownerId: "user-2",
};

describe("DELETE /api/v1/agents/[agentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Persistent default: every test starts with a resolvable issuer unless
    // it overrides the mock itself. See agents-create.test.ts for why a
    // persistent default (not mockReturnValueOnce) is used here.
    setDefaultIssuerRow({ name: "Cara Admin" });
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

  it("audits agent.deleted with actorType 'api_key', the key snapshot, issuer delegation, and the pre-delete name", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(getAgent).mockResolvedValueOnce(mockAgent as never);
    vi.mocked(deleteAgent).mockResolvedValueOnce(mockAgent as never);

    const response = await DELETE(deleteRequest(), ctx("agent-1"));
    expect(response.status).toBe(200);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "api_key",
      actorId: "key-1",
      eventType: "agent.deleted",
      resource: "agent:agent-1",
      outcome: "success",
      detail: {
        name: "Shared Agent",
        apiKey: { id: "key-1", name: "Provisioning Key" },
        issuer: { id: "user-1", name: "Cara Admin" },
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

  // ── Governance guard: a leaked key must not delete personal agents ──────

  it("returns 400 when the agent is personal, without deleting or auditing", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(getAgent).mockResolvedValueOnce(personalAgent as never);

    const response = await DELETE(deleteRequest(), ctx("agent-1"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Personal agents cannot be deleted" });
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
