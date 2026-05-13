import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/version/route";

describe("GET /api/version", () => {
  const original = {
    pinchyVersion: process.env.NEXT_PUBLIC_PINCHY_VERSION,
    openclawVersion: process.env.NEXT_PUBLIC_OPENCLAW_VERSION,
    buildSha: process.env.PINCHY_BUILD_SHA,
    nodeEnv: process.env.NODE_ENV,
  };

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_PINCHY_VERSION;
    delete process.env.NEXT_PUBLIC_OPENCLAW_VERSION;
    delete process.env.PINCHY_BUILD_SHA;
  });

  afterEach(() => {
    if (original.pinchyVersion !== undefined)
      process.env.NEXT_PUBLIC_PINCHY_VERSION = original.pinchyVersion;
    if (original.openclawVersion !== undefined)
      process.env.NEXT_PUBLIC_OPENCLAW_VERSION = original.openclawVersion;
    if (original.buildSha !== undefined) process.env.PINCHY_BUILD_SHA = original.buildSha;
    if (original.nodeEnv !== undefined) process.env.NODE_ENV = original.nodeEnv;
  });

  it("returns 200 with JSON", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("returns pinchyVersion from NEXT_PUBLIC_PINCHY_VERSION", async () => {
    process.env.NEXT_PUBLIC_PINCHY_VERSION = "0.5.4";
    const response = await GET();
    const data = await response.json();
    expect(data.pinchyVersion).toBe("0.5.4");
  });

  it("falls back to 'unknown' when NEXT_PUBLIC_PINCHY_VERSION is unset", async () => {
    const response = await GET();
    const data = await response.json();
    expect(data.pinchyVersion).toBe("unknown");
  });

  it("returns openclawVersion from NEXT_PUBLIC_OPENCLAW_VERSION", async () => {
    process.env.NEXT_PUBLIC_OPENCLAW_VERSION = "2026.5.7";
    const response = await GET();
    const data = await response.json();
    expect(data.openclawVersion).toBe("2026.5.7");
  });

  it("falls back to 'unknown' when NEXT_PUBLIC_OPENCLAW_VERSION is unset", async () => {
    const response = await GET();
    const data = await response.json();
    expect(data.openclawVersion).toBe("unknown");
  });

  it("returns build SHA from PINCHY_BUILD_SHA, truncated to 12 chars", async () => {
    process.env.PINCHY_BUILD_SHA = "2a5e9d41d789940778ed8521f54f7cc60a4c9627";
    const response = await GET();
    const data = await response.json();
    expect(data.build).toBe("2a5e9d41d789");
  });

  it("returns build='dev' when PINCHY_BUILD_SHA is unset", async () => {
    const response = await GET();
    const data = await response.json();
    expect(data.build).toBe("dev");
  });

  it("returns nodeEnv from NODE_ENV", async () => {
    process.env.NODE_ENV = "production";
    const response = await GET();
    const data = await response.json();
    expect(data.nodeEnv).toBe("production");
  });

  it("emits Cache-Control: no-store so probes always get fresh data", async () => {
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not include sensitive fields", async () => {
    process.env.NEXT_PUBLIC_PINCHY_VERSION = "0.5.4";
    const response = await GET();
    const data = await response.json();
    const keys = Object.keys(data).sort();
    expect(keys).toEqual(["build", "nodeEnv", "openclawVersion", "pinchyVersion"]);
  });
});
