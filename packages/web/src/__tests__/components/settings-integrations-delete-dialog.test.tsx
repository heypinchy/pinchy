import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { SettingsIntegrations } from "@/components/settings-integrations";

// Mock sonner
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Mock odoo-sync — getAccessibleCategoryLabels is called for Odoo connections
vi.mock("@/lib/integrations/odoo-sync", () => ({
  getAccessibleCategoryLabels: () => [],
}));

const devConnection = {
  id: "c2",
  type: "odoo",
  name: "Dev",
  description: "",
  credentials: "encrypted",
  status: "active",
  data: { lastSyncAt: "2026-04-13T12:00:00Z", categories: [] },
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
  agentUsageCount: 0,
};

const prodConnection = {
  id: "c1",
  type: "odoo",
  name: "Prod",
  description: "",
  credentials: "encrypted",
  status: "active",
  data: { lastSyncAt: "2026-04-13T12:00:00Z", categories: [] },
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
  agentUsageCount: 3,
};

/** Open the dropdown for the row containing `connectionName` and click Delete. */
async function clickDeleteInDropdown(
  user: ReturnType<typeof userEvent.setup>,
  connectionName: string
) {
  const row = screen.getByText(connectionName).closest("[class*='rounded-lg']")!;
  const buttons = row.querySelectorAll("button");
  const menuButton = buttons[buttons.length - 1];
  await user.click(menuButton);
  await user.click(screen.getByRole("menuitem", { name: /^delete$/i }));
}

describe("SettingsIntegrations — delete dialog state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Task 11: Dialog loads usage and renders "Delete?" at zero agents
  it("shows plain Delete view when no agents use the integration", async () => {
    const user = userEvent.setup();
    global.fetch = vi
      .fn()
      // Call 1: mount fetchConnections
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [devConnection, prodConnection],
      })
      // Call 2: preflight usage check
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ agents: [] }),
      }) as unknown as typeof fetch;

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Dev")).toBeInTheDocument();
    });

    await clickDeleteInDropdown(user, "Dev");

    expect(await screen.findByRole("button", { name: /^delete$/i })).toBeInTheDocument();
    expect(screen.queryByText(/detach & delete/i)).not.toBeInTheDocument();
  });

  // Task 12: Detach view with agent list and "Detach & Delete" button
  it("shows detach view with agent names and calls /with-permissions on confirm", async () => {
    const user = userEvent.setup();
    global.fetch = vi
      .fn()
      // Call 1: mount fetchConnections
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [devConnection, prodConnection],
      })
      // Call 2: preflight usage check — returns 2 agents
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          agents: [
            { id: "a1", name: "Smithers" },
            { id: "a2", name: "Sales Bot" },
          ],
        }),
      })
      // Call 3: DELETE /with-permissions
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      })
      // Call 4: fetchConnections refresh after delete
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      }) as unknown as typeof fetch;

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Prod")).toBeInTheDocument();
    });

    await clickDeleteInDropdown(user, "Prod");

    expect(await screen.findByText(/smithers/i)).toBeInTheDocument();
    expect(screen.getByText(/sales bot/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /detach & delete/i }));

    const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls[2][0]).toMatch(/\/api\/integrations\/c1\/with-permissions/);
    expect(fetchCalls[2][1]).toMatchObject({ method: "DELETE" });
  });

  // Task 13: TOCTOU 409 after preflight shows toast + refresh
  it("shows retry toast when strict DELETE returns 409 after preflight said 0 agents", async () => {
    const user = userEvent.setup();
    const toastError = vi.spyOn(toast, "error");

    global.fetch = vi
      .fn()
      // Call 1: mount fetchConnections
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [devConnection, prodConnection],
      })
      // Call 2: preflight says 0 agents
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ agents: [] }),
      })
      // Call 3: strict DELETE returns 409 (TOCTOU)
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: "Integration has active permissions",
          agents: [{ id: "a9", name: "Late Arrival" }],
        }),
      })
      // Call 4: fetchConnections refresh after 409
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      }) as unknown as typeof fetch;

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Dev")).toBeInTheDocument();
    });

    await clickDeleteInDropdown(user, "Dev");

    // Wait for the confirm dialog to appear (phase: "confirm")
    await user.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/changed|retry/i));
    toastError.mockRestore();
  });
});
