import { describe, it, expect, afterEach, vi } from "vitest";
import { internalApiBaseUrl } from "@/lib/openclaw-config/build";

/**
 * `internalApiBaseUrl()` is the single source of truth for the callback URL
 * OpenClaw uses to reach Pinchy — it lands in every pinchy-* plugin entry's
 * `apiBaseUrl` and in the MCP proxy URL inside `mcp.servers`. It replaced 8
 * verbatim copies of the same env-fallback chain in build.ts; these tests pin
 * the three branches so the consolidated version can't silently drift from
 * what those copies did.
 */
describe("internalApiBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers PINCHY_INTERNAL_URL verbatim when set", () => {
    vi.stubEnv("PINCHY_INTERNAL_URL", "http://pinchy-staging.internal:8080");
    expect(internalApiBaseUrl()).toBe("http://pinchy-staging.internal:8080");
  });

  it("PINCHY_INTERNAL_URL wins even when PORT is also set", () => {
    vi.stubEnv("PINCHY_INTERNAL_URL", "http://override:9999");
    vi.stubEnv("PORT", "1234");
    expect(internalApiBaseUrl()).toBe("http://override:9999");
  });

  it("falls back to the compose service host on PORT when PINCHY_INTERNAL_URL is unset", () => {
    vi.stubEnv("PINCHY_INTERNAL_URL", undefined);
    vi.stubEnv("PORT", "1234");
    expect(internalApiBaseUrl()).toBe("http://pinchy:1234");
  });

  it("falls back to port 7777 when neither env var is set", () => {
    vi.stubEnv("PINCHY_INTERNAL_URL", undefined);
    vi.stubEnv("PORT", undefined);
    expect(internalApiBaseUrl()).toBe("http://pinchy:7777");
  });
});
