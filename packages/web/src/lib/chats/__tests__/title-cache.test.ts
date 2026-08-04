import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getCachedChatTitle,
  setCachedChatTitle,
  getTitleCacheSizeForTest,
  resetTitleCacheForTest,
} from "@/lib/chats/title-cache";

describe("title cache", () => {
  beforeEach(() => {
    resetTitleCacheForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for a session that was never cached", () => {
    expect(getCachedChatTitle("never-seen")).toBeUndefined();
  });

  it("returns the cached title (including a cached null) on a fresh entry", () => {
    setCachedChatTitle("session-1", "Hello there");
    expect(getCachedChatTitle("session-1")).toBe("Hello there");

    setCachedChatTitle("session-2", null);
    expect(getCachedChatTitle("session-2")).toBeNull();
  });

  it("expires an entry past the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    setCachedChatTitle("session-1", "Hello there");
    expect(getCachedChatTitle("session-1")).toBe("Hello there");

    vi.setSystemTime(60_001);
    expect(getCachedChatTitle("session-1")).toBeUndefined();
  });

  // Regression for the unbounded-growth finding: the TTL above was only ever
  // checked on read, never evicted on its own, so a long-lived process reading
  // an ever-growing set of distinct sessionIds accumulated an entry per
  // sessionId forever, expired or not.
  it("evicts the oldest entry once the cache exceeds its size cap", () => {
    const CAP = 500;

    for (let i = 0; i < CAP; i++) {
      setCachedChatTitle(`session-${i}`, `title-${i}`);
    }
    expect(getTitleCacheSizeForTest()).toBe(CAP);

    // One more insert must evict, not grow past the cap.
    setCachedChatTitle("session-overflow", "title-overflow");
    expect(getTitleCacheSizeForTest()).toBe(CAP);

    // The oldest entry (session-0) is the one that got evicted.
    expect(getCachedChatTitle("session-0")).toBeUndefined();
    // The newest entries, including the one that triggered eviction, survive.
    expect(getCachedChatTitle("session-overflow")).toBe("title-overflow");
    expect(getCachedChatTitle(`session-${CAP - 1}`)).toBe(`title-${CAP - 1}`);
  });

  it("never grows past the cap across many more inserts than the cap", () => {
    for (let i = 0; i < 2000; i++) {
      setCachedChatTitle(`session-${i}`, `title-${i}`);
    }
    expect(getTitleCacheSizeForTest()).toBeLessThanOrEqual(500);
  });
});
