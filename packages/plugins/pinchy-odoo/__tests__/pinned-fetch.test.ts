// @vitest-environment node
/**
 * DNS rebinding against pinchy-odoo, end to end through the real odoo-node.
 *
 * Pinchy checked `odoo.rebind.test` and saw a public address — here played by
 * 127.0.0.1, where a fake Odoo listens. When the plugin connects, the name
 * resolves again and a rebinding resolver now answers a private address. The
 * request must still reach the address Pinchy checked.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { OdooClient } from "odoo-node";
import { pinnedOdooFetch, pinOdooClient } from "../pinned-fetch";
import type { PinnedTarget } from "../pinned-target";

const dns = createRequire(import.meta.url)("node:dns") as typeof import("node:dns");
// Before any test builds a client: a wrapper installed on first use would
// already be in place by the time a later test looked.
const fetchAtLoad = globalThis.fetch;

let server: Server;
let port: number;
const seen: {
  headers: IncomingHttpHeaders;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
}[] = [];
const closedPorts: number[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({
      headers: req.headers,
      remoteAddress: req.socket.remoteAddress,
      remotePort: req.socket.remotePort,
    });
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { server_version: "19.0", server_version_info: [19, 0], protocol_version: 1 },
        })
      );
    });
  });
  server.on("connection", (socket) => {
    const remotePort = socket.remotePort;
    socket.on("close", () => {
      if (remotePort !== undefined) closedPorts.push(remotePort);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  seen.length = 0;
  closedPorts.length = 0;
  vi.restoreAllMocks();
});

/** The second resolution — the plugin's own — answers a private address. */
function rebindResolverToPrivate() {
  const rebound = vi.fn((_host: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error | null,
      address: unknown,
      family?: number
    ) => void;
    const all = typeof options === "object" && options !== null && "all" in options;
    if (all) cb(null, [{ address: "10.66.66.66", family: 4 }]);
    else cb(null, "10.66.66.66", 4);
  });
  vi.spyOn(dns, "lookup").mockImplementation(rebound as never);
  vi.spyOn(dns.promises, "lookup").mockResolvedValue([
    { address: "10.66.66.66", family: 4 },
  ] as never);
  return rebound;
}

const checked: PinnedTarget = [{ address: "127.0.0.1", family: 4 }];

describe("pinOdooClient", () => {
  it("sends every Odoo call to the address Pinchy checked, even after the name rebinds", async () => {
    const rebound = rebindResolverToPrivate();
    const url = `http://odoo.rebind.test:${port}`;
    const client = pinOdooClient({ url, db: "odoo", uid: 2, apiKey: "k" }, checked);

    const version = await client.version();

    expect(version.serverVersion).toBe("19.0");
    expect(seen).toHaveLength(1);
    expect(seen[0].remoteAddress).toBe("127.0.0.1");
    // The name stays the name: the Host header (and, over https, SNI and the
    // certificate check) still say what the admin typed.
    expect(seen[0].headers.host).toBe(`odoo.rebind.test:${port}`);
    expect(rebound).not.toHaveBeenCalled();
  });

  it("falls back to the next checked address when the first refuses", async () => {
    rebindResolverToPrivate();
    const url = `http://odoo.rebind.test:${port}`;
    // The fake Odoo listens on 127.0.0.1 only, so ::1 refuses (or, on a host
    // without IPv6, is unreachable) — the connector must move on to the next
    // checked address rather than fail the call.
    const client = pinOdooClient({ url, db: "odoo", uid: 2, apiKey: "k" }, [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ]);

    const version = await client.version();

    expect(version.serverVersion).toBe("19.0");
    expect(seen[0].remoteAddress).toBe("127.0.0.1");
  });

  it("refuses a redirect through the client and never contacts its target", async () => {
    const redirecting = createServer((_req, res) => {
      res.statusCode = 307;
      res.setHeader("location", `http://127.0.0.1:${port}/jsonrpc`);
      res.end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    const rport = (redirecting.address() as AddressInfo).port;
    try {
      const url = `http://odoo.rebind.test:${rport}`;
      const client = pinOdooClient({ url, db: "odoo", uid: 2, apiKey: "k" }, checked);
      await expect(client.version()).rejects.toThrow(/redirect \(HTTP 307\)/);
      expect(seen).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => redirecting.close(() => resolve()));
    }
  });

  it("is a plain OdooClient", () => {
    const url = `http://odoo.rebind.test:${port}`;
    const client = pinOdooClient({ url, db: "odoo", uid: 2, apiKey: "k" }, checked);
    expect(client).toBeInstanceOf(OdooClient);
  });

  it("leaves the process-wide fetch alone", async () => {
    // OpenClaw runs every plugin in one process. The pin travels with the
    // client, so no other plugin's fetch passes through pinchy-odoo's code.
    const url = `http://odoo.rebind.test:${port}`;
    await pinOdooClient({ url, db: "odoo", uid: 2, apiKey: "k" }, checked).version();
    expect(globalThis.fetch).toBe(fetchAtLoad);
  });
});

describe("pinnedOdooFetch", () => {
  it("refuses a request to any origin but the checked one", async () => {
    // odoo-node only ever posts to `${url}/jsonrpc`. Anything else would go
    // out by host name, unchecked — so it does not go out at all.
    const pinned = pinnedOdooFetch(`http://odoo.rebind.test:${port}`, checked);
    await expect(pinned("http://pinchy.internal:7777/api/x")).rejects.toThrow(/checked/);
    expect(seen).toHaveLength(0);
  });

  it("opens a connector per request and closes it once the response is read", async () => {
    // Each request gets its own connector, closed as soon as its response
    // settles: nothing stays open between calls, and a cached client never
    // holds a socket to an address checked minutes ago.
    const url = `http://odoo.rebind.test:${port}`;
    const pinned = pinnedOdooFetch(url, checked);
    for (let i = 0; i < 2; i++) {
      const res = await pinned(`${url}/jsonrpc`, { method: "POST", body: "{}" });
      await res.text();
    }

    // A connector shared across calls would reuse its keep-alive socket.
    expect(seen).toHaveLength(2);
    expect(seen[1].remotePort).not.toBe(seen[0].remotePort);
    await vi.waitFor(() =>
      expect(closedPorts).toEqual(expect.arrayContaining(seen.map((s) => s.remotePort)))
    );
  });

  it("refuses a Request object rather than drop its method and body", async () => {
    // odoo-node calls fetch by URL. A Request would carry its method, headers
    // and body inside it, which the pinned path does not forward — sending it
    // as a bare GET would be a different request from the one asked for.
    const url = `http://odoo.rebind.test:${port}`;
    const pinned = pinnedOdooFetch(url, checked);
    await expect(
      pinned(new Request(`${url}/jsonrpc`, { method: "POST", body: "{}" }))
    ).rejects.toThrow(/by URL/);
    expect(seen).toHaveLength(0);
  });

  it("gives up on an Odoo that accepts the connection and never answers", async () => {
    // Without a bound here a blackholed Odoo would hold the agent's tool call
    // open forever.
    const hanging = createServer(() => {});
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const hport = (hanging.address() as AddressInfo).port;
    try {
      const url = `http://odoo.rebind.test:${hport}`;
      const pinned = pinnedOdooFetch(url, checked, { timeoutMs: 200 });
      const started = Date.now();
      await expect(pinned(`${url}/jsonrpc`, { method: "POST" })).rejects.toThrow(
        /timeout|aborted/i
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("still honours the caller's own abort signal", async () => {
    const hanging = createServer(() => {});
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const hport = (hanging.address() as AddressInfo).port;
    try {
      const url = `http://odoo.rebind.test:${hport}`;
      const controller = new AbortController();
      const pending = pinnedOdooFetch(url, checked)(`${url}/jsonrpc`, {
        method: "POST",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toThrow(/abort/i);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("refuses to follow a redirect off the checked address", async () => {
    // The target is the local fake Odoo, standing in for an address nobody
    // checked: a followed hop would show up in `seen` at once.
    const redirecting = createServer((_req, res) => {
      res.statusCode = 307;
      res.setHeader("location", `http://127.0.0.1:${port}/jsonrpc`);
      res.end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    const rport = (redirecting.address() as AddressInfo).port;
    try {
      const url = `http://odoo.rebind.test:${rport}`;
      const res = await pinnedOdooFetch(url, checked)(`${url}/jsonrpc`, {
        method: "POST",
        redirect: "follow",
      });
      expect(res.status).toBe(307);
      expect(seen).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => redirecting.close(() => resolve()));
    }
  });
});
