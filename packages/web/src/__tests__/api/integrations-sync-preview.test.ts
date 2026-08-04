import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockValidateExternalUrl = vi.fn();
vi.mock("@/lib/integrations/url-validation", () => ({
  validateExternalUrl: (...args: unknown[]) => mockValidateExternalUrl(...args),
}));

const mockFetchOdooSchema = vi.fn();
vi.mock("@/lib/integrations/odoo-sync", () => ({
  fetchOdooSchema: (...args: unknown[]) => mockFetchOdooSchema(...args),
}));

import { mockSession } from "@/test-helpers/auth";
import { makeNextRequest, routeContext } from "@/test-helpers/route";

const ROUTE_URL = "http://localhost:7777/api/integrations/sync-preview";

function postSyncPreview(body: unknown) {
  return makeNextRequest(ROUTE_URL, { method: "POST", body: JSON.stringify(body) });
}

const adminSession = mockSession();
const memberSession = mockSession({
  user: { id: "user-2", email: "member@test.com", name: "Test Member", role: "member" },
});

// The url deliberately carries a path. `validateExternalUrl` answers with a
// NORMALIZED origin (scheme + host + port, no path), so a fixture whose input
// already IS its own origin makes "the route fetched what it validated"
// indistinguishable from "the route fetched something else" — both assertions
// would compare the same string. With a path the two differ, and the happy-path
// test below can tell them apart.
const validCredentials = {
  url: "https://odoo.example.com/erp",
  db: "prod",
  login: "admin",
  apiKey: "secret-key",
  uid: 2,
};
const validatedOrigin = "https://odoo.example.com";

const validSyncResult = {
  success: true,
  models: 2,
  lastSyncAt: "2026-01-01T00:00:00.000Z",
  categories: [{ category: "sales", count: 1 }],
  data: {
    models: [
      {
        model: "sale.order",
        name: "Sales Order",
        fields: [],
        access: { read: true, create: false, write: false, delete: false },
      },
    ],
    lastSyncAt: "2026-01-01T00:00:00.000Z",
  },
};

describe("POST /api/integrations/sync-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockValidateExternalUrl.mockReturnValue({ valid: true, url: validatedOrigin });
    mockFetchOdooSchema.mockResolvedValue(validSyncResult);
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const response = await POST(
      postSyncPreview({ type: "odoo", credentials: validCredentials }),
      routeContext()
    );

    expect(response.status).toBe(401);
    // The credentials must not leave the process before the caller is known.
    expect(mockValidateExternalUrl).not.toHaveBeenCalled();
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("should return 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const response = await POST(
      postSyncPreview({ type: "odoo", credentials: validCredentials }),
      routeContext()
    );

    expect(response.status).toBe(403);
    expect(mockValidateExternalUrl).not.toHaveBeenCalled();
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("should return 400 when required credential fields are missing", async () => {
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const response = await POST(
      postSyncPreview({ type: "odoo", credentials: { url: validCredentials.url } }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    // Assert WHICH check refused. `parseRequestBody` answers 400 for a failed
    // schema AND for an unparseable body, so a bare status assertion passes
    // even when the route rejected for a reason the test never intended.
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.credentials).toBeDefined();
    expect(mockValidateExternalUrl).not.toHaveBeenCalled();
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("should return 400 for an invalid url", async () => {
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const response = await POST(
      postSyncPreview({
        type: "odoo",
        credentials: { ...validCredentials, url: "not-a-url" },
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Validation failed");
    // Every other credential field is valid, so the url is the only thing that
    // can have failed — name it, otherwise this passes on any credential error.
    expect(body.details.fieldErrors.credentials).toContain("Invalid URL");
    expect(mockValidateExternalUrl).not.toHaveBeenCalled();
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("should return 400 for a non-odoo type", async () => {
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    // The credentials are deliberately VALID: with an invalid `credentials`
    // block alongside, this test goes green even if `type` stops being a
    // literal, and then pins nothing about the only value the route handles.
    const response = await POST(
      postSyncPreview({ type: "web-search", credentials: validCredentials }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.type).toBeDefined();
    expect(body.details.fieldErrors.credentials).toBeUndefined();
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("rejects the request when validateExternalUrl refuses the target and never calls fetchOdooSchema", async () => {
    // Pins the SSRF ordering: validation must run BEFORE the outbound fetch,
    // and a rejection must short-circuit the route entirely.
    mockValidateExternalUrl.mockReturnValue({
      valid: false,
      error: "URLs targeting private or internal networks are not allowed",
    });
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const response = await POST(
      postSyncPreview({
        type: "odoo",
        credentials: { ...validCredentials, url: "http://169.254.169.254/" },
      }),
      routeContext()
    );
    const body = await response.json();

    expect(mockValidateExternalUrl).toHaveBeenCalledWith("http://169.254.169.254/");
    expect(response.status).toBe(400);
    expect(body.error).toBe("URLs targeting private or internal networks are not allowed");
    expect(mockFetchOdooSchema).not.toHaveBeenCalled();
  });

  it("returns the schema from fetchOdooSchema when the url passes SSRF validation", async () => {
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const response = await POST(
      postSyncPreview({ type: "odoo", credentials: validCredentials }),
      routeContext()
    );
    const body = await response.json();

    expect(mockValidateExternalUrl).toHaveBeenCalledWith(validCredentials.url);
    expect(mockFetchOdooSchema).toHaveBeenCalledWith(validCredentials);
    expect(response.status).toBe(200);
    expect(body).toEqual(validSyncResult);

    // The invariant SSRF actually rests on: the string that was checked is the
    // string that gets fetched. Asserted as an identity between the two calls
    // rather than against a literal, so a route that swapped in the normalized
    // origin (or any other rewrite) between check and fetch fails here.
    const [validatedUrl] = mockValidateExternalUrl.mock.calls[0] as [string];
    const [forwarded] = mockFetchOdooSchema.mock.calls[0] as [typeof validCredentials];
    expect(forwarded.url).toBe(validatedUrl);
  });
});
