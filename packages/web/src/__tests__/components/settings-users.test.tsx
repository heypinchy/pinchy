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
      expect(screen.getByText("Alice Admin")).toBeInTheDocument();
    });

    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByText("carol@example.com")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getAllByText("user").length).toBeGreaterThanOrEqual(2);
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

  it("should not show Delete button for the current user", async () => {
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getByText("Alice Admin")).toBeInTheDocument();
    });

    // Find the row for Alice (current user) - should not have a Deactivate button
    const aliceRow = screen.getByText("Alice Admin").closest("tr")!;
    expect(within(aliceRow).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();

    // Other users should have Deactivate buttons
    const bobRow = screen.getByText("Bob User").closest("tr")!;
    expect(within(bobRow).getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
  });

  it("should show Reset button per user (not for current user)", async () => {
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getByText("Alice Admin")).toBeInTheDocument();
    });

    const aliceRow = screen.getByText("Alice Admin").closest("tr")!;
    expect(within(aliceRow).queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();

    const bobRow = screen.getByText("Bob User").closest("tr")!;
    expect(within(bobRow).getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("should call DELETE /api/users/:id when delete is confirmed", async () => {
    const user = userEvent.setup();
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getByText("Bob User")).toBeInTheDocument();
    });

    const bobRow = screen.getByText("Bob User").closest("tr")!;
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
      expect(screen.getByText("Bob User")).toBeInTheDocument();
    });

    const bobRow = screen.getByText("Bob User").closest("tr")!;

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
});
