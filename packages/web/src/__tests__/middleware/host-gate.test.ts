import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";

vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/domain-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain-cache")>();
  return { ...actual, getCachedDomain: vi.fn() };
});

import { applyDomainLockGate } from "@/server/host-check";
import { appendAuditLog } from "@/lib/audit";
import { getCachedDomain } from "@/lib/domain-cache";

function makeReq(opts: {
  method: string;
  url: string;
  host?: string;
  forwardedHost?: string;
  accept?: string;
  remoteAddress?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.host) headers.host = opts.host;
  if (opts.forwardedHost) headers["x-forwarded-host"] = opts.forwardedHost;
  if (opts.accept) headers.accept = opts.accept;
  return {
    method: opts.method,
    url: opts.url,
    headers,
    socket: { remoteAddress: opts.remoteAddress },
  } as unknown as IncomingMessage;
}

type FakeRes = ServerResponse & {
  _statusCode?: number;
  _headers: Record<string, string>;
  _body?: string;
};

function makeRes(): FakeRes {
  const res = {
    _statusCode: undefined as number | undefined,
    _headers: {} as Record<string, string>,
    _body: undefined as string | undefined,
    writeHead(status: number, headers: Record<string, string>) {
      this._statusCode = status;
      this._headers = headers;
    },
    end(body?: string) {
      this._body = body;
    },
  };
  return res as unknown as FakeRes;
}

describe("applyDomainLockGate", () => {
  beforeEach(() => {
    vi.mocked(appendAuditLog).mockClear();
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
  });

  it("lets a request on the locked domain through", async () => {
    const req = makeReq({ method: "GET", url: "/dashboard", host: "pinchy.example.com" });
    const res = makeRes();

    expect(await applyDomainLockGate(req, res)).toBe(false);
    expect(res._statusCode).toBeUndefined();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  // #599: the whole reason this bug was expensive. The plugin POST arrives on
  // the Docker-internal hostname, which never matches the locked domain.
  it("lets a plugin's capture POST through on the Docker-internal hostname", async () => {
    const req = makeReq({
      method: "POST",
      url: "/api/internal/channel-messages",
      host: "pinchy:7777",
    });
    const res = makeRes();

    expect(await applyDomainLockGate(req, res)).toBe(false);
    expect(res._statusCode).toBeUndefined();
  });

  it("blocks a foreign host on an API path with 403 JSON and an audit row", async () => {
    const req = makeReq({
      method: "POST",
      url: "/api/settings/domain",
      host: "evil.example.com",
      remoteAddress: "203.0.113.42",
    });
    const res = makeRes();

    expect(await applyDomainLockGate(req, res)).toBe(true);
    expect(res._statusCode).toBe(403);
    expect(res._headers["Content-Type"]).toBe("application/json");
    expect(res._body).toContain("does not match the configured domain");

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.eventType).toBe("auth.host_blocked");
    expect(call.detail).toMatchObject({
      method: "POST",
      pathname: "/api/settings/domain",
      host: "evil.example.com",
      lockedDomain: "pinchy.example.com",
      remoteAddress: "203.0.113.42",
    });
  });

  it("serves the Access Denied page to a browser, and audits nothing", async () => {
    const req = makeReq({
      method: "GET",
      url: "/dashboard",
      host: "evil.example.com",
      accept: "text/html,application/xhtml+xml",
    });
    const res = makeRes();

    expect(await applyDomainLockGate(req, res)).toBe(true);
    expect(res._statusCode).toBe(403);
    expect(res._headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res._body).toContain("Access Denied");
    expect(res._body).toContain("https://pinchy.example.com");
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("prefers x-forwarded-host over host", async () => {
    const req = makeReq({
      method: "GET",
      url: "/dashboard",
      host: "internal:7777",
      forwardedHost: "pinchy.example.com",
    });
    const res = makeRes();

    expect(await applyDomainLockGate(req, res)).toBe(false);
  });

  it("answers before the audit write settles", async () => {
    // A blocked caller must not wait on the DB — and an audit failure must not
    // turn the 403 into a hung request or a 500.
    let release: () => void = () => {};
    vi.mocked(appendAuditLog).mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve({ id: 1, rowHmac: "hmac" });
      })
    );
    const req = makeReq({ method: "POST", url: "/api/agents", host: "evil.example.com" });
    const res = makeRes();

    expect(await applyDomainLockGate(req, res)).toBe(true);
    expect(res._statusCode).toBe(403);
    release();
  });
});
