import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Unit test for the createAgent() service ────────────────────────────────
//
// createAgent() is the auth-, audit-, and HTTP-agnostic domain service that
// both POST /api/agents (session auth) and the future POST /api/v1/agents
// (key auth) call. It performs template resolution, model selection, the DB
// insert, integration-permission auto-config, workspace materialization and
// the OpenClaw regen + runtime wait — then returns a discriminated result so
// each route owns its own audit + HTTP mapping. The service itself NEVER
// writes audit logs (#572).

const { insertValuesMock } = vi.hoisted(() => ({
  insertValuesMock: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([
      {
        id: "new-agent-id",
        name: "Test Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        templateId: "custom",
        pluginConfig: null,
        ownerId: "user-1",
        tagline: null,
      },
    ]),
  }),
}));

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: insertValuesMock }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
  },
}));

vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  writeWorkspaceFileInternal: vi.fn(),
  writeIdentityFile: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock("@/lib/context-sync", () => ({
  getContextForAgent: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

const mockOpenClawClient = { config: { get: vi.fn() } };
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: vi.fn(() => mockOpenClawClient),
}));

const mockWaitForAgentInRuntime = vi.fn().mockResolvedValue(true);
vi.mock("@/lib/wait-for-agent-in-runtime", () => ({
  waitForAgentInRuntime: (...args: unknown[]) => mockWaitForAgentInRuntime(...args),
}));

vi.mock("@/lib/path-validation", () => ({
  validateAllowedPaths: vi.fn((paths: string[]) =>
    paths.map((p) => (p.endsWith("/") ? p : p + "/"))
  ),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue("anthropic"),
  getSettingsByPrefix: vi.fn().mockResolvedValue(new Map()),
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn().mockResolvedValue("anthropic/claude-haiku-4-5-20251001"),
  getOllamaLocalModels: vi.fn().mockReturnValue([]),
}));

const { mockResolveAvailableModelForTemplate } = vi.hoisted(() => ({
  mockResolveAvailableModelForTemplate: vi.fn(),
}));
// The service resolves through the live-catalog-aware resolver (#880 route
// parity — a retired template pick is substituted for a live default), which
// reaches the provider catalog. Mock that module so these unit tests don't.
// `TemplateCapabilityUnavailableError` (imported below) stays the real class,
// so the 422 path's `instanceof` check matches.
vi.mock("@/lib/model-resolver/resolve-available", () => ({
  resolveAvailableModelForTemplate: mockResolveAvailableModelForTemplate,
}));

vi.mock("@/lib/personality-presets", () => ({
  getPersonalityPreset: vi.fn(() => ({ greetingMessage: null, soulMd: "# SOUL.md" })),
  resolveGreetingMessage: (greeting: string | null, name: string) =>
    greeting ? greeting.replace("{name}", name) : null,
}));

vi.mock("@/lib/avatar", () => ({
  generateAvatarSeed: vi.fn().mockReturnValue("mock-seed-uuid"),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/integrations/odoo-template-validation", () => ({
  validateOdooTemplate: vi.fn(),
}));

import { createAgent } from "@/lib/agents";
import { appendAuditLog } from "@/lib/audit";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { TemplateCapabilityUnavailableError } from "@/lib/model-resolver";

describe("createAgent() service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default the live-catalog resolver to a happy pick; modelHint templates
    // consult it, and individual tests override with mockResolved/RejectedOnce.
    mockResolveAvailableModelForTemplate.mockResolvedValue({
      model: "anthropic/claude-haiku-4-5-20251001",
      reason: "template-hint (balanced)",
    });
  });

  // ── The onCreated timing contract ───────────────────────────────────────
  //
  // Both routes hang their agent.created audit off this callback, so its
  // TIMING is the contract, not just its arguments: it has to fire once the
  // row is committed and before the tail that can still throw. Assert it here
  // (the service owns the contract) — a route-level test can't, since its
  // mocked createAgent is the thing whose timing is in question.

  it("fires onCreated with the agent and audit info on the happy path", async () => {
    const onCreated = vi.fn();

    const result = await createAgent({ name: "Test Agent", templateId: "custom" }, "user-1", {
      onCreated,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(onCreated).toHaveBeenCalledTimes(1);
    // Same objects the return value carries — one source of truth, so a
    // callback caller and a return-value caller can't disagree.
    expect(onCreated).toHaveBeenCalledWith(result.agent, result.audit);
  });

  it("fires onCreated BEFORE the OpenClaw regen, so a failing tail still gets audited", async () => {
    const calls: string[] = [];
    const onCreated = vi.fn(() => void calls.push("onCreated"));
    vi.mocked(regenerateOpenClawConfig).mockImplementationOnce(async () => {
      calls.push("regen");
      throw new Error("openclaw unreachable");
    });

    // #880: the failing regen is caught, so createAgent resolves (the agent is
    // committed) and reports the failure via runtimeWarning rather than throwing.
    const result = await createAgent({ name: "Test Agent", templateId: "custom" }, "user-1", {
      onCreated,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.runtimeWarning).toEqual(expect.any(String));

    // onCreated fired the moment the row committed — BEFORE the regen. That
    // ordering is the contract: the create is recorded even when the tail fails.
    // (#880 catches the regen throw, so createAgent resolves with a
    // runtimeWarning; the ordering guarantee is unchanged, and a tail step that
    // is NOT caught — a workspace write — would still leave the record here.)
    expect(insertValuesMock).toHaveBeenCalled();
    expect(calls).toEqual(["onCreated", "regen"]);
  });

  // ── The onPermissionsConfigured timing contract ─────────────────────────
  //
  // The same contract as onCreated, one step later, and it earns its own test
  // because it was the half that got missed: agent.created was moved onto a
  // callback while the permission grants kept being read off the RETURN value
  // — which, on a throwing tail, does not exist. Granting an agent access to a
  // connection is the most audit-relevant thing this service does.

  it("fires onPermissionsConfigured BEFORE the OpenClaw regen, so a failing tail still gets audited", async () => {
    const calls: string[] = [];
    const onPermissionsConfigured = vi.fn(() => void calls.push("permissions"));
    // email-assistant carries a modelHint, unlike `custom`, so the resolver is
    // actually consulted on this path.
    mockResolveAvailableModelForTemplate.mockResolvedValueOnce({
      model: "anthropic/claude-haiku-4-5-20251001",
      reason: "template-hint (balanced)",
    });
    vi.mocked(regenerateOpenClawConfig).mockImplementationOnce(async () => {
      calls.push("regen");
      throw new Error("openclaw unreachable");
    });

    // #880: the failing regen is caught — createAgent resolves (the grants are
    // committed) and reports the failure via runtimeWarning.
    const result = await createAgent(
      // email-assistant carries email_read/email_draft and requires a
      // connection — the shortest real path to a permission grant.
      { name: "Mail Bot", templateId: "email-assistant", connectionId: "conn-1" },
      "user-1",
      { onPermissionsConfigured }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.runtimeWarning).toEqual(expect.any(String));

    // The grants are committed and nothing rolls them back, so the callback
    // MUST already have fired, before the regen. If it hadn't, an agent would be
    // walking around with read+draft access to a mailbox and no record of who
    // gave it that.
    expect(onPermissionsConfigured).toHaveBeenCalledTimes(1);
    expect(onPermissionsConfigured).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new-agent-id" }),
      {
        connectionId: "conn-1",
        permissions: [
          { model: "email", operation: "read" },
          { model: "email", operation: "draft" },
        ],
      }
    );
    expect(calls).toEqual(["permissions", "regen"]);
  });

  it("does not fire onCreated when it fails before inserting", async () => {
    const onCreated = vi.fn();

    // Unknown template: returns { ok: false } before any insert.
    const result = await createAgent({ name: "Test", templateId: "nonexistent" }, "user-1", {
      onCreated,
    });

    expect(result.ok).toBe(false);
    expect(insertValuesMock).not.toHaveBeenCalled();
    // Nothing was created, so there is nothing to record.
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("works without any hooks (they're optional)", async () => {
    const result = await createAgent({ name: "Test Agent", templateId: "custom" }, "user-1");
    expect(result.ok).toBe(true);
  });

  it("accepts a null ownerId, for agents created by an org-owned API key", async () => {
    const result = await createAgent({ name: "Keyless", templateId: "custom" }, null);

    expect(result.ok).toBe(true);
    // Persisted as NULL rather than coalesced to some placeholder user: a key
    // acts for the organization, so there is genuinely no owner to name.
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ ownerId: null }));
  });

  it("returns { ok: true, agent } and performs the insert + regenerate on the happy path", async () => {
    const result = await createAgent({ name: "Test Agent", templateId: "custom" }, "user-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");

    expect(result.agent.id).toBe("new-agent-id");
    // Domain work executed: insert + OpenClaw regen.
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Test Agent", ownerId: "user-1" })
    );
    expect(regenerateOpenClawConfig).toHaveBeenCalled();

    // The service is audit-agnostic — it returns the data the route needs to
    // write the success audit, but never writes it itself.
    expect(appendAuditLog).not.toHaveBeenCalled();
    expect(result.audit.modelSelection).toEqual({
      source: "provider-default",
      hint: null,
      reason: "provider-default (anthropic)",
    });
    expect(result.audit.templateSkills).toEqual([]);
    expect(result.autoConfiguredPermissions).toEqual([]);
  });

  it("returns { ok: false, error: { status: 422, capabilityFailure } } without writing audit", async () => {
    mockResolveAvailableModelForTemplate.mockRejectedValueOnce(
      new TemplateCapabilityUnavailableError(
        ["vision"],
        "ollama-local",
        "https://docs.heypinchy.com/guides/ollama-setup#models-for-agent-templates"
      )
    );

    const result = await createAgent(
      {
        name: "Contract Bot",
        templateId: "knowledge-base",
        pluginConfig: { "pinchy-files": { allowed_paths: ["/data/contracts/"] } },
      },
      "user-1"
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");

    // Narrow on the discriminant, don't just assert it: `expect(...).toBe(422)`
    // proves the value at runtime but tells TypeScript nothing, so
    // `capabilityFailure` — which only exists on the 422 arm — wouldn't
    // type-check. The throw doubles as the assertion.
    if (result.error.status !== 422) throw new Error("expected a 422 capability failure");

    expect(result.error.capabilityFailure).toEqual({
      templateId: "knowledge-base",
      missingCapabilities: ["vision"],
      provider: "ollama-local",
    });
    expect(result.error.body).toMatchObject({
      error: "template_capability_unavailable",
      missingCapabilities: ["vision"],
    });
    expect((result.error.body as { docsUrl: string }).docsUrl).toContain("ollama-setup");

    // The service does NOT log the failure — the route owns audit.
    expect(appendAuditLog).not.toHaveBeenCalled();
    // No agent was inserted on the capability-failure path.
    expect(insertValuesMock).not.toHaveBeenCalled();
  });
});
