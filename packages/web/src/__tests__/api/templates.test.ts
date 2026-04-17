import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn().mockResolvedValue({ user: { id: "1", email: "admin@test.com" } });
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

const { mockLimit } = vi.hoisted(() => {
  const mockLimit = vi.fn();
  return { mockLimit };
});

vi.mock("@/db", () => {
  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  return {
    db: { select: mockSelect },
  };
});

vi.mock("@/db/schema", () => ({
  integrationConnections: {
    type: "type",
    id: "id",
    data: "data",
  },
}));

const mockGetConnectionModels = vi.fn();
vi.mock("@/lib/integrations/odoo-connection-models", () => ({
  getConnectionModels: (...args: unknown[]) => mockGetConnectionModels(...args),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue("anthropic"),
}));

vi.mock("@/lib/provider-models", () => ({
  getOllamaLocalModels: vi.fn().mockReturnValue([]),
}));

const { mockResolveModelForTemplate: mockResolveTemplate } = vi.hoisted(() => ({
  mockResolveModelForTemplate: vi.fn().mockResolvedValue({
    model: "anthropic/claude-sonnet-4-6",
    reason: "test",
    fallbackUsed: false,
  }),
}));

vi.mock("@/lib/model-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/model-resolver")>();
  return {
    ...actual,
    resolveModelForTemplate: mockResolveTemplate,
  };
});

import { GET } from "@/app/api/templates/route";
import { auth } from "@/lib/auth";
import { TemplateCapabilityUnavailableError } from "@/lib/model-resolver";

describe("GET /api/templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no Odoo connections
    mockLimit.mockResolvedValue([]);
    mockGetConnectionModels.mockResolvedValue(null);
  });

  it("should return available templates", async () => {
    // With Odoo connection present, all templates are returned
    mockLimit.mockResolvedValue([{ id: "conn-1" }]);

    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);
    const body = await response.json();

    expect(body.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "knowledge-base",
          name: "Knowledge Base",
          description: "Answer questions from your docs",
          requiresDirectories: true,
          requiresOdooConnection: false,
          defaultTagline: "Answer questions from your docs",
        }),
        expect.objectContaining({
          id: "custom",
          name: "Custom Agent",
          description: "Start from scratch",
          requiresDirectories: false,
          requiresOdooConnection: false,
          defaultTagline: null,
        }),
      ])
    );
  });

  it("should return 401 without auth", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("includes odoo templates when odoo connection exists", async () => {
    mockLimit.mockResolvedValue([{ id: "conn-1" }]);

    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);
    const body = await response.json();

    const odooTemplates = body.templates.filter(
      (t: { requiresOdooConnection: boolean }) => t.requiresOdooConnection
    );
    expect(odooTemplates.length).toBeGreaterThan(0);

    const salesAnalyst = body.templates.find((t: { id: string }) => t.id === "odoo-sales-analyst");
    expect(salesAnalyst).toMatchObject({
      id: "odoo-sales-analyst",
      name: "Sales Analyst",
      requiresOdooConnection: true,
      odooAccessLevel: "read-only",
    });
  });

  it("includes odoo templates when no odoo connection exists, marked unavailable with reason", async () => {
    mockLimit.mockResolvedValue([]);

    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);
    const body = await response.json();

    const odooTemplates = body.templates.filter(
      (t: { requiresOdooConnection: boolean }) => t.requiresOdooConnection
    );
    expect(odooTemplates.length).toBeGreaterThan(0);
    for (const t of odooTemplates) {
      expect(t.available).toBe(false);
      expect(t.unavailableReason).toBe("no-connection");
    }
  });

  it("marks odoo templates as available when all required models exist", async () => {
    mockLimit.mockResolvedValue([{ id: "conn-1" }]);
    mockGetConnectionModels.mockResolvedValue([
      {
        model: "sale.order",
        name: "Sales Order",
        access: { read: true, create: true, write: true, delete: false },
      },
      {
        model: "sale.order.line",
        name: "Sales Order Line",
        access: { read: true, create: false, write: false, delete: false },
      },
      {
        model: "res.partner",
        name: "Contact",
        access: { read: true, create: true, write: true, delete: false },
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
    ]);

    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);
    const body = await response.json();

    const salesAnalyst = body.templates.find((t: { id: string }) => t.id === "odoo-sales-analyst");
    expect(salesAnalyst.available).toBe(true);
    expect(salesAnalyst.unavailableReason).toBeNull();
  });

  it("marks odoo templates as unavailable when required models are missing", async () => {
    mockLimit.mockResolvedValue([{ id: "conn-1" }]);
    // Only provide res.partner — sale.order etc. are missing
    mockGetConnectionModels.mockResolvedValue([
      {
        model: "res.partner",
        name: "Contact",
        access: { read: true, create: true, write: true, delete: false },
      },
    ]);

    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);
    const body = await response.json();

    const salesAnalyst = body.templates.find((t: { id: string }) => t.id === "odoo-sales-analyst");
    expect(salesAnalyst.available).toBe(false);
    expect(salesAnalyst.unavailableReason).toBe("missing-modules");
  });

  it("marks non-odoo templates as always available", async () => {
    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);
    const body = await response.json();

    const kb = body.templates.find((t: { id: string }) => t.id === "knowledge-base");
    expect(kb.available).toBe(true);
    expect(kb.unavailableReason).toBeNull();

    const custom = body.templates.find((t: { id: string }) => t.id === "custom");
    expect(custom.available).toBe(true);
    expect(custom.unavailableReason).toBeNull();
  });

  it("marks template as disabled when resolver throws TemplateCapabilityUnavailableError", async () => {
    mockResolveTemplate.mockImplementation(({ hint }: { hint: { capabilities?: string[] } }) => {
      if (hint.capabilities?.includes("vision")) {
        throw new TemplateCapabilityUnavailableError(
          ["vision"],
          "ollama-local",
          "https://docs.heypinchy.com/guides/ollama-setup#models-for-agent-templates"
        );
      }
      return Promise.resolve({ model: "x", reason: "test", fallbackUsed: false });
    });

    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);
    const body = await response.json();

    const contract = body.templates.find((t: { id: string }) => t.id === "contract-analyzer");
    expect(contract.disabled).toBe(true);
    expect(contract.disabledReason).toContain("vision");

    // Non-vision templates should not be disabled
    const kb = body.templates.find((t: { id: string }) => t.id === "knowledge-base");
    expect(kb.disabled).toBe(false);
  });

  it("always includes non-odoo templates", async () => {
    // Without Odoo connection
    mockLimit.mockResolvedValue([]);

    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);
    const body = await response.json();

    const ids = body.templates.map((t: { id: string }) => t.id);
    expect(ids).toContain("knowledge-base");
    expect(ids).toContain("custom");

    // With Odoo connection
    mockLimit.mockResolvedValue([{ id: "conn-1" }]);

    const response2 = await GET(new NextRequest("http://localhost:7777/api/templates"));
    const body2 = await response2.json();

    const ids2 = body2.templates.map((t: { id: string }) => t.id);
    expect(ids2).toContain("knowledge-base");
    expect(ids2).toContain("custom");
  });
});
