import { describe, it, expect, afterEach } from "vitest";
import { hasFields, isMap, processWideCache } from "@/lib/process-wide-cache";

const KEY = "__pinchyProcessWideCacheTest" as const;
const store = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete store[KEY];
});

describe("processWideCache", () => {
  it("returns the same value on every call, stored on globalThis", () => {
    const first = processWideCache(KEY, () => new Map<string, number>(), isMap);
    first.set("a", 1);

    const second = processWideCache(KEY, () => new Map<string, number>(), isMap);

    expect(second).toBe(first);
    expect(store[KEY]).toBe(first);
  });

  it("replaces a value an older module version left in another shape", () => {
    // A dev server that was running before the cache changed shape.
    store[KEY] = { cachedResult: ["stale"] };

    const value = processWideCache(KEY, () => ({ result: null, at: 0 }), hasFields("result", "at"));

    expect(value).toEqual({ result: null, at: 0 });
    expect(store[KEY]).toBe(value);
  });

  it("replaces a non-Map left under a Map cache's key", () => {
    store[KEY] = {};

    const value = processWideCache(KEY, () => new Map(), isMap);

    expect(value).toBeInstanceOf(Map);
  });
});
