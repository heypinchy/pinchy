import { describe, it, expect, vi } from "vitest";
import { seedSessionCache } from "@/server/session-cache-seeder";
import { SessionCache } from "@/server/session-cache";

describe("seedSessionCache", () => {
  it("should populate session cache from OpenClaw sessions list", async () => {
    const mockClient = {
      sessions: {
        list: vi.fn().mockResolvedValue({
          sessions: [
            { key: "agent:agent-1:direct:user-1" },
            { key: "agent:agent-2:direct:user-2" },
          ],
        }),
      },
    };
    const cache = new SessionCache();

    expect(cache.has("agent:agent-1:direct:user-1")).toBe(false);
    expect(cache.has("agent:agent-2:direct:user-2")).toBe(false);

    await seedSessionCache(mockClient as any, cache);

    expect(cache.has("agent:agent-1:direct:user-1")).toBe(true);
    expect(cache.has("agent:agent-2:direct:user-2")).toBe(true);
    expect(mockClient.sessions.list).toHaveBeenCalledOnce();
  });

  it("should not throw when sessions.list fails", async () => {
    const mockClient = {
      sessions: {
        list: vi.fn().mockRejectedValue(new Error("Connection timeout")),
      },
    };
    const cache = new SessionCache();

    await expect(seedSessionCache(mockClient as any, cache)).resolves.not.toThrow();
    expect(cache.has("agent:agent-1:direct:user-1")).toBe(false);
  });

  it("should handle empty sessions list gracefully", async () => {
    const mockClient = {
      sessions: {
        list: vi.fn().mockResolvedValue({ sessions: [] }),
      },
    };
    const cache = new SessionCache();

    await seedSessionCache(mockClient as any, cache);

    expect(cache.has("agent:any:direct:user-1")).toBe(false);
  });

  it("should handle missing sessions field in response gracefully", async () => {
    const mockClient = {
      sessions: {
        list: vi.fn().mockResolvedValue({}),
      },
    };
    const cache = new SessionCache();

    await seedSessionCache(mockClient as any, cache);
    // No throw = success, cache remains empty
    expect(cache.has("agent:any:direct:user-1")).toBe(false);
  });

  it("should not overwrite existing cache entries when seeding", async () => {
    const mockClient = {
      sessions: {
        list: vi.fn().mockResolvedValue({
          sessions: [{ key: "agent:agent-2:direct:user-2" }],
        }),
      },
    };
    const cache = new SessionCache();
    cache.add("agent:agent-1:direct:user-1"); // pre-existing entry

    await seedSessionCache(mockClient as any, cache);

    // Both old and new entries should exist
    expect(cache.has("agent:agent-1:direct:user-1")).toBe(true);
    expect(cache.has("agent:agent-2:direct:user-2")).toBe(true);
  });
});
