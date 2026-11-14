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
import { pinOdooClient, withPinnedFetch } from "../pinned-fetch";
import type { PinnedTarget } from "../pinned-target";

const dns = createRequire(import.meta.url)("node:dns") as typeof import("node:dns");

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
    const client = pinOdooClient(
      new OdooClient({ url, db: "odoo", uid: 2, apiKey: "k" }),
      url,
      checked
    );

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
    const client = pinOdooClient(new OdooClient({ url, db: "odoo", uid: 2, apiKey: "k" }), url, [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ]);

    const version = await client.version();

    expect(version.serverVersion).toBe("19.0");
    expect(seen[0].remoteAddress).toBe("127.0.0.1");
  });

  it("keeps returning the client's own values for non-function properties", () => {
    const url = `http://odoo.rebind.test:${port}`;
    const raw = new OdooClient({ url, db: "odoo", uid: 2, apiKey: "k" });
    const client = pinOdooClient(raw, url, checked);
    expect(client).toBeInstanceOf(OdooClient);
  });
});

describe("withPinnedFetch", () => {
  it("leaves a request to another origin to the ordinary fetch", async () => {
    const plain = vi.fn(async () => new Response("plain"));
    const original = globalThis.fetch;
    globalThis.fetch = plain as unknown as typeof fetch;
    try {
      const body = await withPinnedFetch(`http://odoo.rebind.test:${port}`, checked, async () =>
        (await fetch("http://pinchy.internal:7777/api/x")).text()
      );
      expect(body).toBe("plain");
      expect(plain).toHaveBeenCalledOnce();
      expect(seen).toHaveLength(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("pins nothing outside the scope", async () => {
    const plain = vi.fn(async () => new Response("plain"));
    const original = globalThis.fetch;
    // Install the wrapper, then replace what it wraps — the replacement is
    // wrapped again on the next entry, never silently undone.
    await withPinnedFetch(`http://odoo.rebind.test:${port}`, checked, async () => undefined);
    globalThis.fetch = plain as unknown as typeof fetch;
    try {
      await fetch(`http://odoo.rebind.test:${port}/jsonrpc`);
      expect(plain).toHaveBeenCalledOnce();
      expect(seen).toHaveLength(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("re-wraps a fetch that was replaced after the wrapper went in", async () => {
    rebindResolverToPrivate();
    const original = globalThis.fetch;
    await withPinnedFetch(`http://odoo.rebind.test:${port}`, checked, async () => undefined);
    globalThis.fetch = vi.fn(async () => new Response("bypassed")) as unknown as typeof fetch;
    try {
      const url = `http://odoo.rebind.test:${port}`;
      const client = pinOdooClient(
        new OdooClient({ url, db: "o", uid: 2, apiKey: "k" }),
        url,
        checked
      );
      const version = await client.version();
      expect(version.serverVersion).toBe("19.0");
      expect(seen[0].remoteAddress).toBe("127.0.0.1");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("pins through a fresh copy of the module, as after an in-process gateway restart", async () => {
    // OpenClaw restarts its gateway inside the same process and re-evaluates
    // plugin modules, while the wrapper on the shared global fetch stays. The
    // new copy must not pin into a store the installed wrapper never reads.
    const original = globalThis.fetch;
    const unpinned = vi.fn(async () => new Response("unpinned"));
    globalThis.fetch = unpinned as unknown as typeof fetch;
    try {
      const url = `http://odoo.rebind.test:${port}`;
      vi.resetModules();
      const first = await import("../pinned-fetch");
      await first.withPinnedFetch(url, checked, async () => undefined);
      vi.resetModules();
      const second = await import("../pinned-fetch");

      const status = await second.withPinnedFetch(url, checked, async () => {
        const res = await fetch(`${url}/jsonrpc`, { method: "POST", body: "{}" });
        await res.text();
        return res.status;
      });

      expect(unpinned).not.toHaveBeenCalled();
      expect(status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].remoteAddress).toBe("127.0.0.1");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends every request of one scope over one connection, and closes it when the scope ends", async () => {
    // A schema sync makes hundreds of requests in one scope: a connector per
    // request would open (and TLS-handshake) a socket for each.
    const url = `http://odoo.rebind.test:${port}`;
    await withPinnedFetch(url, checked, async () => {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${url}/jsonrpc`, { method: "POST", body: "{}" });
        await res.text();
        // Let the client hand the idle socket back to its pool.
        await new Promise((resolve) => setImmediate(resolve));
      }
    });

    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((s) => s.remotePort)).size).toBe(1);
    await vi.waitFor(() => expect(closedPorts).toContain(seen[0].remotePort));
  });

  it("gives up on an Odoo that accepts the connection and never answers", async () => {
    // odoo-node passes no signal, so without a bound here a blackholed Odoo
    // would hold the agent's tool call open forever.
    const hanging = createServer(() => {});
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const hport = (hanging.address() as AddressInfo).port;
    try {
      const url = `http://odoo.rebind.test:${hport}`;
      const started = Date.now();
      await expect(
        withPinnedFetch(url, checked, async () => fetch(`${url}/jsonrpc`, { method: "POST" }), {
          timeoutMs: 200,
        })
      ).rejects.toThrow(/timeout|aborted/i);
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
      const pending = withPinnedFetch(url, checked, async () =>
        fetch(`${url}/jsonrpc`, { method: "POST", signal: controller.signal })
      );
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toThrow(/abort/i);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("refuses to follow a redirect off the checked address", async () => {
    const redirecting = createServer((_req, res) => {
      res.statusCode = 307;
      res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
      res.end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    const rport = (redirecting.address() as AddressInfo).port;
    try {
      const url = `http://odoo.rebind.test:${rport}`;
      const status = await withPinnedFetch(url, checked, async () => {
        const res = await fetch(`${url}/jsonrpc`, { method: "POST", redirect: "follow" });
        return res.status;
      });
      expect(status).toBe(307);
    } finally {
      await new Promise<void>((resolve) => redirecting.close(() => resolve()));
    }
  });
});
