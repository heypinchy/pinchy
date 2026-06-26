import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsIntegrations } from "../settings-integrations";

// Wiring test for the integrations-card icon: a GitHub MCP connection must
// render the GitHub brand icon, not the Odoo fallback the old switch used
// for every type it didn't know. The icon identity itself is covered by
// integration-types.test.tsx; this test pins that the card extracts the
// preset from conn.data and feeds it to getConnectionIcon.

vi.mock("@/hooks/use-integration-actions", () => ({
  useIntegrationActions: () => ({
    syncing: null,
    testing: null,
    handleSync: vi.fn(),
    handleTest: vi.fn(),
    handleDelete: vi.fn(),
    handleRename: vi.fn(),
  }),
}));

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    type: "mcp",
    name: "GitHub",
    description: "",
    credentials: null,
    data: {
      preset: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      tools: [],
      lastSyncAt: new Date().toISOString(),
    },
    status: "active",
    lastError: null,
    lastErrorAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cannotDecrypt: false,
    ...overrides,
  };
}

describe("SettingsIntegrations — connection card icons", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [makeConnection()],
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the preset's brand icon for an MCP connection, not the Odoo fallback", async () => {
    render(<SettingsIntegrations />);

    const iconWrapper = await screen.findByText(
      (_, el) => el?.getAttribute("data-connection-icon") === "github"
    );
    expect(iconWrapper).toBeInTheDocument();
  });
});
