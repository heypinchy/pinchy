import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/v1/agents — key-authenticated agent creation (#572, Task 4.2).
 *
 * `createAgent()` is mocked directly (not its DB internals) — the domain
 * logic is already covered by `create-agent-service.test.ts`; this suite
 * exercises the route's OWN job: scope auth, result → HTTP mapping, and —
 * the headline concern — the audit trail with a machine actor
 * (`actorType: "api_key"`) plus issuer delegation (design D2), mirroring the
 * payload-assertion style of `agents-audit.test.ts`.
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
    createAgent: vi.fn(),
    listAgents: vi.fn(),
  };
});

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: vi.fn(),
}));

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));
vi.mock("@/db", () => ({
  db: {
    select: mockDbSelect,
  },
}));

import { POST } from "@/app/api/v1/agents/route";
import { createAgent } from "@/lib/agents";
import { appendAuditLog } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { revalidatePath } from "next/cache";

// ── Helpers ─────────────────────────────────────────────────────────────

function postRequest(
  body: unknown,
  headers: Record<string, string> = { Authorization: "Bearer pinchy_good" }
): NextRequest {
  return new NextRequest("http://localhost/api/v1/agents", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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
      permissions: { agents: ["write"] },
      ...overrides,
    },
  };
}

/** Sets the PERSISTENT (not one-time) default for every
 * `db.select(...).from(...).where(...)` call (the issuer-name lookup) —
 * used by `beforeEach` so tests that don't care about the issuer lookup get
 * a stable resolvable user without needing to configure it themselves. */
function setDefaultIssuerRow(row: { name: string } | undefined) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(row ? [row] : []),
    }),
  });
}

/** Overrides ONLY the next `db.select(...)` call (the issuer-name lookup) to
 * resolve to `row`, or to an empty result set when `row` is undefined
 * (simulating a user that can no longer be found). `mockReturnValueOnce`
 * takes priority over the persistent default set by `setDefaultIssuerRow`,
 * and — because each test triggers at most one issuer lookup — is fully
 * consumed within the same test, so it can never leak into the next one. */
function mockIssuerLookup(row: { name: string } | undefined) {
  mockDbSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(row ? [row] : []),
    }),
  });
}

/** Overrides ONLY the next issuer-name lookup to throw — proving the audit
 * path never lets a DB hiccup fail agent creation. */
function mockIssuerLookupThrows() {
  mockDbSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockRejectedValue(new Error("connection reset")),
    }),
  });
}

const mockAgent = {
  id: "new-agent-id",
  name: "Provisioned Agent",
  model: "anthropic/claude-haiku-4-5-20251001",
  templateId: "custom",
  ownerId: "user-1",
};

const successResult = {
  ok: true,
  agent: mockAgent,
  audit: {
    templateSkills: [],
    modelSelection: {
      source: "provider-default",
      hint: null,
      reason: "provider-default (anthropic)",
    },
  },
  autoConfiguredPermissions: [],
};

const validBody = { name: "Provisioned Agent", templateId: "custom" };

describe("POST /api/v1/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Persistent (non-"Once") default: every test starts with a resolvable
    // issuer unless it calls mockIssuerLookup()/mockIssuerLookupThrows() to
    // override the single lookup call the route makes. Using a persistent
    // default here (rather than mockReturnValueOnce) matters — mockReturnValueOnce
    // queues FIFO, so a default queued in beforeEach would always be consumed
    // before a same-test override queued afterwards.
    setDefaultIssuerRow({ name: "Cara Admin" });
  });

  it("returns 201 with the created agent for a valid agents:write key", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(createAgent).mockResolvedValueOnce(successResult as never);

    const response = await POST(postRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual(mockAgent);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Provisioned Agent", templateId: "custom" }),
      "user-1" // key.issuerUserId — ownerId for a key-created agent
    );
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    // successResult.autoConfiguredPermissions is [] — the permission loop
    // must be a true no-op, not queue an empty/degenerate audit entry.
    expect(deferAuditLog).not.toHaveBeenCalled();
  });

  // ── Headline assertion: the audit surface Pinchy sells ──────────────────

  it("audits agent.created with actorType 'api_key', the key snapshot, and issuer delegation", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(createAgent).mockResolvedValueOnce(successResult as never);

    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(201);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "api_key",
      actorId: "key-1",
      eventType: "agent.created",
      resource: "agent:new-agent-id",
      outcome: "success",
      detail: {
        name: "Provisioned Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        templateId: "custom",
        skills: [],
        modelSelection: {
          source: "provider-default",
          hint: null,
          reason: "provider-default (anthropic)",
        },
        apiKey: { id: "key-1", name: "Provisioning Key" },
        issuer: { id: "user-1", name: "Cara Admin" },
      },
    });
  });

  it("writes no success audit when createAgent throws mid-creation", async () => {
    // The after(() => appendAuditLog(...)) registration sits AFTER the
    // `createAgent()` call in route.ts (comment: "Registered only after
    // createAgent() fully succeeds") — a throw there (permissions/workspace/
    // regen failure → 500) must mean that line never runs, so a
    // partially-created agent can never emit a false "success" governance
    // record. `createAgent` is mocked, so this is cheap to lock in.
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(createAgent).mockRejectedValueOnce(new Error("regen failed"));

    await expect(POST(postRequest(validBody))).rejects.toThrow();

    expect(appendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "success" })
    );
  });

  it("falls back to an empty issuer name when the issuing user can no longer be found", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(createAgent).mockResolvedValueOnce(successResult as never);
    mockIssuerLookup(undefined); // overrides the beforeEach default: no row found

    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(201);

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          issuer: { id: "user-1", name: "" },
        }),
      })
    );
  });

  it("never fails agent creation when the issuer-name lookup throws (audit path must not throw)", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(createAgent).mockResolvedValueOnce(successResult as never);
    mockIssuerLookupThrows(); // overrides the beforeEach default

    const response = await POST(postRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual(mockAgent);
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          issuer: { id: "user-1", name: "" },
        }),
      })
    );
  });

  it("audits auto-configured integration permissions as config.changed with actorType 'api_key'", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(createAgent).mockResolvedValueOnce({
      ...successResult,
      autoConfiguredPermissions: [
        {
          connectionId: "conn-1",
          permissions: [{ model: "sale.order", operation: "read" }],
        },
      ],
    } as never);

    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(201);

    expect(deferAuditLog).toHaveBeenCalledWith({
      actorType: "api_key",
      actorId: "key-1",
      eventType: "config.changed",
      resource: "agent:new-agent-id",
      outcome: "success",
      detail: {
        action: "agent_integration_permissions_auto_configured",
        agentId: "new-agent-id",
        connectionId: "conn-1",
        permissions: [{ model: "sale.order", operation: "read" }],
        apiKey: { id: "key-1", name: "Provisioning Key" },
        issuer: { id: "user-1", name: "Cara Admin" },
      },
    });
  });

  it("returns 400 for an invalid body and does not write an audit entry", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());

    const response = await POST(postRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Validation failed");
    expect(createAgent).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
    // The issuer lookup is only worth its DB round-trip when an audit entry
    // is actually going to be written — a malformed body must short-circuit
    // before it.
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("returns 422 with template_capability_unavailable and audits the failure with actorType 'api_key'", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(createAgent).mockResolvedValueOnce({
      ok: false,
      error: {
        status: 422,
        body: {
          error: "template_capability_unavailable",
          message: "The configured provider does not support the required capability.",
          missingCapabilities: ["vision"],
          docsUrl: "https://docs.heypinchy.com/guides/ollama-setup#models-for-agent-templates",
        },
        capabilityFailure: {
          templateId: "contract-analyzer",
          missingCapabilities: ["vision"],
          provider: "ollama-local",
        },
      },
    } as never);

    const response = await POST(
      postRequest({ name: "Contract Bot", templateId: "contract-analyzer" })
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({
      error: "template_capability_unavailable",
      message: "The configured provider does not support the required capability.",
      missingCapabilities: ["vision"],
      docsUrl: "https://docs.heypinchy.com/guides/ollama-setup#models-for-agent-templates",
    });

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "api_key",
      actorId: "key-1",
      eventType: "agent.created",
      outcome: "failure",
      detail: {
        templateId: "contract-analyzer",
        missingCapabilities: ["vision"],
        provider: "ollama-local",
        apiKey: { id: "key-1", name: "Provisioning Key" },
        issuer: { id: "user-1", name: "Cara Admin" },
      },
    });
  });

  it("returns 400 without an audit entry when createAgent rejects on plain validation (parity with the session route)", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(createAgent).mockResolvedValueOnce({
      ok: false,
      error: { status: 400, body: { error: "Unknown template: nonexistent" } },
    } as never);

    const response = await POST(postRequest({ name: "Test", templateId: "nonexistent" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "Unknown template: nonexistent" });
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden when the key is missing the agents:write scope", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey({ permissions: { agents: ["read"] } }));

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(createAgent).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 401 Unauthorized when no API key is present", async () => {
    const response = await POST(postRequest(validBody, {}));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  });
});
