import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsIntegrations } from "@/components/settings-integrations";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/lib/integrations/odoo-sync", () => ({
  getAccessibleCategoryLabels: () => [],
}));

const activeOdooConnection = {
  id: "conn-odoo-1",
  type: "odoo",
  name: "Production ERP",
  description: "",
  credentials: "encrypted",
  status: "active",
  lastError: null,
  lastErrorAt: null,
  data: { lastSyncAt: "2026-04-13T12:00:00Z", categories: [] },
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
};

const authFailedOdooConnection = {
  id: "conn-odoo-2",
  type: "odoo",
  name: "Staging ERP",
  description: "",
  credentials: "encrypted",
  status: "auth_failed",
  lastError: "401 from Odoo",
  lastErrorAt: "2026-05-10T10:00:00Z",
  data: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-05-10T10:00:00Z",
  cannotDecrypt: false,
};

function mockFetchConnections(connections: unknown[]) {
  return vi.spyOn(global, "fetch").mockImplementation(() =>
    Promise.resolve({
      ok: true,
      json: async () => connections,
    } as Response)
  );
}

describe("SettingsIntegrations — auth_failed state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a warning icon and 'Authentication failed' label when status is auth_failed", async () => {
    const fetchSpy = mockFetchConnections([authFailedOdooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Staging ERP")).toBeInTheDocument();
    });

    expect(screen.getByText(/Authentication failed/i)).toBeInTheDocument();

    const warningIcon = document.querySelector("[aria-label='Authentication failed']");
    expect(warningIcon).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("renders lastError text when status is auth_failed", async () => {
    const fetchSpy = mockFetchConnections([authFailedOdooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Staging ERP")).toBeInTheDocument();
    });

    expect(screen.getByText("401 from Odoo")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("renders green check + 'Connected' when status is active", async () => {
    const fetchSpy = mockFetchConnections([activeOdooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Production ERP")).toBeInTheDocument();
    });

    expect(screen.getByText(/Connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/Authentication failed/i)).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("shows a 'Reconnect' menu item in the dropdown for auth_failed cards", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([authFailedOdooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Staging ERP")).toBeInTheDocument();
    });

    const row = screen.getByText("Staging ERP").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.getByText("Reconnect")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("does not show 'Reconnect' for active connections", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([activeOdooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Production ERP")).toBeInTheDocument();
    });

    const row = screen.getByText("Production ERP").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.queryByText("Reconnect")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });
});

describe("SettingsIntegrations — OAuth callback errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a toast with human-readable error when oauthError='profile_fetch_failed'", async () => {
    mockFetchConnections([]);
    const { toast } = await import("sonner");
    render(<SettingsIntegrations oauthError="profile_fetch_failed" />);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Could not fetch your Microsoft profile. Check that your Azure App has User.Read permission."
      );
    });
  });

  it("shows generic error toast for unknown error codes", async () => {
    mockFetchConnections([]);
    const { toast } = await import("sonner");
    render(<SettingsIntegrations oauthError="unknown_code" />);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("OAuth connection failed.");
    });
  });
});
