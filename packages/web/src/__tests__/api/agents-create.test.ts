import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi
    .fn()
    .mockResolvedValue({ user: { id: "1", email: "admin@test.com", role: "admin" } });
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

const { insertValuesMock, permissionsInsertValuesMock, dbInsertMock, dbSelectFromMock } =
  vi.hoisted(() => ({
    insertValuesMock: vi.fn(),
    permissionsInsertValuesMock: vi.fn().mockReturnValue(Promise.resolve()),
    dbInsertMock: vi.fn(),
    dbSelectFromMock: vi.fn(),
  }));
vi.mock("@/db", () => {
  const agentsInsertChain = {
    values: insertValuesMock.mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        {
          id: "new-agent-id",
          name: "HR Knowledge Base",
          model: "anthropic/claude-haiku-4-5-20251001",
          templateId: "knowledge-base",
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr-docs/"] } },
          ownerId: "1",
          tagline: "Answer questions from your docs",
        },
      ]),
    }),
  };
  const permissionsInsertChain = {
    values: permissionsInsertValuesMock,
  };

  const drizzleName = Symbol.for("drizzle:Name");
  dbInsertMock.mockImplementation((table: Record<symbol, string>) => {
    if (
      table &&
      typeof table === "object" &&
      drizzleName in table &&
      table[drizzleName] === "agent_connection_permissions"
    ) {
      return permissionsInsertChain;
    }
    return agentsInsertChain;
  });

  const whereMock = vi.fn().mockResolvedValue([]);
  dbSelectFromMock.mockReturnValue({ where: whereMock });

  return {
    db: {
      insert: dbInsertMock,
      select: vi.fn().mockReturnValue({
        from: dbSelectFromMock,
      }),
    },
  };
});

vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  writeWorkspaceFileInternal: vi.fn(),
  writeIdentityFile: vi.fn(),
}));

const mockGetContextForAgent = vi.fn().mockResolvedValue("");
vi.mock("@/lib/context-sync", () => ({
  getContextForAgent: (...args: unknown[]) => mockGetContextForAgent(...args),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/path-validation", () => ({
  validateAllowedPaths: vi.fn((paths: string[]) =>
    paths.map((p) => (p.endsWith("/") ? p : p + "/"))
  ),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue("anthropic"),
}));

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn().mockResolvedValue("anthropic/claude-haiku-4-5-20251001"),
  getOllamaLocalModels: vi.fn().mockReturnValue([]),
}));

const { mockResolveModelForTemplate } = vi.hoisted(() => ({
  mockResolveModelForTemplate: vi.fn().mockResolvedValue({
    model: "anthropic/claude-sonnet-4-6",
    reason: "anthropic: tier=balanced → claude-sonnet-4-6",
    fallbackUsed: false,
  }),
}));

vi.mock("@/lib/model-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/model-resolver")>();
  return {
    ...actual,
    resolveModelForTemplate: mockResolveModelForTemplate,
  };
});

vi.mock("@/lib/personality-presets", () => ({
  getPersonalityPreset: vi.fn((id: string) => {
    const presets: Record<string, { greetingMessage: string | null; soulMd: string }> = {
      "the-professor": {
        greetingMessage:
          "Hello! I'm {name}, and I'm here to help you find answers in your documents.",
        soulMd: "# Professor SOUL.md",
      },
      "the-butler": {
        greetingMessage: "Good day. I'm {name}. How may I be of assistance?",
        soulMd: "# Butler SOUL.md",
      },
      "the-pilot": {
        greetingMessage: null,
        soulMd: "# Pilot SOUL.md",
      },
      "the-coach": {
        greetingMessage: "Hey, {user}! I'm {name}. What are you working on?",
        soulMd: "# Coach SOUL.md",
      },
    };
    return presets[id];
  }),
  resolveGreetingMessage: (greeting: string | null, name: string) =>
    greeting ? greeting.replace("{name}", name) : null,
}));

vi.mock("@/lib/avatar", () => ({
  generateAvatarSeed: vi.fn().mockReturnValue("mock-seed-uuid"),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const mockValidateOdooTemplate = vi.fn();
vi.mock("@/lib/integrations/odoo-template-validation", () => ({
  validateOdooTemplate: (...args: unknown[]) => mockValidateOdooTemplate(...args),
}));

import { POST } from "@/app/api/agents/route";
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { validateAllowedPaths } from "@/lib/path-validation";
import { getDefaultModel } from "@/lib/provider-models";
import { TemplateCapabilityUnavailableError } from "@/lib/model-resolver";
import {
  ensureWorkspace,
  writeWorkspaceFile,
  writeWorkspaceFileInternal,
  writeIdentityFile,
} from "@/lib/workspace";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

describe("POST /api/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 403 for non-admin users", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "2", email: "user@test.com", role: "member" },
      expires: "",
    });

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Agent",
        templateId: "custom",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("should create an agent from a knowledge-base template", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.name).toBe("HR Knowledge Base");
    expect(body.templateId).toBe("knowledge-base");
    expect(validateAllowedPaths).toHaveBeenCalledWith(["/data/hr-docs/"]);
    expect(ensureWorkspace).toHaveBeenCalledWith("new-agent-id");
    expect(writeWorkspaceFile).toHaveBeenCalledWith("new-agent-id", "SOUL.md", expect.any(String));
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("should set ownerId to the current user's id", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "1",
      })
    );
  });

  it("should set allowedTools from template", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ["pinchy_ls", "pinchy_read"],
      })
    );
  });

  it("should reject name longer than 30 characters", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "A".repeat(31),
        templateId: "custom",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/name/i);
  });

  it("should accept name with exactly 30 characters", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "A".repeat(30),
        templateId: "custom",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
  });

  it("should reject unknown template", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Test",
        templateId: "nonexistent",
        pluginConfig: {},
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects invalid domains in pluginConfig['pinchy-web'].allowedDomains", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad Agent",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
          "pinchy-web": { allowedDomains: ["not a domain!!!"] },
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/domain/i);
  });

  it("rejects invalid domains in pluginConfig['pinchy-web'].excludedDomains", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad Agent",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
          "pinchy-web": { excludedDomains: ["@@@"] },
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/domain/i);
  });

  it("should reject knowledge-base agent without allowed_paths", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("At least one directory must be selected");
  });

  it("should create a custom agent without pluginConfig", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Dev Assistant",
        templateId: "custom",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(validateAllowedPaths).not.toHaveBeenCalled();
  });

  it("should set greetingMessage from personality preset", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        greetingMessage:
          "Hello! I'm HR Knowledge Base, and I'm here to help you find answers in your documents.",
        personalityPresetId: "the-professor",
      })
    );
  });

  it("should use template greeting when template defines defaultGreetingMessage", async () => {
    mockValidateOdooTemplate.mockReturnValue({
      valid: true,
      warnings: [],
      availableModels: [],
      missingModels: [],
    });

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Sales Bot",
        templateId: "odoo-sales-analyst",
        connectionId: "conn-1",
      }),
    });

    await POST(request);

    const insertedValues = insertValuesMock.mock.calls[0]?.[0];
    // Template greeting should win over preset greeting
    expect(insertedValues.greetingMessage).toContain("revenue");
    // Should NOT be the generic analyst greeting
    expect(insertedValues.greetingMessage).not.toBe(
      "Hi. I'm Sales Bot, your data analyst. What numbers should we look at?"
    );
  });

  it("should set avatarSeed from generateAvatarSeed", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        avatarSeed: "mock-seed-uuid",
      })
    );
  });

  it("should write SOUL.md from personality preset", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "new-agent-id",
      "SOUL.md",
      "# Professor SOUL.md"
    );
  });

  it("should use tagline from request body when provided", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Bot",
        templateId: "custom",
        tagline: "Custom tagline",
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tagline: "Custom tagline",
      })
    );
  });

  it("should call writeIdentityFile after creating agent", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(writeIdentityFile).toHaveBeenCalledWith("new-agent-id", {
      name: "HR Knowledge Base",
      tagline: "Answer questions from your docs",
    });
  });

  it("should write AGENTS.md when template has defaultAgentsMd", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "new-agent-id",
      "AGENTS.md",
      expect.stringContaining("knowledge base agent")
    );
  });

  it("should include allowed paths in AGENTS.md for knowledge-base agents", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "new-agent-id",
      "AGENTS.md",
      expect.stringContaining("/data/hr-docs/")
    );
  });

  it("should include pinchy_ls instructions in AGENTS.md for knowledge-base agents", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "new-agent-id",
      "AGENTS.md",
      expect.stringContaining("pinchy_ls")
    );
  });

  it("should not write AGENTS.md when template has null defaultAgentsMd", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Dev Assistant",
        templateId: "custom",
      }),
    });

    await POST(request);

    expect(writeWorkspaceFile).not.toHaveBeenCalledWith(
      expect.anything(),
      "AGENTS.md",
      expect.anything()
    );
  });

  it("should write org context to USER.md when creating shared agent", async () => {
    mockGetContextForAgent.mockResolvedValueOnce("We are a Vienna-based team");

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(mockGetContextForAgent).toHaveBeenCalledWith({
      isPersonal: false,
      ownerId: "1",
    });
    expect(writeWorkspaceFileInternal).toHaveBeenCalledWith(
      "new-agent-id",
      "USER.md",
      "We are a Vienna-based team"
    );
  });

  it("should write empty string to USER.md when no context exists", async () => {
    mockGetContextForAgent.mockResolvedValueOnce("");

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Dev Assistant",
        templateId: "custom",
      }),
    });

    await POST(request);

    expect(writeWorkspaceFileInternal).toHaveBeenCalledWith("new-agent-id", "USER.md", "");
  });

  it("new agent defaults to restricted visibility", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Dev Assistant",
        templateId: "custom",
      }),
    });

    await POST(request);

    // The POST handler does not explicitly set visibility, so Drizzle uses the
    // schema default ("restricted"). Verify the insert call does NOT include a
    // visibility field — the DB default takes care of it.
    const insertedValues = insertValuesMock.mock.calls[0][0];
    expect(insertedValues).not.toHaveProperty("visibility");
  });

  it("should use getDefaultModel to select model dynamically", async () => {
    vi.mocked(getDefaultModel).mockResolvedValueOnce("anthropic/claude-haiku-5-0");

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Agent",
        templateId: "custom",
      }),
    });

    await POST(request);

    expect(getDefaultModel).toHaveBeenCalledWith("anthropic");
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "anthropic/claude-haiku-5-0",
      })
    );
  });

  it("should use template defaultTagline when tagline not provided", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
        },
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tagline: "Answer questions from your docs",
      })
    );
  });

  it("creates Odoo permissions when using Odoo template with connectionId", async () => {
    // Mock connection lookup: select().from().where() returns a connection
    const connectionData = {
      models: [
        {
          model: "sale.order",
          name: "Sales Order",
          access: { read: true, create: false, write: false, delete: false },
        },
        {
          model: "sale.order.line",
          name: "Sales Order Line",
          access: { read: true, create: false, write: false, delete: false },
        },
        {
          model: "res.partner",
          name: "Contact",
          access: { read: true, create: false, write: false, delete: false },
        },
        {
          model: "product.template",
          name: "Product Template",
          access: { read: true, create: false, write: false, delete: false },
        },
        {
          model: "product.product",
          name: "Product",
          access: { read: true, create: false, write: false, delete: false },
        },
      ],
    };
    dbSelectFromMock.mockReturnValueOnce({
      where: vi
        .fn()
        .mockResolvedValue([{ id: "conn-1", name: "My Odoo", type: "odoo", data: connectionData }]),
    });

    mockValidateOdooTemplate.mockReturnValue({
      valid: true,
      warnings: [],
      availableModels: [
        { model: "sale.order", operations: ["read"] },
        { model: "sale.order.line", operations: ["read"] },
        { model: "res.partner", operations: ["read"] },
        { model: "product.template", operations: ["read"] },
        { model: "product.product", operations: ["read"] },
      ],
    });

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Sales Analyst",
        templateId: "odoo-sales-analyst",
        connectionId: "conn-1",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    // Verify permissions were inserted
    expect(permissionsInsertValuesMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "new-agent-id",
          connectionId: "conn-1",
          model: "sale.order",
          operation: "read",
        }),
        expect.objectContaining({
          agentId: "new-agent-id",
          connectionId: "conn-1",
          model: "sale.order.line",
          operation: "read",
        }),
        expect.objectContaining({
          agentId: "new-agent-id",
          connectionId: "conn-1",
          model: "res.partner",
          operation: "read",
        }),
      ])
    );

    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("should create an email-assistant agent without pluginConfig (no directory required)", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Hermes",
        templateId: "email-assistant",
        connectionId: "email-conn-1",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(validateAllowedPaths).not.toHaveBeenCalled();
  });

  it("returns 400 when email template used without connectionId", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Hermes",
        templateId: "email-assistant",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/connection/i);
  });

  it("auto-configures email permissions when creating email agent with connectionId", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Hermes",
        templateId: "email-assistant",
        connectionId: "email-conn-1",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    // Email templates use semantic operations (read, draft, send) — not per-tool
    // operations (list, search, etc.). The plugin checks these semantic ops.
    expect(permissionsInsertValuesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        agentId: "new-agent-id",
        connectionId: "email-conn-1",
        model: "email",
        operation: "read",
      }),
      expect.objectContaining({
        agentId: "new-agent-id",
        connectionId: "email-conn-1",
        model: "email",
        operation: "draft",
      }),
    ]);
  });

  it("returns 400 when Odoo template used without connectionId", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Sales Analyst",
        templateId: "odoo-sales-analyst",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/connection/i);
  });

  it("does not create Odoo permissions for non-Odoo templates", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Dev Assistant",
        templateId: "custom",
      }),
    });

    await POST(request);

    expect(permissionsInsertValuesMock).not.toHaveBeenCalled();
  });

  it("should save pinchy-web config alongside pinchy-files for knowledge-base template", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Research Agent",
        templateId: "knowledge-base",
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/research/"] },
          "pinchy-web": { allowedDomains: ["arxiv.org"], language: "en" },
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginConfig: {
          "pinchy-files": { allowed_paths: ["/data/research/"] },
          "pinchy-web": { allowedDomains: ["arxiv.org"], language: "en" },
        },
      })
    );
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("should not save pluginConfig for custom template even with pinchy-web config", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Dev Assistant",
        templateId: "custom",
        pluginConfig: {
          "pinchy-web": { allowedDomains: ["github.com"] },
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    // Custom template has pluginId: null, so pluginConfig is set to null
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginConfig: null,
      })
    );
  });

  it("uses resolver when template has modelHint", async () => {
    mockResolveModelForTemplate.mockResolvedValueOnce({
      model: "anthropic/claude-opus-4-7",
      reason: "anthropic: tier=reasoning → claude-opus-4-7",
      fallbackUsed: false,
    });

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Finance Controller",
        templateId: "odoo-finance-controller",
        connectionId: "conn-1",
      }),
    });

    mockValidateOdooTemplate.mockReturnValue({
      valid: true,
      warnings: [],
      availableModels: [],
      missingModels: [],
    });
    dbSelectFromMock.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue([{ id: "conn-1", name: "Odoo", type: "odoo", data: {} }]),
    });

    await POST(request);

    expect(mockResolveModelForTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.objectContaining({ tier: "reasoning" }) })
    );
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/claude-opus-4-7" })
    );
  });

  it("falls back to getDefaultModel for custom template (no modelHint)", async () => {
    vi.mocked(getDefaultModel).mockResolvedValueOnce("anthropic/claude-haiku-4-5-20251001");

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "My Agent", templateId: "custom" }),
    });

    await POST(request);

    expect(mockResolveModelForTemplate).not.toHaveBeenCalled();
    expect(getDefaultModel).toHaveBeenCalledWith("anthropic");
  });

  it("returns 400 with template_capability_unavailable when resolver throws", async () => {
    mockResolveModelForTemplate.mockRejectedValueOnce(
      new TemplateCapabilityUnavailableError(
        ["vision"],
        "ollama-local",
        "https://docs.heypinchy.com/guides/ollama-setup#models-for-agent-templates"
      )
    );

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Contract Bot",
        templateId: "contract-analyzer",
        pluginConfig: { "pinchy-files": { allowed_paths: ["/data/contracts/"] } },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("template_capability_unavailable");
    expect(body.missingCapabilities).toContain("vision");
    expect(body.docsUrl).toContain("ollama-setup");
  });

  it("audit log includes modelSelection source and reason", async () => {
    const { appendAuditLog } = await import("@/lib/audit");
    const spy = vi.mocked(appendAuditLog);

    mockResolveModelForTemplate.mockResolvedValueOnce({
      model: "anthropic/claude-sonnet-4-6",
      reason: "anthropic: tier=balanced → claude-sonnet-4-6",
      fallbackUsed: false,
    });

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "KB Agent",
        templateId: "knowledge-base",
        pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs/"] } },
      }),
    });

    await POST(request);

    // after() defers the audit log — find the call
    const call = spy.mock.calls.find(
      ([arg]) => (arg as { eventType: string }).eventType === "agent.created"
    );
    expect(call).toBeDefined();
    const detail = (call![0] as { detail: Record<string, unknown> }).detail;
    expect(detail.modelSelection).toMatchObject({
      source: "template-hint",
      hint: expect.objectContaining({ tier: "balanced" }),
      reason: expect.stringContaining("balanced"),
    });
  });
});
