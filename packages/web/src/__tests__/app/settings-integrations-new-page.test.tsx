import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Server-component test for /settings/integrations/new.
 *
 * This page is where the MCP feature flag ENTERS the client tree. The flag is
 * a server-side RUNTIME value (PINCHY_MCP_ENABLED, read live from process.env
 * by isMcpEnabled()), and Pinchy ships as a prebuilt image — so it must NOT be
 * resolved via a build-time-inlined NEXT_PUBLIC_* var. Baking it at build time
 * produced a silent half-state: an operator setting PINCHY_MCP_ENABLED=1 at
 * runtime armed the API while the UI stayed dark forever.
 *
 * These tests pin that the runtime value is read per-request and handed down
 * as a plain prop — the same idiom app/(app)/usage/page.tsx uses for the
 * (equally server-side, equally runtime) enterprise license flag.
 */

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({}),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import NewIntegrationPage from "@/app/(app)/settings/integrations/new/page";

describe("NewIntegrationPage (server component)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects non-admin users to the integrations tab", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-1", role: "member" } });

    await expect(NewIntegrationPage()).rejects.toThrow("REDIRECT:/settings?tab=integrations");
  });

  it("redirects unauthenticated users to the integrations tab", async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(NewIntegrationPage()).rejects.toThrow("REDIRECT:/settings?tab=integrations");
  });

  it("passes mcpEnabled=true down when PINCHY_MCP_ENABLED=1 at request time", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");

    const element = await NewIntegrationPage();

    expect(element.props.mcpEnabled).toBe(true);
  });

  it("passes mcpEnabled=false down when PINCHY_MCP_ENABLED is unset", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", undefined);

    const element = await NewIntegrationPage();

    expect(element.props.mcpEnabled).toBe(false);
  });

  it("re-reads the flag per request rather than caching it at module load", async () => {
    // The regression this guards: a build-time-inlined flag would freeze the
    // first value forever. Flipping the env between two renders must flip the
    // prop — that is the whole difference between a runtime and a build-time
    // flag, and it is invisible in any single-render test.
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    expect((await NewIntegrationPage()).props.mcpEnabled).toBe(true);

    vi.stubEnv("PINCHY_MCP_ENABLED", "0");
    expect((await NewIntegrationPage()).props.mcpEnabled).toBe(false);
  });
});
