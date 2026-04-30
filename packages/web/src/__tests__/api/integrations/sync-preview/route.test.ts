import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/integrations/odoo-sync", () => ({
  fetchOdooSchema: vi.fn(),
}));

vi.mock("@/lib/integrations/pipedrive-sync", () => ({
  fetchPipedriveSchema: vi.fn(),
}));

import { getSession } from "@/lib/auth";
import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { fetchPipedriveSchema } from "@/lib/integrations/pipedrive-sync";
import { POST } from "@/app/api/integrations/sync-preview/route";

const adminSession = {
  user: { id: "admin-1", role: "admin" },
  expires: "",
} as const;

const memberSession = {
  user: { id: "user-1", role: "member" },
  expires: "",
} as const;

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/integrations/sync-preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/integrations/sync-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const response = await POST(makeRequest({ type: "pipedrive", credentials: { apiToken: "t" } }));
    expect(response.status).toBe(401);
  });

  it("returns 403 when not admin", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(memberSession as never);
    const response = await POST(makeRequest({ type: "pipedrive", credentials: { apiToken: "t" } }));
    expect(response.status).toBe(403);
  });

  it("returns 400 on validation failure", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    const response = await POST(makeRequest({ type: "pipedrive", credentials: {} }));
    expect(response.status).toBe(400);
  });

  it("delegates Pipedrive previews to fetchPipedriveSchema", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    vi.mocked(fetchPipedriveSchema).mockResolvedValueOnce({
      entities: [{ id: "deal", name: "Deal" }],
    } as never);

    const response = await POST(
      makeRequest({ type: "pipedrive", credentials: { apiToken: "token-123" } })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ entities: [{ id: "deal", name: "Deal" }] });
    expect(fetchPipedriveSchema).toHaveBeenCalledWith("token-123");
    expect(fetchOdooSchema).not.toHaveBeenCalled();
  });

  it("rejects Odoo previews with private/localhost URLs", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    const response = await POST(
      makeRequest({
        type: "odoo",
        credentials: {
          url: "http://localhost:8069",
          db: "prod",
          login: "admin",
          apiKey: "key",
          uid: 1,
        },
      })
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/private|localhost|external/i);
    expect(fetchOdooSchema).not.toHaveBeenCalled();
  });

  it("delegates Odoo previews to fetchOdooSchema when URL is valid", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    vi.mocked(fetchOdooSchema).mockResolvedValueOnce({
      models: [{ model: "res.partner", name: "Contact" }],
    } as never);

    const creds = {
      url: "https://odoo.example.com",
      db: "prod",
      login: "admin",
      apiKey: "key",
      uid: 1,
    };
    const response = await POST(makeRequest({ type: "odoo", credentials: creds }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ models: [{ model: "res.partner", name: "Contact" }] });
    expect(fetchOdooSchema).toHaveBeenCalledWith(creds);
    expect(fetchPipedriveSchema).not.toHaveBeenCalled();
  });
});
