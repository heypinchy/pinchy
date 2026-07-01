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

const authFailedMicrosoftConnection = {
  id: "conn-ms-2",
  type: "microsoft",
  name: "user@outlook.com",
  description: "",
  credentials: "encrypted",
  status: "auth_failed",
  lastError: "401 from Microsoft",
  lastErrorAt: "2026-05-10T10:00:00Z",
  data: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-05-10T10:00:00Z",
  cannotDecrypt: false,
};

function mockFetchConnections(connections: unknown[]) {
  return vi.spyOn(global, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    // The Connected apps section fetches per-provider OAuth app state on mount.
    // These tests only assert connection-list behaviour, so report both
    // providers as unconfigured and route everything else to the connections.
    if (url.startsWith("/api/settings/oauth")) {
      const state = { configured: false, clientId: "", connectionCount: 0 };
      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(state),
        json: async () => state,
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      text: async () => JSON.stringify(connections),
      json: async () => connections,
    } as unknown as Response);
  });
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

    // Exact match: the "Connected apps" section title also contains "Connected",
    // so the loose /Connected/i regex would match two nodes. The connection
    // status label is exactly "Connected".
    expect(screen.getByText("Connected")).toBeInTheDocument();
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

  it("shows a 'Reconnect' menu item in the dropdown for auth_failed Microsoft cards", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([authFailedMicrosoftConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("user@outlook.com")).toBeInTheDocument();
    });

    const row = screen.getByText("user@outlook.com").closest("[class*='rounded-lg']")!;
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

describe("SettingsIntegrations — pending OAuth connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows 'Setup in progress' for Microsoft pending connection", async () => {
    const fetchSpy = mockFetchConnections([
      {
        id: "ms-pending-1",
        type: "microsoft",
        name: "Microsoft (connecting...)",
        description: "",
        credentials: "{}",
        status: "pending",
        lastError: null,
        lastErrorAt: null,
        data: null,
        createdAt: "2026-06-30T10:00:00Z",
        updatedAt: "2026-06-30T10:00:00Z",
        cannotDecrypt: false,
      },
    ]);
    render(<SettingsIntegrations />);
    await waitFor(() => {
      expect(screen.getByText("Setup in progress")).toBeInTheDocument();
    });
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it("shows 'Setup in progress' for Google pending connection (existing behavior preserved)", async () => {
    const fetchSpy = mockFetchConnections([
      {
        id: "goog-pending-1",
        type: "google",
        name: "Google (connecting...)",
        description: "",
        credentials: "{}",
        status: "pending",
        lastError: null,
        lastErrorAt: null,
        data: null,
        createdAt: "2026-06-30T10:00:00Z",
        updatedAt: "2026-06-30T10:00:00Z",
        cannotDecrypt: false,
      },
    ]);
    render(<SettingsIntegrations />);
    await waitFor(() => {
      expect(screen.getByText("Setup in progress")).toBeInTheDocument();
    });
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
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
        "Could not fetch your account profile. Check that your OAuth app grants the required profile permission."
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
