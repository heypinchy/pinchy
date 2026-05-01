import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { applyCsrfGate } from "@/server/csrf-check";
import { appendAuditLog } from "@/lib/audit";

function makeReq(opts: {
  method: string;
  url: string;
  host?: string;
  forwardedHost?: string;
  forwardedProto?: string;
  origin?: string;
  referer?: string;
  remoteAddress?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.host) headers.host = opts.host;
  if (opts.forwardedHost) headers["x-forwarded-host"] = opts.forwardedHost;
  if (opts.forwardedProto) headers["x-forwarded-proto"] = opts.forwardedProto;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.referer) headers.referer = opts.referer;
  return {
    method: opts.method,
    url: opts.url,
    headers,
    socket: { remoteAddress: opts.remoteAddress },
  } as unknown as IncomingMessage;
}

function makeRes(): ServerResponse & {
  _statusCode?: number;
  _headers: Record<string, string>;
  _body?: string;
} {
  const res = {
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      this._statusCode = status;
      this._headers = headers;
    },
    end(body?: string) {
      this._body = body;
    },
  };
  return res as unknown as ServerResponse & {
    _statusCode?: number;
    _headers: Record<string, string>;
    _body?: string;
  };
}

describe("applyCsrfGate", () => {
  beforeEach(() => {
    vi.mocked(appendAuditLog).mockClear();
  });

  it("allows GET requests through (returns false, no 403)", async () => {
    const req = makeReq({
      method: "GET",
      url: "/api/agents",
      host: "pinchy.example.com",
    });
    const res = makeRes();

    const blocked = await applyCsrfGate(req, res);

    expect(blocked).toBe(false);
    expect(res._statusCode).toBeUndefined();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("allows same-origin POST through", async () => {
    const req = makeReq({
      method: "POST",
      url: "/api/agents",
      host: "pinchy.example.com",
      forwardedProto: "https",
      origin: "https://pinchy.example.com",
    });
    const res = makeRes();

    const blocked = await applyCsrfGate(req, res);

    expect(blocked).toBe(false);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("blocks cross-origin POST with 403 and audit log", async () => {
    const req = makeReq({
      method: "POST",
      url: "/api/users/invite",
      host: "pinchy.example.com",
      forwardedProto: "https",
      origin: "https://evil.example.com",
      remoteAddress: "203.0.113.42",
    });
    const res = makeRes();

    const blocked = await applyCsrfGate(req, res);

    expect(blocked).toBe(true);
    expect(res._statusCode).toBe(403);
    expect(res._body).toContain("CSRF");
    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(auditCall.eventType).toBe("auth.csrf_blocked");
    expect(auditCall.outcome).toBe("failure");
    expect(auditCall.detail).toMatchObject({
      method: "POST",
      pathname: "/api/users/invite",
      origin: "https://evil.example.com",
      remoteAddress: "203.0.113.42",
    });
  });

  it("prefers x-forwarded-host over host header (proxy-aware)", async () => {
    const req = makeReq({
      method: "POST",
      url: "/api/agents",
      host: "internal:7777",
      forwardedHost: "pinchy.example.com",
      forwardedProto: "https",
      origin: "https://pinchy.example.com",
    });
    const res = makeRes();

    const blocked = await applyCsrfGate(req, res);

    expect(blocked).toBe(false);
  });

  it("ignores query strings on the URL when checking pathname", async () => {
    const req = makeReq({
      method: "POST",
      url: "/api/agents?foo=bar",
      host: "pinchy.example.com",
      forwardedProto: "https",
      origin: "https://evil.example.com",
    });
    const res = makeRes();

    const blocked = await applyCsrfGate(req, res);

    expect(blocked).toBe(true);
    const auditCall = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(auditCall.detail).toMatchObject({ pathname: "/api/agents" });
  });

  it("exempts /api/auth/* (Better Auth)", async () => {
    const req = makeReq({
      method: "POST",
      url: "/api/auth/sign-in/email",
      host: "pinchy.example.com",
      forwardedProto: "https",
      origin: "https://evil.example.com",
    });
    const res = makeRes();

    const blocked = await applyCsrfGate(req, res);

    expect(blocked).toBe(false);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});
