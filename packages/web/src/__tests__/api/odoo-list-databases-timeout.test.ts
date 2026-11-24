import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mockSession } from "@/test-helpers/auth";
import { routeContext } from "@/test-helpers/route";

// Listing databases is the first request the Add-connection dialog sends an
// Odoo, and it goes out through `pinnedFetch` rather than odoo-node. Against a
// REAL server that takes the connection and never answers, it has to end on
// the same bound every other Odoo call from the web app keeps — shortened here
// so the test does not wait a minute.

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

// The guard is not under test: it waves 127.0.0.1 through and pins to it.
vi.mock("@/lib/integrations/url-validation", () => ({
  resolveExternalUrlTarget: async (url: string) => ({
    valid: true,
    url: new URL(url).origin,
    target: [{ address: new URL(url).hostname, family: 4 }],
  }),
}));

vi.mock("@/lib/integrations/odoo-timeout", () => ({ ODOO_REQUEST_TIMEOUT_MS: 200 }));

let silent: Server;
let origin: string;
/** Whether the server sends its headers and the start of a body before going silent. */
let startsAnswer = false;

beforeEach(async () => {
  mockGetSession.mockResolvedValue(mockSession());
  startsAnswer = false;
  silent = createServer((_req, res) => {
    if (!startsAnswer) return; // Read nothing, answer nothing.
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"jsonrpc":"2.0","id":1,"result":[');
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
});

afterEach(async () => {
  silent.closeAllConnections();
  await new Promise((resolve) => silent.close(resolve));
});

describe("POST /api/integrations/list-databases against an Odoo that never answers", () => {
  it.each([
    ["sends nothing", false],
    ["stops partway through its answer", true],
  ])(
    "gives up once the bound passes when Odoo %s, and says it did not answer in time",
    async (_, starts) => {
      startsAnswer = starts;
      const { POST } = await import("@/app/api/integrations/list-databases/route");
      const started = Date.now();

      const res = await POST(
        new NextRequest("http://localhost:7777/api/integrations/list-databases", {
          method: "POST",
          body: JSON.stringify({ url: origin }),
        }),
        routeContext()
      );

      expect(Date.now() - started).toBeLessThan(5_000);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/^Odoo did not answer within [\d.]+ seconds\./);
    }
  );
});

describe("POST /api/integrations/list-databases against a port nothing listens on", () => {
  it("says Odoo refused the connection, as testing credentials does", async () => {
    // The port the silent server had, closed again: a real ECONNREFUSED.
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
    silent = createServer(); // For afterEach to close.
    const { POST } = await import("@/app/api/integrations/list-databases/route");

    const res = await POST(
      new NextRequest("http://localhost:7777/api/integrations/list-databases", {
        method: "POST",
        body: JSON.stringify({ url: origin }),
      }),
      routeContext()
    );

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/^Odoo refused the connection \(ECONNREFUSED\)/);
  });
});
