import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsIntegrations } from "@/components/settings-integrations";

// Wiring test for the integrations-card icon: a GitHub MCP connection must
// render the GitHub brand icon, not a fallback another type happens to use.
// The icon identity itself is covered by integration-types.test.tsx; this
// test pins that the card extracts the preset from conn.data and feeds it to
// getConnectionIcon.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/lib/integrations/odoo-sync", () => ({
  getAccessibleCategoryLabels: () => [],
}));

function makeMcpConnection(overrides: Record<string, unknown> = {}) {
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

function mockFetchConnections(connections: unknown[]) {
  return vi.spyOn(global, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.startsWith("/api/integrations")) {
      return Promise.resolve({ ok: true, json: async () => connections } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  });
}

describe("SettingsIntegrations — connection card icons", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("renders the preset's brand icon for an MCP connection", async () => {
    fetchSpy = mockFetchConnections([makeMcpConnection()]);
    render(<SettingsIntegrations />);

    const iconWrapper = await screen.findByText(
      (_, el) => el?.getAttribute("data-connection-icon") === "github"
    );
    expect(iconWrapper).toBeInTheDocument();
  });

  it("renders the neutral MCP icon for an unrecognized preset (never a stale brand icon)", async () => {
    fetchSpy = mockFetchConnections([
      makeMcpConnection({ data: { preset: "some-future-preset" } }),
    ]);
    render(<SettingsIntegrations />);

    const iconWrapper = await screen.findByText(
      (_, el) => el?.getAttribute("data-connection-icon") === "some-future-preset"
    );
    expect(iconWrapper).toBeInTheDocument();
  });
});

describe("SettingsIntegrations — Add Integration navigation", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => [] } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links 'Add Integration' to the /settings/integrations/new picker page", async () => {
    render(<SettingsIntegrations />);

    const link = await screen.findByRole("link", { name: /Add Integration/i });
    expect(link).toHaveAttribute("href", "/settings/integrations/new");
  });

  it("links the empty-state 'Add your first integration' to the same picker page", async () => {
    render(<SettingsIntegrations />);

    const link = await screen.findByRole("link", { name: /Add your first integration/i });
    expect(link).toHaveAttribute("href", "/settings/integrations/new");
  });
});
