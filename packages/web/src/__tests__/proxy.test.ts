import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy, config } from "@/proxy";

describe("proxy", () => {
  it("stamps the request path + query onto the x-pathname header", () => {
    const request = new NextRequest("https://app.example.com/share?share_id=abc");

    const response = proxy(request);

    expect(response.headers.get("x-middleware-request-x-pathname")).toBe("/share?share_id=abc");
  });

  it("does not let a client-supplied x-pathname header leak through unchanged", () => {
    const request = new NextRequest("https://app.example.com/agents", {
      headers: { "x-pathname": "//evil.com" },
    });

    const response = proxy(request);

    expect(response.headers.get("x-middleware-request-x-pathname")).toBe("/agents");
  });

  it("captures a bare path with no query string", () => {
    const request = new NextRequest("https://app.example.com/agents");

    const response = proxy(request);

    expect(response.headers.get("x-middleware-request-x-pathname")).toBe("/agents");
  });

  it("excludes the service worker + manifest static assets from the matcher", () => {
    const [pattern] = config.matcher;
    // These are served straight from /public and never need the returnTo
    // header; running the proxy on them is pointless and inconsistent with
    // the deliberate sw.js exclusion.
    expect(pattern).toContain("sw.js");
    expect(pattern).toContain("sw-share-target.js");
    expect(pattern).toContain("manifest.webmanifest");
  });
});
