import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mockSession } from "@/test-helpers/auth";
import { routeContext } from "@/test-helpers/route";

// The admin Odoo routes check a URL against the SSRF rules and then talk to it
// through odoo-node, which calls the global `fetch` by hostname. That resolves
// the name a second time, and a hostile resolver can answer a public address
// for the check and 127.0.0.1 for the connect. These tests run the REAL guard
// and the REAL odoo-node with DNS stubbed, and assert where each request goes:
// to the address the guard classified, never by name.

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockDnsLookup = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
}));

// Stands in for the connection pinnedFetch makes: records the address it was
// told to connect to and answers like Odoo's JSON-RPC.
const pinnedCalls: Array<{ url: string; target: Array<{ address: string }> }> = [];
vi.mock("@/lib/pinned-connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pinned-connection")>();
  return {
    ...actual,
    createPinnedAgent: (target: Array<{ address: string }>) => ({
      target,
      close: async () => undefined,
    }),
    fetchWithPinnedAgent: async (
      url: string,
      init: RequestInit,
      agent: { target: Array<{ address: string }> }
    ) => {
      pinnedCalls.push({ url, target: agent.target });
      const { id, params } = JSON.parse(String(init.body)) as {
        id: number;
        params: { service: string; method: string };
      };
      let result: unknown = true;
      if (params.method === "authenticate") result = 2;
      if (params.method === "version") result = { server_version: "17.0" };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        headers: { "content-type": "application/json" },
      });
    },
  };
});

let storedCredentials: Record<string, unknown> = {};
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ id: "conn-1", type: "odoo", name: "Odoo", credentials: "enc" }],
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock("@/lib/encryption", () => ({
  decrypt: () => JSON.stringify(storedCredentials),
  encrypt: (value: string) => value,
  getOrCreateSecret: () => Buffer.alloc(32),
}));
vi.mock("@/lib/integrations/auth-state", () => ({
  setIntegrationAuthFailed: vi.fn(),
  clearIntegrationAuthError: vi.fn(),
}));
vi.mock("@/lib/audit-deferred", () => ({ deferAuditLog: vi.fn() }));

const CHECKED_IP = "93.184.216.34";
const creds = { url: "https://odoo.example.com", db: "prod", login: "admin", apiKey: "key" };

const mockFetch = vi.fn();

function post(path: string, body?: unknown) {
  return new NextRequest(`http://localhost:7777${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const routes = [
  {
    name: "test-credentials",
    call: async () => {
      const { POST } = await import("@/app/api/integrations/test-credentials/route");
      return POST(
        post("/api/integrations/test-credentials", { type: "odoo", credentials: creds }),
        routeContext()
      );
    },
  },
  {
    name: "sync-preview",
    call: async () => {
      const { POST } = await import("@/app/api/integrations/sync-preview/route");
      return POST(
        post("/api/integrations/sync-preview", { type: "odoo", credentials: { ...creds, uid: 2 } }),
        routeContext()
      );
    },
  },
  {
    name: "[connectionId]/sync",
    call: async () => {
      storedCredentials = { ...creds, uid: 2 };
      const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");
      return POST(post("/api/integrations/conn-1/sync"), routeContext({ connectionId: "conn-1" }));
    },
  },
];

beforeEach(() => {
  pinnedCalls.length = 0;
  mockFetch.mockReset();
  mockFetch.mockRejectedValue(new Error("unpinned fetch by name"));
  vi.stubGlobal("fetch", mockFetch);
  mockGetSession.mockResolvedValue(mockSession());
  mockDnsLookup.mockResolvedValue([{ address: CHECKED_IP, family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(routes)("POST /api/integrations/$name", ({ call }) => {
  it("connects to the address the guard checked, not to the host name", async () => {
    await call();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(pinnedCalls.length).toBeGreaterThan(0);
    for (const c of pinnedCalls) {
      expect(c.url).toBe("https://odoo.example.com/jsonrpc");
      expect(c.target.map((t) => t.address)).toEqual([CHECKED_IP]);
    }
  });

  it("rejects a host name that does not resolve, without connecting", async () => {
    mockDnsLookup.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));

    const response = await call();
    const body = await response.json();

    expect(JSON.stringify(body)).toMatch(/resolve/i);
    expect(body.success).not.toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(pinnedCalls).toHaveLength(0);
  });
});

// Every route that accepts an Odoo URL, including the ones that only check it.
const outageRoutes: Array<{ name: string; status?: number; call: () => Promise<Response> }> = [
  ...routes.map((r) => ({ ...r, status: r.name === "[connectionId]/sync" ? 200 : 503 })),
  {
    name: "list-databases",
    status: 503,
    call: async () => {
      const { POST } = await import("@/app/api/integrations/list-databases/route");
      return POST(post("/api/integrations/list-databases", { url: creds.url }), routeContext());
    },
  },
  {
    name: "create",
    status: 503,
    call: async () => {
      const { POST } = await import("@/app/api/integrations/route");
      return POST(
        post("/api/integrations", {
          type: "odoo",
          name: "Odoo",
          description: "",
          credentials: { ...creds, uid: 2 },
        }),
        routeContext()
      );
    },
  },
  {
    name: "PATCH [connectionId]",
    status: 503,
    call: async () => {
      storedCredentials = { ...creds, uid: 2 };
      const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");
      return PATCH(
        new NextRequest("http://localhost:7777/api/integrations/conn-1", {
          method: "PATCH",
          body: JSON.stringify({ credentials: { ...creds, uid: 2 } }),
        }),
        routeContext({ connectionId: "conn-1" })
      );
    },
  },
];

describe.each(outageRoutes)("$name during a DNS outage", ({ call, status }) => {
  it("says the lookup failed temporarily instead of blocking the URL", async () => {
    mockDnsLookup.mockRejectedValue(Object.assign(new Error("EAI_AGAIN"), { code: "EAI_AGAIN" }));

    const response = await call();
    const body = await response.json();

    expect(body.success).not.toBe(true);
    expect(body.error).toMatch(/temporar.*try again/i);
    expect(body.error).not.toMatch(/blocked/i);
    expect(response.status).toBe(status);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(pinnedCalls).toHaveLength(0);
  });
});

describe("the other callers that check an Odoo URL and then log in to it", () => {
  it("probeIntegrationCredentials connects to the checked address", async () => {
    const { probeIntegrationCredentials } = await import("@/lib/integrations/probe");

    await probeIntegrationCredentials("odoo", { ...creds, uid: 2 });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(pinnedCalls.length).toBeGreaterThan(0);
    for (const c of pinnedCalls) expect(c.target.map((t) => t.address)).toEqual([CHECKED_IP]);
  });

  it("probeIntegrationCredentials rejects an unresolvable host without connecting", async () => {
    mockDnsLookup.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    const { probeIntegrationCredentials } = await import("@/lib/integrations/probe");

    const result = await probeIntegrationCredentials("odoo", { ...creds, uid: 2 });

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(pinnedCalls).toHaveLength(0);
  });

  it("[connectionId]/test looks the host up once and connects to that answer", async () => {
    // A second lookup would see this address, which the pin must never use.
    mockDnsLookup.mockReset();
    mockDnsLookup
      .mockResolvedValueOnce([{ address: CHECKED_IP, family: 4 }])
      .mockResolvedValue([{ address: "93.184.216.99", family: 4 }]);
    storedCredentials = { ...creds, uid: 2 };
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    await POST(post("/api/integrations/conn-1/test"), routeContext({ connectionId: "conn-1" }));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(pinnedCalls.length).toBeGreaterThan(0);
    expect(mockDnsLookup).toHaveBeenCalledTimes(1);
    for (const c of pinnedCalls) expect(c.target.map((t) => t.address)).toEqual([CHECKED_IP]);
  });

  it("[connectionId]/test rejects an unresolvable host without connecting", async () => {
    mockDnsLookup.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    storedCredentials = { ...creds, uid: 2 };
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(
      post("/api/integrations/conn-1/test"),
      routeContext({ connectionId: "conn-1" })
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.error).toMatch(/resolve/i);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(pinnedCalls).toHaveLength(0);
  });
});
