import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/domain-cache", () => ({
  getCachedDomain: vi.fn(),
}));

import { middleware } from "@/middleware";
import { getCachedDomain } from "@/lib/domain-cache";

describe("domain restriction middleware", () => {
  beforeEach(() => {
    vi.mocked(getCachedDomain).mockReset();
  });

  it("passes through when no domain is cached", () => {
    vi.mocked(getCachedDomain).mockReturnValue(null);

    const req = new NextRequest("http://anything.example.com/dashboard");
    const res = middleware(req);

    expect(res.status).not.toBe(403);
  });

  it("passes through when host matches cached domain", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");

    const req = new NextRequest("http://pinchy.example.com/dashboard", {
      headers: { host: "pinchy.example.com" },
    });
    const res = middleware(req);

    expect(res.status).not.toBe(403);
  });

  it("returns 403 when host does not match cached domain", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");

    const req = new NextRequest("http://evil.example.com/api/settings/domain", {
      headers: { host: "evil.example.com" },
    });
    const res = middleware(req);

    expect(res.status).toBe(403);
  });

  it("passes through when x-forwarded-host matches cached domain", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");

    const req = new NextRequest("http://proxy.internal/dashboard", {
      headers: {
        host: "proxy.internal",
        "x-forwarded-host": "pinchy.example.com",
      },
    });
    const res = middleware(req);

    expect(res.status).not.toBe(403);
  });

  it("always passes /api/health regardless of host", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");

    const req = new NextRequest("http://evil.example.com/api/health", {
      headers: { host: "evil.example.com" },
    });
    const res = middleware(req);

    expect(res.status).not.toBe(403);
  });

  it("always passes /api/setup/status regardless of host", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");

    const req = new NextRequest("http://evil.example.com/api/setup/status", {
      headers: { host: "evil.example.com" },
    });
    const res = middleware(req);

    expect(res.status).not.toBe(403);
  });
});
