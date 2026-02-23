import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionCache } from "@/server/session-cache";

describe("SessionCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should report unknown key as not existing", () => {
    const cache = new SessionCache();
    expect(cache.has("unknown-key")).toBe(false);
  });

  it("should find key after refresh with sessions list", () => {
    const cache = new SessionCache();
    cache.refresh([{ key: "user:u1:agent:a1" }, { key: "user:u2:agent:a1" }]);
    expect(cache.has("user:u1:agent:a1")).toBe(true);
    expect(cache.has("user:u2:agent:a1")).toBe(true);
    expect(cache.has("user:u3:agent:a1")).toBe(false);
  });

  it("should find key after add()", () => {
    const cache = new SessionCache();
    cache.add("user:u1:agent:a1");
    expect(cache.has("user:u1:agent:a1")).toBe(true);
  });

  it("should report stale when never refreshed", () => {
    const cache = new SessionCache();
    expect(cache.isStale()).toBe(true);
  });

  it("should report not stale immediately after refresh", () => {
    const cache = new SessionCache();
    cache.refresh([]);
    expect(cache.isStale()).toBe(false);
  });

  it("should report stale after TTL expires", () => {
    const cache = new SessionCache(30_000); // 30s TTL
    cache.refresh([]);
    expect(cache.isStale()).toBe(false);

    vi.advanceTimersByTime(30_001);
    expect(cache.isStale()).toBe(true);
  });

  it("should clear cache on clear()", () => {
    const cache = new SessionCache();
    cache.refresh([{ key: "user:u1:agent:a1" }]);
    expect(cache.has("user:u1:agent:a1")).toBe(true);

    cache.clear();
    expect(cache.has("user:u1:agent:a1")).toBe(false);
    expect(cache.isStale()).toBe(true);
  });
});
