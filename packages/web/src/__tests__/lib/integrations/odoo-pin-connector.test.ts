import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { withPinnedOdooFetch } from "@/lib/integrations/odoo-pin";
import { toPinnedTarget } from "@/lib/pinned-connection";

// No mocks: the real pinned connector against a local server. The URL names a
// host that does not exist; the only way the request arrives is through the pin.

let server: Server;
let received: { method?: string; host?: string; contentType?: string; body: string };
let origin: string;

beforeEach(async () => {
  received = { body: "" };
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
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://pinned-odoo.invalid:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("withPinnedOdooFetch against a real connector", () => {
  it("delivers a Request's method, headers and JSON body intact to the pinned address", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", method: "call", params: { a: [1, 2] } });

    const response = await withPinnedOdooFetch(origin, toPinnedTarget(["127.0.0.1"]), () =>
      fetch(
        new Request(`${origin}/jsonrpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        })
      )
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(received.method).toBe("POST");
    expect(received.contentType).toBe("application/json");
    expect(received.host).toBe(new URL(origin).host);
    expect(received.body).toBe(payload);
  });
});
