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
// AFTER it said yes is — so it waves the entry URL through. A route that pins
// its request gets the listener's own address as the checked answer, so the
// real `pinnedFetch` connects to it.
vi.mock("@/lib/integrations/url-validation", () => ({
  validateExternalUrl: async (url: string) => ({ valid: true, url: new URL(url).origin }),
  resolveExternalUrlTarget: async (url: string) => ({
    valid: true,
    url: new URL(url).origin,
    target: { address: new URL(url).hostname, family: 4 },
  }),
}));

// The schema-sync route reads a stored connection. Only storage and the
// auth-state writes are stubbed; the sync itself runs the real odoo-node.
let storedCredentials: Record<string, unknown> = {};
const mockDbUpdate = vi.fn();
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ id: "conn-1", type: "odoo", name: "Odoo", credentials: "enc" }],
      }),
    }),
    update: (...args: unknown[]) => {
      mockDbUpdate(...args);
      return { set: () => ({ where: async () => undefined }) };
    },
  },
}));
vi.mock("@/lib/encryption", () => ({
  decrypt: () => JSON.stringify(storedCredentials),
  encrypt: (value: string) => value,
  getOrCreateSecret: () => Buffer.alloc(32),
}));
const mockSetIntegrationAuthFailed = vi.fn();
vi.mock("@/lib/integrations/auth-state", () => ({
  setIntegrationAuthFailed: (...args: unknown[]) => mockSetIntegrationAuthFailed(...args),
  clearIntegrationAuthError: vi.fn(),
}));
vi.mock("@/lib/audit-deferred", () => ({ deferAuditLog: vi.fn() }));

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
  mockSetIntegrationAuthFailed.mockClear();
  mockDbUpdate.mockClear();
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

// Test connection against an Odoo whose login works but whose every model
// call is refused by something in front of it (a WAF answering 403): the
// failure says nothing about the credentials, so the connection must not be
// flagged auth_failed.
describe("POST /api/integrations/[id]/test when the login works but every model call fails", () => {
  let wafFronted: { server: Server; origin: string };

  beforeAll(async () => {
    wafFronted = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id, params } = JSON.parse(body) as { id: number; params: { service: string } };
        if (params.service === "common") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: 2 }));
          return;
        }
        res.writeHead(403, { "content-type": "text/html" });
        res.end(`<html>${SECRET}</html>`);
      });
    });
  });

  afterAll(() => {
    wafFronted.server.close();
  });

  it("reports the failure without flagging auth_failed", async () => {
    storedCredentials = {
      url: wafFronted.origin,
      db: "prod",
      login: "admin",
      apiKey: "key",
      uid: 2,
    };
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(
      post("/api/integrations/conn-1/test", {}),
      routeContext({ connectionId: "conn-1" })
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.error).toContain("HTTP 403");
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
  });
});

// A server that speaks JSON-RPC but is not Odoo: its login answer carries no
// user id. Storing that as the uid would break every later call.
describe("a JSON-RPC server whose login answer has no user id", () => {
  let notOdoo: { server: Server; origin: string };

  beforeAll(async () => {
    notOdoo = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id } = JSON.parse(body) as { id: number };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
      });
    });
  });

  afterAll(() => {
    notOdoo.server.close();
  });

  const credentials = () => ({
    url: notOdoo.origin,
    db: "prod",
    login: "admin",
    apiKey: "key",
    uid: 2,
  });

  it("POST /api/integrations/test-credentials reports it", async () => {
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      post("/api/integrations/test-credentials", { type: "odoo", credentials: credentials() }),
      routeContext()
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.error).toMatch(/no user id/);
  });

  it("probeIntegrationCredentials reports it as transient", async () => {
    const { probeIntegrationCredentials } = await import("@/lib/integrations/probe");

    const result = await probeIntegrationCredentials("odoo", credentials());

    if (result.success) throw new Error("expected failure");
    expect(result.reason).toMatch(/no user id/);
    expect(result.transient).toBe(true);
  });

  // A schema sync does not log in, so it meets the null answer in odoo-node's
  // fields(), which throws a TypeError of its own. That is the URL's problem.
  it("POST /api/integrations/[id]/sync reports it as the URL's problem, not as a bug", async () => {
    storedCredentials = credentials();
    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(
      post("/api/integrations/conn-1/sync", {}),
      routeContext({ connectionId: "conn-1" })
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.error).toMatch(/fields_get answer carried no fields/);
    expect(body.error).toMatch(/Check that the URL points at the Odoo server itself/);
    expect(body.error).not.toMatch(/internal error/);
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
  });

  it("POST /api/integrations/sync-preview reports it as the URL's problem, not as a bug", async () => {
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const response = await POST(
      post("/api/integrations/sync-preview", { type: "odoo", credentials: credentials() }),
      routeContext()
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.error).toMatch(/fields_get answer carried no fields/);
    expect(body.error).not.toMatch(/internal error/);
  });

  it("POST /api/integrations/[id]/test stores no uid and does not flag auth_failed", async () => {
    storedCredentials = credentials();
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(
      post("/api/integrations/conn-1/test", {}),
      routeContext({ connectionId: "conn-1" })
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.error).toMatch(/no user id/);
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
  });
});

// Logs in like Odoo, then answers `version` with null: test-credentials reads
// `server_version` off it inside odoo-node.
describe("a JSON-RPC server that logs in but answers version with null", () => {
  let halfOdoo: { server: Server; origin: string };

  beforeAll(async () => {
    halfOdoo = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id, params } = JSON.parse(body) as { id: number; params: { method: string } };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: params.method === "authenticate" ? 2 : null,
          })
        );
      });
    });
  });

  afterAll(() => {
    halfOdoo.server.close();
  });

  it("POST /api/integrations/test-credentials reports it as the URL's problem, not as a bug", async () => {
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      post("/api/integrations/test-credentials", {
        type: "odoo",
        credentials: { url: halfOdoo.origin, db: "prod", login: "admin", apiKey: "key" },
      }),
      routeContext()
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.error).toMatch(/version answer carried no server version/);
    expect(body.error).not.toMatch(/internal error/);
  });
});

// A schema sync does not authenticate first: every model probe meets the
// redirect. That is one failure of the connection, not missing permissions on
// each model.
describe("schema sync against a redirecting Odoo", () => {
  const credentials = () => ({
    url: redirecting.origin,
    db: "prod",
    login: "admin",
    apiKey: "key",
    uid: 2,
  });

  function expectRedirectNamed(body: { success: boolean; error?: string }, status: number) {
    expect(internalHits).toBe(0);
    expect(body.success).toBe(false);
    expect(body.error).toContain(`HTTP ${status}`);
    expect(body.error).toMatch(/redirect/i);
    expect(body.error).not.toMatch(/read access/i);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  }

  it.each([302, 307, 308])(
    "POST /api/integrations/[id]/sync names a %i and does not flag auth_failed",
    async (status) => {
      redirectStatus = status;
      storedCredentials = credentials();
      const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

      const response = await POST(
        post("/api/integrations/conn-1/sync", {}),
        routeContext({ connectionId: "conn-1" })
      );

      expectRedirectNamed(await response.json(), status);
      expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
    }
  );

  it.each([302, 307, 308])("POST /api/integrations/sync-preview names a %i", async (status) => {
    redirectStatus = status;
    const { POST } = await import("@/app/api/integrations/sync-preview/route");

    const response = await POST(
      post("/api/integrations/sync-preview", { type: "odoo", credentials: credentials() }),
      routeContext()
    );

    expectRedirectNamed(await response.json(), status);
  });
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
