import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Server-component test for /settings.
 *
 * Sibling of settings-integrations-new-page.test.tsx: this is the second place
 * the MCP feature flag enters the client tree (settings → SettingsPageContent
 * → SettingsIntegrations → AddIntegrationDialog). Same contract, same reason —
 * PINCHY_MCP_ENABLED is a server-side runtime value and must be read per
 * request, never inlined at build time.
 */

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({}),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock("@/lib/enterprise", () => ({
  getLicenseStatus: vi.fn().mockResolvedValue({ active: false, features: [], ver: 1, maxUsers: 0 }),
  isKeyFromEnv: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/seat-usage", () => ({
  getSeatUsage: vi.fn().mockResolvedValue({ used: 0 }),
}));

vi.mock("@/lib/gated-config", () => ({
  hasGatedConfig: vi.fn().mockResolvedValue(false),
}));

import SettingsPage from "@/app/(app)/settings/page";

const searchParams = Promise.resolve({});

describe("SettingsPage (server component)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes mcpEnabled=true to the settings content when PINCHY_MCP_ENABLED=1", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");

    const element = await SettingsPage({ searchParams });

    expect(element.props.mcpEnabled).toBe(true);
  });

  it("passes mcpEnabled=false to the settings content when PINCHY_MCP_ENABLED is unset", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", undefined);

    const element = await SettingsPage({ searchParams });

    expect(element.props.mcpEnabled).toBe(false);
  });
});
