import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/health/route";
import { NextRequest } from "next/server";

describe("GET /api/health", () => {
  it("should return 200 with status ok", async () => {
    const request = new NextRequest("http://localhost/api/health", { method: "GET" });
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ status: "ok" });
  });

  it("should return JSON content type", async () => {
    const request = new NextRequest("http://localhost/api/health", { method: "GET" });
    const response = await GET(request);
    const contentType = response.headers.get("content-type");
    expect(contentType).toContain("application/json");
  });
});
