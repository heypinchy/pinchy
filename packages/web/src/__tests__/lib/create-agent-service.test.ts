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

const { mockResolveModelForTemplate } = vi.hoisted(() => ({
  mockResolveModelForTemplate: vi.fn(),
}));
vi.mock("@/lib/model-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/model-resolver")>();
  return { ...actual, resolveModelForTemplate: mockResolveModelForTemplate };
});

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
    mockResolveModelForTemplate.mockRejectedValueOnce(
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

    expect(result.error.status).toBe(422);
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
