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
      banned: false,
    },
    { id: "user-2", name: "Bob User", email: "bob@example.com", role: "member", banned: false },
    { id: "user-3", name: "Carol User", email: "carol@example.com", role: "member", banned: false },
  ];

  const mockInvites: unknown[] = [];

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetchForUsers(users: unknown[], invites: unknown[] = mockInvites) {
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/users") {
        return { ok: true, json: async () => ({ users }) } as Response;
      }
      if (String(url) === "/api/users/invites") {
        return { ok: true, json: async () => ({ invites }) } as Response;
      }
      return { ok: false } as Response;
    });
  }

  function renderWithUsersLoaded() {
    mockFetchForUsers(mockUsers);
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
    expect(tableView.getAllByText("member").length).toBeGreaterThanOrEqual(2);
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

  it("should show Reset Password button per user (not for current user)", async () => {
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("Alice Admin").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const tableView = within(table);

    const aliceRow = tableView.getByText("Alice Admin").closest("tr")!;
    expect(
      within(aliceRow).queryByRole("button", { name: "Reset Password" })
    ).not.toBeInTheDocument();

    const bobRow = tableView.getByText("Bob User").closest("tr")!;
    expect(within(bobRow).getByRole("button", { name: "Reset Password" })).toBeInTheDocument();
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

    // Reset fetch mock: DELETE call + re-fetch of both endpoints
    vi.mocked(global.fetch).mockImplementation(async (url, init) => {
      if (String(url) === "/api/users/user-2" && init?.method === "DELETE") {
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      if (String(url) === "/api/users") {
        return {
          ok: true,
          json: async () => ({ users: [mockUsers[0], mockUsers[2]] }),
        } as Response;
      }
      if (String(url) === "/api/users/invites") {
        return { ok: true, json: async () => ({ invites: [] }) } as Response;
      }
      return { ok: false } as Response;
    });

    await user.click(screen.getByRole("button", { name: "Confirm Deactivate" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/users/user-2", {
        method: "DELETE",
      });
    });
  });

  it("should call POST /api/users/:id/reset and show invite link", async () => {
    const user = userEvent.setup();
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("Bob User").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const bobRow = within(table).getByText("Bob User").closest("tr")!;

    vi.mocked(global.fetch).mockImplementation(async (url, init) => {
      if (String(url) === "/api/users/user-2/reset" && init?.method === "POST") {
        return { ok: true, json: async () => ({ token: "reset-token-123" }) } as Response;
      }
      if (String(url) === "/api/users") {
        return { ok: true, json: async () => ({ users: mockUsers }) } as Response;
      }
      if (String(url) === "/api/users/invites") {
        return { ok: true, json: async () => ({ invites: [] }) } as Response;
      }
      return { ok: false } as Response;
    });

    await user.click(within(bobRow).getByRole("button", { name: "Reset Password" }));

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
        body: JSON.stringify({ email: "", role: "member" }),
      });
    });

    await waitFor(() => {
      expect(screen.getByText("http://localhost:7777/invite/invite-token-abc")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("should show loading state while fetching users", () => {
    vi.mocked(global.fetch).mockImplementation(() => new Promise(() => {}));

    render(<SettingsUsers currentUserId="user-1" />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  describe("deactivated user", () => {
    const deactivatedUser = {
      id: "user-4",
      name: "Dave Deactivated",
      email: "dave@example.com",
      role: "member",
      banned: true,
    };

    function renderWithDeactivatedUser() {
      mockFetchForUsers([...mockUsers, deactivatedUser]);
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

      // Reset fetch mock: reactivate call + re-fetch of both endpoints
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        if (String(url) === "/api/users/user-4/reactivate" && init?.method === "POST") {
          return { ok: true, json: async () => ({ success: true }) } as Response;
        }
        if (String(url) === "/api/users") {
          return {
            ok: true,
            json: async () => ({ users: [...mockUsers, { ...deactivatedUser, banned: false }] }),
          } as Response;
        }
        if (String(url) === "/api/users/invites") {
          return { ok: true, json: async () => ({ invites: [] }) } as Response;
        }
        return { ok: false } as Response;
      });

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

  describe("invite rows", () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const pendingInvite = {
      id: "inv-1",
      email: "pending@example.com",
      role: "member",
      type: "invite",
      createdAt: new Date().toISOString(),
      expiresAt: futureDate,
      claimedAt: null,
    };

    const expiredInvite = {
      id: "inv-2",
      email: "expired@example.com",
      role: "member",
      type: "invite",
      createdAt: new Date().toISOString(),
      expiresAt: pastDate,
      claimedAt: null,
    };

    it("should show Revoke button for a pending invite", async () => {
      mockFetchForUsers(mockUsers, [pendingInvite]);
      render(<SettingsUsers currentUserId="user-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("pending@example.com").length).toBeGreaterThanOrEqual(1);
      });

      const table = screen.getByRole("table");
      const inviteRow = within(table).getAllByText("pending@example.com")[0].closest("tr")!;
      expect(within(inviteRow).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    });

    it("should show Resend button for an expired invite", async () => {
      mockFetchForUsers(mockUsers, [expiredInvite]);
      render(<SettingsUsers currentUserId="user-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("expired@example.com").length).toBeGreaterThanOrEqual(1);
      });

      const table = screen.getByRole("table");
      const inviteRow = within(table).getAllByText("expired@example.com")[0].closest("tr")!;
      expect(within(inviteRow).getByRole("button", { name: "Resend" })).toBeInTheDocument();
    });

    it("should show dash for invite name column", async () => {
      mockFetchForUsers(mockUsers, [pendingInvite]);
      render(<SettingsUsers currentUserId="user-1" />);

      await waitFor(() => {
        expect(screen.getByRole("table")).toBeInTheDocument();
      });

      const table = screen.getByRole("table");
      const rows = table.querySelectorAll("tbody tr");
      const inviteRow = Array.from(rows).find((row) =>
        within(row as HTMLElement).queryByRole("button", { name: "Revoke" })
      )!;
      const cells = inviteRow.querySelectorAll("td");
      // Name column shows dash for invites (email is in Email column)
      expect(cells[0].textContent).toBe("\u2014");
    });

    it("should show dash for invite name even without email", async () => {
      const noEmailInvite = { ...pendingInvite, id: "inv-3", email: null };
      mockFetchForUsers(mockUsers, [noEmailInvite]);
      render(<SettingsUsers currentUserId="user-1" />);

      await waitFor(() => {
        expect(screen.getByRole("table")).toBeInTheDocument();
      });

      const table = screen.getByRole("table");
      const rows = table.querySelectorAll("tbody tr");
      const inviteRow = Array.from(rows).find((row) =>
        within(row as HTMLElement).queryByRole("button", { name: "Revoke" })
      )!;
      const cells = inviteRow.querySelectorAll("td");
      expect(cells[0].textContent).toBe("\u2014");
    });

    it("should call DELETE /api/users/invites/:id when Revoke is clicked", async () => {
      const user = userEvent.setup();
      mockFetchForUsers(mockUsers, [pendingInvite]);
      render(<SettingsUsers currentUserId="user-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("pending@example.com").length).toBeGreaterThanOrEqual(1);
      });

      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        if (String(url) === "/api/users/invites/inv-1" && init?.method === "DELETE") {
          return { ok: true, json: async () => ({ success: true }) } as Response;
        }
        if (String(url) === "/api/users") {
          return { ok: true, json: async () => ({ users: mockUsers }) } as Response;
        }
        if (String(url) === "/api/users/invites") {
          return { ok: true, json: async () => ({ invites: [] }) } as Response;
        }
        return { ok: false } as Response;
      });

      const table = screen.getByRole("table");
      const inviteRow = within(table).getAllByText("pending@example.com")[0].closest("tr")!;
      await user.click(within(inviteRow).getByRole("button", { name: "Revoke" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/users/invites/inv-1", {
          method: "DELETE",
        });
      });
    });

    it("should call DELETE then POST when Resend is clicked and show invite link", async () => {
      const user = userEvent.setup();
      mockFetchForUsers(mockUsers, [expiredInvite]);
      render(<SettingsUsers currentUserId="user-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("expired@example.com").length).toBeGreaterThanOrEqual(1);
      });

      const fetchCalls: string[] = [];
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        const key = `${init?.method || "GET"} ${String(url)}`;
        fetchCalls.push(key);
        if (String(url) === "/api/users/invites/inv-2" && init?.method === "DELETE") {
          return { ok: true, json: async () => ({ success: true }) } as Response;
        }
        if (String(url) === "/api/users/invite" && init?.method === "POST") {
          return { ok: true, json: async () => ({ token: "resend-token-xyz" }) } as Response;
        }
        if (String(url) === "/api/users") {
          return { ok: true, json: async () => ({ users: mockUsers }) } as Response;
        }
        if (String(url) === "/api/users/invites") {
          return { ok: true, json: async () => ({ invites: [] }) } as Response;
        }
        return { ok: false } as Response;
      });

      const table = screen.getByRole("table");
      const inviteRow = within(table).getAllByText("expired@example.com")[0].closest("tr")!;
      await user.click(within(inviteRow).getByRole("button", { name: "Resend" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/users/invites/inv-2", {
          method: "DELETE",
        });
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/users/invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "expired@example.com", role: "member" }),
        });
      });

      // DELETE should come before POST
      const deleteIdx = fetchCalls.indexOf("DELETE /api/users/invites/inv-2");
      const postIdx = fetchCalls.indexOf("POST /api/users/invite");
      expect(deleteIdx).toBeLessThan(postIdx);

      await waitFor(() => {
        expect(
          screen.getByText("http://localhost:7777/invite/resend-token-xyz")
        ).toBeInTheDocument();
      });
    });

    it("should render status badges for all statuses", async () => {
      const deactivatedUser = {
        id: "user-4",
        name: "Dave Deactivated",
        email: "dave@example.com",
        role: "member",
        banned: true,
      };
      mockFetchForUsers([...mockUsers, deactivatedUser], [pendingInvite, expiredInvite]);
      render(<SettingsUsers currentUserId="user-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("Alice Admin").length).toBeGreaterThanOrEqual(1);
      });

      const table = screen.getByRole("table");
      const tableView = within(table);

      expect(tableView.getAllByText("active").length).toBeGreaterThanOrEqual(1);
      expect(tableView.getByText("pending")).toBeInTheDocument();
      expect(tableView.getByText("expired")).toBeInTheDocument();
      expect(tableView.getByText("deactivated")).toBeInTheDocument();
    });
  });
});
