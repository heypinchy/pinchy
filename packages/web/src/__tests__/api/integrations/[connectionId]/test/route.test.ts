import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted::/, "")),
  encrypt: vi.fn((plaintext: string) => `encrypted::${plaintext}`),
}));

vi.mock("@/lib/integrations/pipedrive-api", () => ({
  getPipedriveBaseUrl: vi.fn().mockReturnValue("https://api.pipedrive.com"),
}));

const { mockAuthenticate, mockVersion } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockVersion: vi.fn(),
}));

vi.mock("odoo-node", () => {
  class OdooClient {
    version = mockVersion;
    static authenticate = mockAuthenticate;
  }
  return { OdooClient };
});

const { mockSelectWhere, mockSelect, mockUpdate } = vi.hoisted(() => {
  const mockSelectWhere = vi.fn();
  const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  return { mockSelectWhere, mockSelect, mockUpdate };
});

vi.mock("@/db", () => ({
  db: { select: mockSelect, update: mockUpdate },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

import { getSession } from "@/lib/auth";
import { POST } from "@/app/api/integrations/[connectionId]/test/route";

const adminSession = {
  user: { id: "admin-1", role: "admin" },
  expires: "",
} as const;

const makeParams = (connectionId: string) => ({
  params: Promise.resolve({ connectionId }),
});

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/integrations/conn-pd/test", { method: "POST" });
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
};

describe("POST /api/integrations/[connectionId]/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("tests Pipedrive connection and returns company info", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([pipedriveConnection]);
    const fetchMock = vi.fn().mockResolvedValueOnce({
      json: async () => ({
        success: true,
        data: { company_domain: "acme", company_name: "Acme Corp" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(makeRequest(), makeParams("conn-pd"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      companyDomain: "acme",
      companyName: "Acme Corp",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.pipedrive.com/v1/users/me");
    expect(init.headers["x-api-token"]).toBe("token-123");
    // Token MUST NOT appear in URL (query-string leak)
    expect(String(url)).not.toContain("token-123");
  });

  it("returns success:false when Pipedrive rejects token", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockSelectWhere.mockResolvedValueOnce([pipedriveConnection]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        json: async () => ({ success: false, error: "Invalid API key" }),
      })
    );

    const response = await POST(makeRequest(), makeParams("conn-pd"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: false, error: "Invalid API key" });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
