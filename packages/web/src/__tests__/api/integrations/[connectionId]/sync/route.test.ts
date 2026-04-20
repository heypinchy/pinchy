import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted::/, "")),
}));

vi.mock("@/lib/integrations/odoo-sync", () => ({
  fetchOdooSchema: vi.fn(),
}));

vi.mock("@/lib/integrations/pipedrive-sync", () => ({
  fetchPipedriveSchema: vi.fn(),
}));

const { mockSelectWhere, mockSelect, mockUpdate, mockUpdateWhere } = vi.hoisted(() => {
  const mockSelectWhere = vi.fn();
  const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  return { mockSelectWhere, mockSelect, mockUpdate, mockUpdateWhere };
});

vi.mock("@/db", () => ({
  db: { select: mockSelect, update: mockUpdate },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

import { getSession } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { fetchPipedriveSchema } from "@/lib/integrations/pipedrive-sync";
import { POST } from "@/app/api/integrations/[connectionId]/sync/route";

const adminSession = {
  user: { id: "admin-1", role: "admin" },
  expires: "",
} as const;

const makeParams = (connectionId: string) => ({
  params: Promise.resolve({ connectionId }),
});

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/integrations/conn-pd/sync", { method: "POST" });
}

const pipedriveConnection = {
  id: "conn-pd",
  type: "pipedrive",
  name: "Acme Pipedrive",
  credentials: `encrypted::${JSON.stringify({
    apiToken: "token-123",
    companyDomain: "acme",
    companyName: "Acme Corp",
    userId: 7,
    userName: "Alice",
  })}`,
  data: null,
};

describe("POST /api/integrations/[connectionId]/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateWhere.mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const response = await POST(makeRequest(), makeParams("conn-pd"));
    expect(response.status).toBe(401);
  });

  it("returns 404 when connection missing", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([]);
    const response = await POST(makeRequest(), makeParams("missing"));
    expect(response.status).toBe(404);
  });

  it("syncs Pipedrive schema, persists data, and writes audit log", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([pipedriveConnection]);
    vi.mocked(fetchPipedriveSchema).mockResolvedValueOnce({
      success: true,
      entities: 5,
      data: { entities: [{ id: "deal", name: "Deal" }] },
      lastSyncAt: "2026-04-20T00:00:00Z",
    } as never);

    const response = await POST(makeRequest(), makeParams("conn-pd"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      entities: 5,
      lastSyncAt: "2026-04-20T00:00:00Z",
    });

    expect(fetchPipedriveSchema).toHaveBeenCalledWith("token-123");
    expect(mockUpdate).toHaveBeenCalled();
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        resource: "integration:conn-pd",
        detail: expect.objectContaining({
          action: "integration_schema_synced",
          id: "conn-pd",
          name: "Acme Pipedrive",
          entityCount: 5,
        }),
        outcome: "success",
      })
    );
  });

  it("does not persist or audit when Pipedrive schema fetch fails", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([pipedriveConnection]);
    vi.mocked(fetchPipedriveSchema).mockResolvedValueOnce({
      success: false,
      error: "API token invalid",
    } as never);

    const response = await POST(makeRequest(), makeParams("conn-pd"));
    const body = await response.json();
    expect(body).toEqual({ success: false, error: "API token invalid" });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});
