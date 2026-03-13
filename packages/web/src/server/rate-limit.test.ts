import { describe, it, expect, afterEach } from "vitest";
import { RateLimiter, getClientIp } from "./rate-limit";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  it("allows requests within the limit", () => {
    limiter = new RateLimiter({ maxEvents: 3, windowMs: 60_000 });
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(true);
  });

  it("blocks requests exceeding the limit", () => {
    limiter = new RateLimiter({ maxEvents: 2, windowMs: 60_000 });
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(false);
    expect(limiter.allow("ip1")).toBe(false);
  });

  it("tracks different keys independently", () => {
    limiter = new RateLimiter({ maxEvents: 1, windowMs: 60_000 });
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip2")).toBe(true);
    expect(limiter.allow("ip1")).toBe(false);
    expect(limiter.allow("ip2")).toBe(false);
  });

  it("resets after window expires", async () => {
    limiter = new RateLimiter({ maxEvents: 1, windowMs: 50 });
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(limiter.allow("ip1")).toBe(true);
  });

  it("remaining() returns correct count", () => {
    limiter = new RateLimiter({ maxEvents: 3, windowMs: 60_000 });
    expect(limiter.remaining("ip1")).toBe(3);
    limiter.allow("ip1");
    expect(limiter.remaining("ip1")).toBe(2);
    limiter.allow("ip1");
    expect(limiter.remaining("ip1")).toBe(1);
    limiter.allow("ip1");
    expect(limiter.remaining("ip1")).toBe(0);
  });
});

describe("getClientIp", () => {
  it("extracts IP from x-forwarded-for header", () => {
    expect(getClientIp({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } })).toBe("1.2.3.4");
  });

  it("falls back to socket remoteAddress", () => {
    expect(getClientIp({ headers: {}, socket: { remoteAddress: "10.0.0.1" } })).toBe("10.0.0.1");
  });

  it("returns 'unknown' when no IP available", () => {
    expect(getClientIp({ headers: {} })).toBe("unknown");
  });
});
