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
  },
}));

import { GET } from "@/app/api/templates/route";
import { auth } from "@/lib/auth";

describe("GET /api/templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no Odoo connections
    mockLimit.mockResolvedValue([]);
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

  it("excludes odoo templates when no odoo connection exists", async () => {
    mockLimit.mockResolvedValue([]);

    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);
    const body = await response.json();

    const odooTemplates = body.templates.filter(
      (t: { requiresOdooConnection: boolean }) => t.requiresOdooConnection
    );
    expect(odooTemplates).toHaveLength(0);
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
