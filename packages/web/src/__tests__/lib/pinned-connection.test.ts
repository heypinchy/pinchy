import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pinnedFetch, pinnedLookup, toPinnedAddress } from "@/lib/pinned-connection";

// Real sockets, real undici: what is under test is where the connection
// actually goes. A mocked fetch cannot tell a pinned request from an unpinned
// one, and it cannot see whether undici accepts the dispatcher at all.

let server: Server;
let port: number;
let seen: IncomingMessage[] = [];
let respond: (req: IncomingMessage, res: import("node:http").ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  respond = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "m" }] }));
  };
});

describe("pinnedFetch", () => {
  it("connects to the pinned address, never resolving the URL's name", async () => {
    // `.invalid` is reserved (RFC 6761) and never resolves. The request can
    // only reach the listener if the connection used the pinned address.
    const res = await pinnedFetch(
      `http://rebound.invalid:${port}/v1/models`,
      { signal: AbortSignal.timeout(5_000) },
      toPinnedAddress("127.0.0.1")
    );

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    // The Host header still names the host — virtual hosting keeps working.
    expect(seen[0].headers.host).toBe(`rebound.invalid:${port}`);
    expect(seen[0].url).toBe("/v1/models");
  });

  it("leaves the body readable after it returns", async () => {
    const res = await pinnedFetch(
      `http://rebound.invalid:${port}/`,
      { signal: AbortSignal.timeout(5_000) },
      toPinnedAddress("127.0.0.1")
    );

    expect(await res.json()).toEqual({ data: [{ id: "m" }] });
  });

  it("hands a redirect back instead of following it when asked for manual", async () => {
    respond = (_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end();
    };

    const res = await pinnedFetch(
      `http://rebound.invalid:${port}/`,
      { redirect: "manual", signal: AbortSignal.timeout(5_000) },
      toPinnedAddress("127.0.0.1")
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://169.254.169.254/");
    expect(seen).toHaveLength(1);
  });

  it("never follows a redirect, even when the caller did not ask for manual", async () => {
    // A followed hop is a connection nobody checked — and to an address
    // literal it needs no lookup, so the pin does not even apply.
    respond = (req, res) => {
      if (req.url === "/landed") {
        res.writeHead(200);
        res.end("followed");
        return;
      }
      res.writeHead(302, { location: `http://127.0.0.1:${port}/landed` });
      res.end();
    };

    const res = await pinnedFetch(
      `http://rebound.invalid:${port}/`,
      { signal: AbortSignal.timeout(5_000) },
      toPinnedAddress("127.0.0.1")
    );

    expect(res.status).toBe(302);
    expect(seen.map((req) => req.url)).toEqual(["/"]);
  });

  it("refuses a caller that asks for redirects to be followed", async () => {
    await expect(
      pinnedFetch(
        `http://rebound.invalid:${port}/`,
        { redirect: "follow", signal: AbortSignal.timeout(5_000) },
        toPinnedAddress("127.0.0.1")
      )
    ).rejects.toThrow(/redirect/);
    expect(seen).toHaveLength(0);
  });

  it("sends the request headers it was given", async () => {
    await pinnedFetch(
      `http://rebound.invalid:${port}/`,
      { headers: { Authorization: "Bearer sk-key" }, signal: AbortSignal.timeout(5_000) },
      toPinnedAddress("127.0.0.1")
    );

    expect(seen[0].headers.authorization).toBe("Bearer sk-key");
  });

  it("aborts when its signal does", async () => {
    respond = () => {
      // never answer
    };

    await expect(
      pinnedFetch(
        `http://rebound.invalid:${port}/`,
        { signal: AbortSignal.timeout(200) },
        toPinnedAddress("127.0.0.1")
      )
    ).rejects.toThrow();
  });
});

describe("pinnedLookup", () => {
  it("answers both halves of the dns.lookup contract with the pinned address", () => {
    const lookup = pinnedLookup(toPinnedAddress("2001:db8::1"));

    const flat: unknown[] = [];
    lookup("anything.example", {}, (...args: unknown[]) => flat.push(...args));
    expect(flat).toEqual([null, "2001:db8::1", 6]);

    const all: unknown[] = [];
    lookup("anything.example", { all: true }, (...args: unknown[]) => all.push(...args));
    expect(all).toEqual([null, [{ address: "2001:db8::1", family: 6 }]]);
  });
});

describe("toPinnedAddress", () => {
  it("derives the family from the literal", () => {
    expect(toPinnedAddress("93.184.216.34")).toEqual({ address: "93.184.216.34", family: 4 });
    expect(toPinnedAddress("[2001:db8::1]")).toEqual({ address: "2001:db8::1", family: 6 });
  });

  it("refuses something that is not an address", () => {
    expect(() => toPinnedAddress("example.com")).toThrow();
  });
});
