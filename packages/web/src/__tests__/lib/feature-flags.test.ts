import { describe, expect, it, afterEach, vi } from "vitest";
import { isMcpEnabled, isMcpEnabledClient } from "@/lib/feature-flags";

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

describe("isMcpEnabledClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false when NEXT_PUBLIC_PINCHY_MCP_ENABLED is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", undefined);
    expect(isMcpEnabledClient()).toBe(false);
  });

  it("is false for any value other than the literal string '1'", () => {
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "true");
    expect(isMcpEnabledClient()).toBe(false);
  });

  it("is true when NEXT_PUBLIC_PINCHY_MCP_ENABLED=1", () => {
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "1");
    expect(isMcpEnabledClient()).toBe(true);
  });
});
