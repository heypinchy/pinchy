import { describe, expect, it, afterEach, vi } from "vitest";
import { isMcpEnabled } from "@/lib/feature-flags";

describe("isMcpEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false when PINCHY_MCP_ENABLED is unset", () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", undefined);
    expect(isMcpEnabled()).toBe(false);
  });

  it("is false for any value other than the literal string '1'", () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "true");
    expect(isMcpEnabled()).toBe(false);
  });

  it("is true when PINCHY_MCP_ENABLED=1", () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    expect(isMcpEnabled()).toBe(true);
  });
});
