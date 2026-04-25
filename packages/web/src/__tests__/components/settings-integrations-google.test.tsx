import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsIntegrations } from "@/components/settings-integrations";

// Mock sonner
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Mock odoo-sync — getAccessibleCategoryLabels is called for Odoo connections
vi.mock("@/lib/integrations/odoo-sync", () => ({
  getAccessibleCategoryLabels: () => [],
}));

const googleConnection = {
  id: "conn-google-1",
  type: "google",
  name: "invoices@company.com",
  description: "",
  credentials: "encrypted",
  status: "active",
  data: {
    emailAddress: "invoices@company.com",
    provider: "gmail",
    connectedAt: "2026-04-13T12:00:00Z",
  },
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
};

const pendingGoogleConnection = {
  id: "conn-google-pending",
  type: "google",
  name: "Google (connecting…)",
  description: "",
  credentials: "encrypted",
  status: "pending",
  data: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
};

const odooConnection = {
  id: "conn-odoo-1",
  type: "odoo",
  name: "Production ERP",
  description: "",
  credentials: "encrypted",
  status: "active",
  data: { lastSyncAt: "2026-04-13T12:00:00Z", categories: [] },
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
};

function mockFetchConnections(connections: unknown[]) {
  return vi.spyOn(global, "fetch").mockImplementation(() =>
    Promise.resolve({
      ok: true,
      json: async () => connections,
    } as Response)
  );
}

describe("SettingsIntegrations — type-aware rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders both Google and Odoo connection names", async () => {
    const fetchSpy = mockFetchConnections([googleConnection, odooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("invoices@company.com")).toBeInTheDocument();
      expect(screen.getByText("Production ERP")).toBeInTheDocument();
    });

    fetchSpy.mockRestore();
  });

  it("shows 'Connected' status for Google connections", async () => {
    const fetchSpy = mockFetchConnections([googleConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("invoices@company.com")).toBeInTheDocument();
    });

    // Google connections should show "Connected" status text
    expect(screen.getByText("Connected")).toBeInTheDocument();

    // Google connections should NOT show sync-related text
    expect(screen.queryByText(/categor/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not synced yet/i)).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("shows Odoo-specific actions (Test Connection, Sync Schema) in dropdown for Odoo connections", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([odooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Production ERP")).toBeInTheDocument();
    });

    // Open the dropdown menu
    const row = screen.getByText("Production ERP").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    // Odoo connections should have Test Connection and Sync Schema
    expect(screen.getByText("Test Connection")).toBeInTheDocument();
    expect(screen.getByText("Sync Schema")).toBeInTheDocument();

    // Odoo connections should NOT have Edit OAuth Credentials
    expect(screen.queryByText("Edit OAuth Credentials")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("shows 'Edit OAuth Credentials' in dropdown for Google connections, NOT Test/Sync", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([googleConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("invoices@company.com")).toBeInTheDocument();
    });

    // Open the dropdown menu
    const row = screen.getByText("invoices@company.com").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    // Google connections should have Edit OAuth Credentials
    expect(screen.getByText("Edit OAuth Credentials")).toBeInTheDocument();

    // Google connections should have Rename and Delete
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();

    // Google connections should NOT have Test Connection or Sync Schema
    expect(screen.queryByText("Test Connection")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync Schema")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });
});

describe("SettingsIntegrations — agent usage count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows 'Used by N agents' for connections with agentUsageCount > 0", async () => {
    const fetchSpy = mockFetchConnections([
      { ...odooConnection, id: "c1", name: "Prod", agentUsageCount: 3 },
      { ...odooConnection, id: "c2", name: "Dev", agentUsageCount: 0 },
    ]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Prod")).toBeInTheDocument();
    });

    expect(screen.getByText(/used by 3 agents/i)).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("does not show 'Used by' for connections with agentUsageCount === 0", async () => {
    const fetchSpy = mockFetchConnections([
      { ...odooConnection, id: "c1", name: "Prod", agentUsageCount: 3 },
      { ...odooConnection, id: "c2", name: "Dev", agentUsageCount: 0 },
    ]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Dev")).toBeInTheDocument();
    });

    expect(screen.getAllByText(/used by/i)).toHaveLength(1);

    fetchSpy.mockRestore();
  });
});

describe("SettingsIntegrations — pending Google connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows 'Setup in progress' badge for pending Google connection", async () => {
    const fetchSpy = mockFetchConnections([pendingGoogleConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Google (connecting…)")).toBeInTheDocument();
    });

    expect(screen.getByText("Setup in progress")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("shows 'Continue setup' and 'Remove' in dropdown for pending Google connection", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([pendingGoogleConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Google (connecting…)")).toBeInTheDocument();
    });

    const row = screen.getByText("Google (connecting…)").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.getByText("Continue setup")).toBeInTheDocument();
    expect(screen.getByText("Remove")).toBeInTheDocument();

    // Should NOT show Rename or Edit OAuth Credentials
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
    expect(screen.queryByText("Edit OAuth Credentials")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("clicking 'Continue setup' opens AddIntegrationDialog", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([pendingGoogleConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Google (connecting…)")).toBeInTheDocument();
    });

    const row = screen.getByText("Google (connecting…)").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    await user.click(screen.getByText("Continue setup"));

    // AddIntegrationDialog should be open — look for dialog title or integration type buttons
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    fetchSpy.mockRestore();
  });
});
