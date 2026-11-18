import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OdooClient, OdooError } from "odoo-node";
import { readOdooFields, readOdooVersion } from "@/lib/integrations/odoo-calls";
import { describeOdooError, isOdooTimeout } from "@/lib/integrations/odoo-error";
import { withPinnedOdoo } from "@/lib/integrations/odoo-pin";
import { toPinnedTarget } from "@/lib/pinned-connection";

// No mocks: the real pinned connector against a local server. The URL names a
// host that does not exist; the only way the request arrives is through the pin.

let server: Server;
let received: { method?: string; host?: string; contentType?: string; body: string };
let origin: string;
let answer: string;

beforeEach(async () => {
  received = { body: "" };
  answer = '{"ok":true}';
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = {
        method: req.method,
        host: req.headers.host,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString(),
      };
      res.setHeader("content-type", "application/json");
      res.end(answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://pinned-odoo.invalid:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("withPinnedOdoo against a real connector", () => {
  it("delivers the method, headers and JSON body intact to the pinned address", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", method: "call", params: { a: [1, 2] } });

    const response = await withPinnedOdoo(origin, toPinnedTarget(["127.0.0.1"]), (pinned) =>
      pinned(`${origin}/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      })
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(received.method).toBe("POST");
    expect(received.contentType).toBe("application/json");
    expect(received.host).toBe(new URL(origin).host);
    expect(received.body).toBe(payload);
  });

  it("carries an OdooClient's calls to the pinned address", async () => {
    // The seam the routes rely on: odoo-node sends through the fetch it is
    // given, so the client reaches a host name that resolves nowhere.
    answer = '{"jsonrpc":"2.0","id":1,"result":{"server_version":"17.0"}}';

    const version = await withPinnedOdoo(origin, toPinnedTarget(["127.0.0.1"]), (pinned) =>
      new OdooClient({ url: origin, db: "odoo", uid: 2, apiKey: "k", fetch: pinned }).version()
    );

    expect(version.serverVersion).toBe("17.0");
    expect(received.method).toBe("POST");
    expect(JSON.parse(received.body).params.method).toBe("version");
  });

  // `readOdooFields` / `readOdooVersion` read a TypeError as "Odoo answered
  // with no result". That holds only while odoo-node wraps every rejection of
  // the fetch it is given — undici's "fetch failed" and our own refusals are
  // TypeErrors too — into an OdooError with code 0. Pinned here, so a network
  // failure never turns into "check the URL".
  it.each([
    ["a refused origin", "http://elsewhere.invalid"],
    ["a closed port", null],
  ])("reports %s inside fields() and version() as a transport failure", async (_, clientUrl) => {
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const scope = clientUrl ? origin : `http://pinned-odoo.invalid:${closed}`;

    const errors = await withPinnedOdoo(scope, toPinnedTarget(["127.0.0.1"]), async (pinned) => {
      const client = new OdooClient({
        url: clientUrl ?? scope,
        db: "odoo",
        uid: 2,
        apiKey: "k",
        fetch: pinned,
      });
      return Promise.all([
        readOdooFields(client, "res.partner").catch((e: unknown) => e),
        readOdooVersion(client).catch((e: unknown) => e),
      ]);
    });

    for (const err of errors) {
      expect(err).toBeInstanceOf(OdooError);
      expect((err as OdooError).code).toBe(0);
    }
  });
});

// An Odoo, or a proxy in front of it, that accepts the connection and never
// answers. Without a bound each call waits for undici's own 300 s headers
// timeout, and a schema sync retrying across every model for far longer.
describe("withPinnedOdoo against a server that never answers", () => {
  let silent: Server;
  let silentOrigin: string;

  beforeEach(async () => {
    silent = createServer(() => {
      // Read nothing, answer nothing.
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    silentOrigin = `http://pinned-odoo.invalid:${(silent.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
  });

  function version(pinned: typeof fetch, signal?: AbortSignal) {
    return new OdooClient({
      url: silentOrigin,
      db: "odoo",
      uid: 2,
      apiKey: "k",
      fetch: pinned,
      signal,
    }).version();
  }

  it("gives up on a request once the bound passes, and says Odoo did not answer in time", async () => {
    const started = Date.now();

    const err = await withPinnedOdoo(
      silentOrigin,
      toPinnedTarget(["127.0.0.1"]),
      (pinned) => version(pinned).catch((e: unknown) => e),
      { timeoutMs: 200 }
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(OdooError);
    expect((err as OdooError).code).toBe(0);
    expect(isOdooTimeout(err)).toBe(true);
    expect(describeOdooError(err)).toMatch(/^Odoo did not answer within \d+ seconds\./);
  });

  it("keeps the bound when the caller passes a signal of its own", async () => {
    // The `init.signal ?? timeout` trap: a caller's signal must not replace it.
    const neverAborts = new AbortController().signal;

    const err = await withPinnedOdoo(
      silentOrigin,
      toPinnedTarget(["127.0.0.1"]),
      (pinned) => version(pinned, neverAborts).catch((e: unknown) => e),
      { timeoutMs: 200 }
    );

    expect(isOdooTimeout(err)).toBe(true);
  });

  it("still lets the caller cancel well before the bound", async () => {
    const caller = new AbortController();
    const started = Date.now();
    setTimeout(() => caller.abort(), 50);

    const err = await withPinnedOdoo(silentOrigin, toPinnedTarget(["127.0.0.1"]), (pinned) =>
      version(pinned, caller.signal).catch((e: unknown) => e)
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(OdooError);
    expect(isOdooTimeout(err)).toBe(false);
  });
});
