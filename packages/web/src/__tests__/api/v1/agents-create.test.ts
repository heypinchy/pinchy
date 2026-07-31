import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { routeContext } from "@/test-helpers/route";

/**
 * POST /api/v1/agents — key-authenticated agent creation (#572, Task 4.2).
 *
 * `createAgent()` is mocked directly (not its DB internals) — the domain
 * logic is already covered by `create-agent-service.test.ts`; this suite
 * exercises the route's OWN job: scope auth, result → HTTP mapping, and — the
 * headline concern — the audit trail with a machine actor
 * (`actorType: "api_key"`, design D2), mirroring the payload-assertion style
 * of `agents-audit.test.ts`.
 *
 * Two things this suite deliberately pins, because both are easy to
 * "simplify" back into bugs:
 *
 *   - No issuer/delegation field. A key belongs to the org, not to the admin
 *     who created it (lib/api-key-identity.ts), so there is no person to
 *     attribute its actions to. The key's own snapshot is the attribution.
 *   - The audit is registered from `createAgent`'s `onCreated` callback — the
 *     moment the row exists — not after it returns. See the throw-mid-tail
 *     test below for what that buys.
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

import { POST } from "@/app/api/v1/agents/route";
import { createAgent, type CreateAgentHooks } from "@/lib/agents";
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
      referenceId: "pinchy:service-account",
      permissions: { agents: ["write"] },
      ...overrides,
    },
  };
}

const mockAgent = {
  id: "new-agent-id",
  name: "Provisioned Agent",
  model: "anthropic/claude-haiku-4-5-20251001",
  templateId: "custom",
  // Key-created agents are unowned: the key acts for the org, so naming the
  // creating admin here would be a claim that outlives them.
  ownerId: null,
};

const mockAuditInfo = {
  templateSkills: [],
  modelSelection: {
    source: "provider-default" as const,
    hint: null,
    reason: "provider-default (anthropic)",
  },
};

const successResult = {
  ok: true,
  agent: mockAgent,
  audit: mockAuditInfo,
  autoConfiguredPermissions: [],
};

/**
 * Stands in for a real `createAgent`: fires the hooks in the order the real
 * service fires them (the row commits, then each connection's grants commit),
 * and resolves. Tests that assert on the audit MUST go through this rather
 * than a bare `mockResolvedValueOnce`, because the route writes every audit
 * from these callbacks — a mock that never calls them would make the audit
 * assertions vacuous.
 */
function createAgentSucceeds(result: unknown = successResult) {
  vi.mocked(createAgent).mockImplementationOnce((async (
    _input: unknown,
    _ownerId: unknown,
    hooks?: CreateAgentHooks
  ) => {
    hooks?.onCreated?.(mockAgent as never, mockAuditInfo);
    const { autoConfiguredPermissions = [] } = result as {
      autoConfiguredPermissions?: { connectionId: string; permissions: unknown[] }[];
    };
    for (const entry of autoConfiguredPermissions) {
      hooks?.onPermissionsConfigured?.(mockAgent as never, entry as never);
    }
    return result;
  }) as never);
}

const validBody = { name: "Provisioned Agent", templateId: "custom" };

describe("POST /api/v1/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 201 with the created agent for a valid agents:write key", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    createAgentSucceeds();

    const response = await POST(postRequest(validBody), routeContext());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual(mockAgent);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Provisioned Agent", templateId: "custom" }),
      // ownerId: null — a key acts for the organization, so a key-created
      // agent has no human owner. Passing a user id here (as this route once
      // did, via the key's referenceId) would attribute the agent to someone
      // who may since have left.
      null,
      // The audit-timing contract, asserted at the call site: the route has to
      // hand the service BOTH hooks. Passing only onCreated is what left the
      // permission grants unaudited on a failing tail.
      expect.objectContaining({
        onCreated: expect.any(Function),
        onPermissionsConfigured: expect.any(Function),
      })
    );
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    // successResult.autoConfiguredPermissions is [] — the permission loop
    // must be a true no-op, not queue an empty/degenerate audit entry.
    expect(deferAuditLog).not.toHaveBeenCalled();
  });

  // ── Headline assertion: the audit surface Pinchy sells ──────────────────

  it("audits agent.created with actorType 'api_key' and the key snapshot, and NO issuer", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    createAgentSucceeds();

    const response = await POST(postRequest(validBody), routeContext());
    expect(response.status).toBe(201);

    // Exact-match: the absence of an `issuer` field is as load-bearing as the
    // presence of `apiKey`. The key is the actor; nothing here may claim a
    // human delegated this action.
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
      },
    });
  });

  // ── Runtime-apply failure is audited on the key path too (#880) ─────────

  it("returns 201 with a warning and audits runtime_apply_failed when the runtime apply fails", async () => {
    // Symmetry with the session route: createAgent commits the row, then does a
    // best-effort OpenClaw apply. On failure it returns `runtimeWarning` instead
    // of throwing, and the key API owes the same "created but not applied" audit
    // trail — with the KEY as actor — that the session route writes.
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    createAgentSucceeds({
      ...successResult,
      runtimeWarning: "Agent created. Applying it to the runtime failed — check the server logs.",
      runtimeApplyError: "EACCES: permission denied, open '/config/openclaw.json'",
    });

    const response = await POST(postRequest(validBody), routeContext());
    expect(response.status).toBe(201);
    const body = await response.json();
    // The persisted agent is still returned so a client can use it immediately.
    expect(body.id).toBe("new-agent-id");
    expect(typeof body.warning).toBe("string");
    expect(body.warning.length).toBeGreaterThan(0);

    expect(deferAuditLog).toHaveBeenCalledWith({
      actorType: "api_key",
      actorId: "key-1",
      eventType: "config.changed",
      resource: "agent:new-agent-id",
      detail: {
        action: "runtime_apply_failed",
        agentId: "new-agent-id",
        name: "Provisioned Agent",
        error: "EACCES: permission denied, open '/config/openclaw.json'",
        apiKey: { id: "key-1", name: "Provisioning Key" },
      },
      outcome: "failure",
    });
  });

  it("includes no warning and no runtime_apply_failed audit when the runtime apply succeeds", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    createAgentSucceeds();

    const response = await POST(postRequest(validBody), routeContext());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.warning).toBeUndefined();
    expect(deferAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ action: "runtime_apply_failed" }),
      })
    );
  });

  // ── The audit-timing contract (see createAgent's onCreated docblock) ────

  it("STILL audits the creation when createAgent throws after the row exists", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    // The realistic 500: the insert commits, then the workspace write or the
    // OpenClaw regen blows up. The agent EXISTS. Nothing rolls it back.
    vi.mocked(createAgent).mockImplementationOnce((async (
      _input: unknown,
      _ownerId: unknown,
      hooks?: CreateAgentHooks
    ) => {
      hooks?.onCreated?.(mockAgent as never, mockAuditInfo);
      throw new Error("regen failed");
    }) as never);

    await expect(POST(postRequest(validBody), routeContext())).rejects.toThrow("regen failed");

    // An agent that exists but was never written down is the one outcome an
    // audit product cannot ship. Registering the after() only once
    // createAgent RETURNED — as this route used to — lost exactly this record,
    // while the comment there advertised it as preventing a "false success".
    // The success was never false: the row is committed by this point.
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "agent.created",
        outcome: "success",
        resource: "agent:new-agent-id",
      })
    );
  });

  it("STILL audits config.changed when createAgent throws after the grants exist", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    // Same 500 as above, one step later: the agent row AND the Odoo permission
    // rows are committed, then the workspace write or the regen blows up.
    vi.mocked(createAgent).mockImplementationOnce((async (
      _input: unknown,
      _ownerId: unknown,
      hooks?: CreateAgentHooks
    ) => {
      hooks?.onCreated?.(mockAgent as never, mockAuditInfo);
      hooks?.onPermissionsConfigured?.(mockAgent as never, {
        connectionId: "conn-1",
        permissions: [{ model: "sale.order", operation: "write" }],
      });
      throw new Error("regen failed");
    }) as never);

    await expect(POST(postRequest(validBody), routeContext())).rejects.toThrow("regen failed");

    // Granting an agent write access to sale.order is exactly the kind of
    // change Pinchy exists to record. Reading `autoConfiguredPermissions` off
    // the RETURN value — as this route used to — loses it precisely here,
    // because there is no return value: the grants are live and nothing says
    // who made them. The sibling agent.created audit had already been moved
    // onto a callback for this reason; the grants were left behind.
    expect(deferAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        actorType: "api_key",
        actorId: "key-1",
        resource: "agent:new-agent-id",
        outcome: "success",
        detail: expect.objectContaining({
          connectionId: "conn-1",
          permissions: [{ model: "sale.order", operation: "write" }],
        }),
      })
    );
  });

  it("writes no audit when createAgent throws before the row exists", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    // Threw during template resolution / model selection — onCreated never
    // fires, so there is genuinely nothing to record.
    vi.mocked(createAgent).mockRejectedValueOnce(new Error("provider unreachable"));

    await expect(POST(postRequest(validBody), routeContext())).rejects.toThrow();

    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("audits auto-configured integration permissions as config.changed with actorType 'api_key'", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    createAgentSucceeds({
      ...successResult,
      autoConfiguredPermissions: [
        {
          connectionId: "conn-1",
          permissions: [{ model: "sale.order", operation: "read" }],
        },
      ],
    });

    const response = await POST(postRequest(validBody), routeContext());
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
      },
    });
  });

  it("returns 400 for an invalid body and does not write an audit entry", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());

    const response = await POST(postRequest({}), routeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Validation failed");
    expect(createAgent).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 422 with template_capability_unavailable and audits the failure with actorType 'api_key'", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    // Returns before the insert, so onCreated never fires — hence a plain
    // mockResolvedValueOnce rather than createAgentSucceeds().
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
      postRequest({ name: "Contract Bot", templateId: "contract-analyzer" }),
      routeContext()
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
      },
    });
    // Only the failure row — the success path never ran.
    expect(appendAuditLog).toHaveBeenCalledTimes(1);
  });

  it("returns 400 without an audit entry when createAgent rejects on plain validation (parity with the session route)", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(createAgent).mockResolvedValueOnce({
      ok: false,
      error: { status: 400, body: { error: "Unknown template: nonexistent" } },
    } as never);

    const response = await POST(
      postRequest({ name: "Test", templateId: "nonexistent" }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "Unknown template: nonexistent" });
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden when the key is missing the agents:write scope, and creates nothing", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey({ permissions: { agents: ["read"] } }));

    const response = await POST(postRequest(validBody), routeContext());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(createAgent).not.toHaveBeenCalled();
    // The denial itself IS audited — by withApiKey, whose own suite pins the
    // payload (with-api-key.test.ts). What must never appear is an
    // agent.created row: nothing was created.
    expect(appendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "agent.created" })
    );
  });

  it("returns 401 Unauthorized when no API key is present", async () => {
    const response = await POST(postRequest(validBody, {}), routeContext());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  });
});
