// @vitest-environment node
//
// Drives the real dispatcher against a real HTTP server: no mocked fetch, no
// mocked DNS. Separate from web-fetch.test.ts on purpose — that suite mocks
// fetch wholesale, so it can only assert an Agent was attached, never that
// undici accepts one. A pairing of Agent and fetch drawn from two different
// undici copies fails every dispatch while that suite stays green, so this file
// is the only thing standing between such a mismatch and production.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildPinnedAgent, httpFetch } from "./web-fetch.js";

describe("pinned dispatcher is compatible with the fetch webFetch dispatches through", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><p>pinned ok</p></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // The hostname never resolves — it exists only to prove the pinned lookup,
  // not the OS resolver, decides where the socket goes. A ".invalid" name that
  // reached real DNS would NXDOMAIN.
  const pinnedUrl = (path = "/") => `http://pinned.invalid:${port}${path}`;

  it("completes a request through a pinned-IP Agent", async () => {
    const agent = buildPinnedAgent("127.0.0.1", 4);
    try {
      const res = await httpFetch(pinnedUrl(), {
        headers: { "User-Agent": "PinchyBot/1.0" },
        redirect: "manual",
        dispatcher: agent,
      } as RequestInit);

      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toContain("pinned ok");
    } finally {
      await agent.close();
    }
  });

  it("routes to the pinned address rather than the URL's hostname", async () => {
    const agent = buildPinnedAgent("127.0.0.1", 4);
    try {
      // Reaching a 200 at all proves the socket went to 127.0.0.1: no resolver
      // would ever map "pinned.invalid" there.
      const res = await httpFetch(pinnedUrl(), { dispatcher: agent } as RequestInit);
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      await agent.close();
    }
  });

  it("surfaces a real HTTP status instead of an opaque transport failure", async () => {
    // The regression made every response — including redirects webFetch must
    // read `location` off — collapse into "fetch failed" before any status was
    // available. Assert a status survives the dispatcher.
    const agent = buildPinnedAgent("127.0.0.1", 4);
    try {
      const res = await httpFetch(pinnedUrl("/redirect"), {
        redirect: "manual",
        dispatcher: agent,
      } as RequestInit);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      await res.text();
    } finally {
      await agent.close();
    }
  });
});
