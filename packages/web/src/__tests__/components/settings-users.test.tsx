import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsUsers } from "@/components/settings-users";

// Mock window.location.origin for invite link generation
Object.defineProperty(window, "location", {
  value: { origin: "http://localhost:7777" },
  writable: true,
});

describe("SettingsUsers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockUsers = [
    {
      id: "user-1",
      name: "Alice Admin",
      email: "alice@example.com",
      role: "admin",
      deletedAt: null,
    },
    { id: "user-2", name: "Bob User", email: "bob@example.com", role: "user", deletedAt: null },
    { id: "user-3", name: "Carol User", email: "carol@example.com", role: "user", deletedAt: null },
  ];

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function renderWithUsersLoaded() {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ users: mockUsers }),
    } as Response);

    render(<SettingsUsers currentUserId="user-1" />);
  }

  it("should render user list table with name, email, and role columns", async () => {
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("Alice Admin").length).toBeGreaterThanOrEqual(1);
    });

    // Scope to the desktop table view
    const table = screen.getByRole("table");
    const tableView = within(table);
    expect(tableView.getByText("Alice Admin")).toBeInTheDocument();
    expect(tableView.getByText("bob@example.com")).toBeInTheDocument();
    expect(tableView.getByText("carol@example.com")).toBeInTheDocument();
    expect(tableView.getByText("admin")).toBeInTheDocument();
    expect(tableView.getAllByText("user").length).toBeGreaterThanOrEqual(2);
  });

  it("should render Invite User button", async () => {
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Invite User" })).toBeInTheDocument();
    });
  });

  it("should open invite dialog when Invite User is clicked", async () => {
    const user = userEvent.setup();
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Invite User" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Invite User" }));

    await waitFor(() => {
      expect(
        screen.getByText("Invite User", { selector: "[data-slot='dialog-title']" })
      ).toBeInTheDocument();
    });
  });

  it("should show role selection in invite dialog", async () => {
    const user = userEvent.setup();
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Invite User" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Invite User" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Role")).toBeInTheDocument();
    });
  });

  it("should not show Deactivate button for the current user", async () => {
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("Alice Admin").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const tableView = within(table);

    // Find the row for Alice (current user) - should not have a Deactivate button
    const aliceRow = tableView.getByText("Alice Admin").closest("tr")!;
    expect(within(aliceRow).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();

    // Other users should have Deactivate buttons
    const bobRow = tableView.getByText("Bob User").closest("tr")!;
    expect(within(bobRow).getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
  });

  it("should show Reset button per user (not for current user)", async () => {
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("Alice Admin").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const tableView = within(table);

    const aliceRow = tableView.getByText("Alice Admin").closest("tr")!;
    expect(within(aliceRow).queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();

    const bobRow = tableView.getByText("Bob User").closest("tr")!;
    expect(within(bobRow).getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("should call DELETE /api/users/:id when delete is confirmed", async () => {
    const user = userEvent.setup();
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("Bob User").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const bobRow = within(table).getByText("Bob User").closest("tr")!;
    await user.click(within(bobRow).getByRole("button", { name: "Deactivate" }));

    // Confirmation dialog should appear
    await waitFor(() => {
      expect(screen.getByText("Deactivate User")).toBeInTheDocument();
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    // Also mock the re-fetch of user list
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ users: [mockUsers[0], mockUsers[2]] }),
    } as Response);

    await user.click(screen.getByRole("button", { name: "Confirm Deactivate" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/users/user-2", {
        method: "DELETE",
      });
    });
  });

  it("should call POST /api/users/:id/reset and show reset link", async () => {
    const user = userEvent.setup();
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("Bob User").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const bobRow = within(table).getByText("Bob User").closest("tr")!;

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "reset-token-123" }),
    } as Response);

    await user.click(within(bobRow).getByRole("button", { name: "Reset" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/users/user-2/reset", {
        method: "POST",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("http://localhost:7777/invite/reset-token-123")).toBeInTheDocument();
    });
  });

  it("should create invite and show invite link with Copy button", async () => {
    const user = userEvent.setup();
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Invite User" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Invite User" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Role")).toBeInTheDocument();
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "invite-token-abc" }),
    } as Response);

    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "", role: "user" }),
      });
    });

    await waitFor(() => {
      expect(screen.getByText("http://localhost:7777/invite/invite-token-abc")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("should show loading state while fetching users", () => {
    vi.mocked(global.fetch).mockReturnValueOnce(new Promise(() => {}));

    render(<SettingsUsers currentUserId="user-1" />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  describe("deactivated user", () => {
    const deactivatedUser = {
      id: "user-4",
      name: "Dave Deactivated",
      email: "dave@example.com",
      role: "user",
      deletedAt: "2024-01-15T10:00:00.000Z",
    };

    function renderWithDeactivatedUser() {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ users: [...mockUsers, deactivatedUser] }),
      } as Response);

      render(<SettingsUsers currentUserId="user-1" />);
    }

    it("should show Reactivate button instead of Deactivate for a deactivated user", async () => {
      renderWithDeactivatedUser();

      await waitFor(() => {
        expect(screen.getAllByText("Dave Deactivated").length).toBeGreaterThanOrEqual(1);
      });

      const table = screen.getByRole("table");
      const daveRow = within(table).getByText("Dave Deactivated").closest("tr")!;
      expect(within(daveRow).getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
      expect(within(daveRow).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    });

    it("should render a deactivated user row with opacity-50 class", async () => {
      renderWithDeactivatedUser();

      await waitFor(() => {
        expect(screen.getAllByText("Dave Deactivated").length).toBeGreaterThanOrEqual(1);
      });

      const table = screen.getByRole("table");
      const daveRow = within(table).getByText("Dave Deactivated").closest("tr")!;
      expect(daveRow).toHaveClass("opacity-50");
    });

    it("should show deactivated badge for a deactivated user", async () => {
      renderWithDeactivatedUser();

      await waitFor(() => {
        expect(screen.getAllByText("Dave Deactivated").length).toBeGreaterThanOrEqual(1);
      });

      const table = screen.getByRole("table");
      const daveRow = within(table).getByText("Dave Deactivated").closest("tr")!;
      expect(within(daveRow).getByText("deactivated")).toBeInTheDocument();
    });

    it("should call POST /api/users/:id/reactivate when Reactivate is clicked", async () => {
      const user = userEvent.setup();
      renderWithDeactivatedUser();

      await waitFor(() => {
        expect(screen.getAllByText("Dave Deactivated").length).toBeGreaterThanOrEqual(1);
      });

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      // Also mock the re-fetch of user list after reactivation
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ users: [...mockUsers, { ...deactivatedUser, deletedAt: null }] }),
      } as Response);

      const table = screen.getByRole("table");
      const daveRow = within(table).getByText("Dave Deactivated").closest("tr")!;
      await user.click(within(daveRow).getByRole("button", { name: "Reactivate" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/users/user-4/reactivate", {
          method: "POST",
        });
      });
    });
  });
});
