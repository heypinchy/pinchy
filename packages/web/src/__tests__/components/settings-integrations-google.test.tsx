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
  data: {
    emailAddress: "invoices@company.com",
    provider: "gmail",
    connectedAt: "2026-04-13T12:00:00Z",
  },
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
};

const odooConnection = {
  id: "conn-odoo-1",
  type: "odoo",
  name: "Production ERP",
  description: "",
  credentials: "encrypted",
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
