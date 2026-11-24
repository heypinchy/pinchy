import { describe, expect, it, afterEach, vi } from "vitest";
import { isMcpEnabled } from "@/lib/feature-flags";

// There is deliberately no client-side counterpart to isMcpEnabled(). A
// NEXT_PUBLIC_* flag is inlined at BUILD time, and Pinchy ships as a prebuilt
// image — an operator setting PINCHY_MCP_ENABLED=1 at runtime would arm the
// API while the UI stayed dark forever. The UI gets the flag as a prop from
// the server components that render it; see
// __tests__/app/settings-integrations-new-page.test.tsx.
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

  it("re-reads process.env on every call rather than capturing it at module load", () => {
    // The flag must stay a live runtime read: server components call this per
    // request, and a cached value would resurrect the build-time-flag bug in a
    // new place.
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    expect(isMcpEnabled()).toBe(true);
    vi.stubEnv("PINCHY_MCP_ENABLED", "0");
    expect(isMcpEnabled()).toBe(false);
  });
});
