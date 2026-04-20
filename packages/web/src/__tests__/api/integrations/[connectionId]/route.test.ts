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
  encrypt: vi.fn((plaintext: string) => `encrypted::${plaintext}`),
  decrypt: vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted::/, "")),
}));

vi.mock("@/lib/integrations/oauth-settings", () => ({
  deleteOAuthSettings: vi.fn().mockResolvedValue(undefined),
}));

// DB chain mocks: select().from().where(), update().set().where().returning(), delete().where()
const { mockSelectWhere, mockSelect, mockUpdate, mockUpdateReturning, mockDelete } = vi.hoisted(
  () => {
    const mockSelectWhere = vi.fn();
    const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

    const mockUpdateReturning = vi.fn();
    const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
    const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

    const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
    const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

    return { mockSelectWhere, mockSelect, mockUpdate, mockUpdateReturning, mockDelete };
  }
);

vi.mock("@/db", () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id", type: "type" },
}));

import { getSession } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { GET, PATCH, DELETE } from "@/app/api/integrations/[connectionId]/route";

const adminSession = {
  user: { id: "admin-1", role: "admin" },
  expires: "",
} as const;

const makeParams = (connectionId: string) => ({
  params: Promise.resolve({ connectionId }),
});

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/integrations/conn-1", {
    method: "PATCH",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const now = new Date();
const pipedriveConnection = {
  id: "conn-pd",
  type: "pipedrive",
  name: "Acme Pipedrive",
  description: "",
  status: "active",
  credentials: `encrypted::${JSON.stringify({
    apiToken: "token-123",
    companyDomain: "acme",
    companyName: "Acme Corp",
    userId: 7,
    userName: "Alice",
  })}`,
  data: null,
  createdAt: now,
  updatedAt: now,
};

describe("GET /api/integrations/[connectionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const response = await GET(makeRequest(), makeParams("conn-pd"));
    expect(response.status).toBe(401);
  });

  it("returns 404 when connection missing", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([]);
    const response = await GET(makeRequest(), makeParams("missing"));
    expect(response.status).toBe(404);
  });

  it("returns masked Pipedrive credentials", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([pipedriveConnection]);
    const response = await GET(makeRequest(), makeParams("conn-pd"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.credentials).toEqual({
      companyDomain: "acme",
      companyName: "Acme Corp",
      userName: "Alice",
    });
    expect(body.credentials.apiToken).toBeUndefined();
  });
});

describe("PATCH /api/integrations/[connectionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates Pipedrive name and writes audit log", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([pipedriveConnection]);
    mockUpdateReturning.mockResolvedValueOnce([{ ...pipedriveConnection, name: "Acme v2" }]);

    const response = await PATCH(makeRequest({ name: "Acme v2" }), makeParams("conn-pd"));
    expect(response.status).toBe(200);

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        resource: "integration:conn-pd",
        detail: expect.objectContaining({
          action: "integration_updated",
          id: "conn-pd",
          changes: expect.objectContaining({
            name: { from: "Acme Pipedrive", to: "Acme v2" },
          }),
        }),
        outcome: "success",
      })
    );
  });

  it("rejects Odoo-shaped credentials on a Pipedrive connection", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([pipedriveConnection]);

    const response = await PATCH(
      makeRequest({
        credentials: {
          url: "https://odoo.example.com",
          db: "prod",
          login: "admin",
          apiKey: "k",
          uid: 1,
        },
      }),
      makeParams("conn-pd")
    );
    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips audit log when nothing changes", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([pipedriveConnection]);
    mockUpdateReturning.mockResolvedValueOnce([pipedriveConnection]);

    const response = await PATCH(makeRequest({ name: "Acme Pipedrive" }), makeParams("conn-pd"));
    expect(response.status).toBe(200);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/integrations/[connectionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes and logs with type + name snapshot", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([pipedriveConnection]);

    const response = await DELETE(makeRequest(), makeParams("conn-pd"));
    expect(response.status).toBe(200);
    expect(mockDelete).toHaveBeenCalled();

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        resource: "integration:conn-pd",
        detail: expect.objectContaining({
          action: "integration_deleted",
          type: "pipedrive",
          name: "Acme Pipedrive",
        }),
        outcome: "success",
      })
    );
  });

  it("returns 404 when missing and does not audit", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([]);
    const response = await DELETE(makeRequest(), makeParams("missing"));
    expect(response.status).toBe(404);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});
