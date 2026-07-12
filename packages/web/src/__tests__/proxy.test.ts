import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

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
});
