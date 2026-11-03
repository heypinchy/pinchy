import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mockSession } from "@/test-helpers/auth";
import { routeContext } from "@/test-helpers/route";

// These tests run against REAL HTTP servers on 127.0.0.1 and the REAL
// odoo-node client (no fetch mock): what is under test is what goes over the
// wire — whether a second request reaches the redirect target, and whether a
// body the admin never asked for comes back in the error message.

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

// The "public" Odoo URL in these tests is 127.0.0.1, which the real guard
// rightly refuses. The guard is not what is under test here — what happens
// AFTER it said yes is — so it waves the entry URL through.
vi.mock("@/lib/integrations/url-validation", () => ({
  validateExternalUrl: async (url: string) => ({ valid: true, url: new URL(url).origin }),
}));

/** A body the admin must never see echoed back: what an internal host answers. */
const SECRET = "SECRET-METADATA-TOKEN";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function listen(handler: Handler): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

// "Internal" target: stands in for 169.254.169.254 / an RFC-1918 host. It
// counts every request that reaches it — the assertion that matters is zero.
let internalHits = 0;
let internal: { server: Server; origin: string };
// "Public" Odoo that answers every request with a redirect to the internal host.
let redirecting: { server: Server; origin: string };
let redirectStatus = 307;
// "Public" Odoo that answers with HTML instead of JSON-RPC.
let htmlServer: { server: Server; origin: string };

beforeAll(async () => {
  internal = await listen((_req, res) => {
    internalHits++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${SECRET} {"result": ["leaked-db"]}`);
  });
  redirecting = await listen((_req, res) => {
    res.writeHead(redirectStatus, {
      location: `${internal.origin}/latest/meta-data/`,
      "content-type": "text/html",
    });
    res.end(`<html>${SECRET}</html>`);
  });
  htmlServer = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html>${SECRET}</html>`);
  });
});

afterAll(() => {
  internal.server.close();
  redirecting.server.close();
  htmlServer.server.close();
});

beforeEach(() => {
  internalHits = 0;
  redirectStatus = 307;
  mockGetSession.mockResolvedValue(mockSession());
});

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost:7777${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/integrations/list-databases against a redirecting Odoo", () => {
  it.each([302, 307])(
    "refuses a %i to an internal host without making a second request",
    async (status) => {
      redirectStatus = status;
      const { POST } = await import("@/app/api/integrations/list-databases/route");

      const response = await POST(
        post("/api/integrations/list-databases", { url: redirecting.origin }),
        routeContext()
      );
      const body = await response.json();

      expect(internalHits).toBe(0);
      expect(body.success).toBe(false);
      expect(body.databases).toBeUndefined();
      expect(body.error).toContain(`HTTP ${status}`);
      expect(body.error).toMatch(/redirect/i);
      expect(JSON.stringify(body)).not.toContain(SECRET);
    }
  );

  it("names status and content type, never the body, for a non-JSON answer", async () => {
    const { POST } = await import("@/app/api/integrations/list-databases/route");

    const response = await POST(
      post("/api/integrations/list-databases", { url: htmlServer.origin }),
      routeContext()
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.error).toContain("HTTP 200");
    expect(body.error).toContain("text/html");
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain("<html");
  });
});

// authenticate sends the API key in the POST body, and a 307/308 re-sends it
// to wherever the Location header points.
describe("POST /api/integrations/test-credentials against a redirecting Odoo", () => {
  it.each([302, 307, 308])(
    "refuses a %i to an internal host without making a second request",
    async (status) => {
      redirectStatus = status;
      const { POST } = await import("@/app/api/integrations/test-credentials/route");

      const response = await POST(
        post("/api/integrations/test-credentials", {
          type: "odoo",
          credentials: { url: redirecting.origin, db: "prod", login: "admin", apiKey: "key" },
        }),
        routeContext()
      );
      const body = await response.json();

      expect(internalHits).toBe(0);
      expect(body.success).toBe(false);
      expect(body.error).toContain(`HTTP ${status}`);
      expect(body.error).toMatch(/redirect/i);
      expect(JSON.stringify(body)).not.toContain(SECRET);
    }
  );
});

describe("probeIntegrationCredentials (odoo) against a redirecting Odoo", () => {
  it.each([302, 307, 308])(
    "refuses a %i without a second request and without blaming the credentials",
    async (status) => {
      redirectStatus = status;
      const { probeIntegrationCredentials } = await import("@/lib/integrations/probe");

      const result = await probeIntegrationCredentials("odoo", {
        url: redirecting.origin,
        db: "prod",
        login: "admin",
        apiKey: "key",
        uid: 2,
      });

      expect(internalHits).toBe(0);
      if (result.success) throw new Error("expected failure");
      expect(result.reason).toContain(`HTTP ${status}`);
      expect(result.reason).not.toMatch(/authentication failed/i);
      expect(result.transient).toBe(true);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  );
});

describe("POST /api/integrations/test-credentials against a non-JSON-RPC answer", () => {
  it("does not echo the response body into the error", async () => {
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      post("/api/integrations/test-credentials", {
        type: "odoo",
        credentials: { url: htmlServer.origin, db: "prod", login: "admin", apiKey: "key" },
      }),
      routeContext()
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not a JSON-RPC response/i);
    // Node's JSON parser quotes the first characters of what it choked on —
    // `Unexpected token '<', "<html>SECR"...` — which is the leak.
    expect(JSON.stringify(body)).not.toContain("SECR");
    expect(JSON.stringify(body)).not.toContain("<html");
  });
});

describe("probeIntegrationCredentials (odoo) against a non-JSON-RPC answer", () => {
  it("does not echo the response body into the failure reason", async () => {
    const { probeIntegrationCredentials } = await import("@/lib/integrations/probe");

    const result = await probeIntegrationCredentials("odoo", {
      url: htmlServer.origin,
      db: "prod",
      login: "admin",
      apiKey: "key",
      uid: 2,
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/not a JSON-RPC response/i);
    expect(JSON.stringify(result)).not.toContain("SECR");
    expect(JSON.stringify(result)).not.toContain("<html");
  });
});
