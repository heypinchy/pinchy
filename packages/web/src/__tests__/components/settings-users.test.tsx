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

// Radix UI Select uses pointer capture and scrollIntoView which jsdom doesn't support
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

describe("SettingsUsers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockUsers = [
    {
      id: "user-1",
      name: "Alice Admin",
      email: "alice@example.com",
      role: "admin",
      banned: false,
      groups: [{ id: "g1", name: "Engineering" }],
    },
    {
      id: "user-2",
      name: "Bob User",
      email: "bob@example.com",
      role: "member",
      banned: false,
      groups: [
        { id: "g1", name: "Engineering" },
        { id: "g2", name: "Design" },
      ],
    },
    {
      id: "user-3",
      name: "Carol User",
      email: "carol@example.com",
      role: "member",
      banned: false,
      groups: [],
    },
  ];

  const mockInvites: unknown[] = [];

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetchForUsers(
    users: unknown[],
    invites: unknown[] = mockInvites,
    { enterprise = false }: { enterprise?: boolean } = {}
  ) {
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/users") {
        return { ok: true, json: async () => ({ users }) } as Response;
      }
      if (String(url) === "/api/users/invites") {
        return { ok: true, json: async () => ({ invites }) } as Response;
      }
      if (String(url) === "/api/groups") {
        return { ok: true, json: async () => [] } as Response;
      }
      if (String(url) === "/api/enterprise/status") {
        return { ok: true, json: async () => ({ enterprise }) } as Response;
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

  it("should use fixed table layout so truncation works on long names/emails", async () => {
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
    });

    const table = screen.getByRole("table");
    expect(table).toHaveClass("table-fixed");
  });

  it("should set title attributes on name and email cells for tooltip on truncated text", async () => {
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("Alice Admin").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const aliceNameCell = within(table).getByText("Alice Admin").closest("td")!;
    expect(aliceNameCell).toHaveAttribute("title", "Alice Admin");

    const aliceEmailCell = within(table).getByText("alice@example.com").closest("td")!;
    expect(aliceEmailCell).toHaveAttribute("title", "alice@example.com");
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

  it("should not render action buttons in user table rows", async () => {
    renderWithUsersLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("Alice Admin").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const tableView = within(table);

    // No user rows should have action buttons — actions are now in the detail sheet
    const aliceRow = tableView.getByText("Alice Admin").closest("tr")!;
    expect(within(aliceRow).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    expect(
      within(aliceRow).queryByRole("button", { name: "Reset Password" })
    ).not.toBeInTheDocument();

    const bobRow = tableView.getByText("Bob User").closest("tr")!;
    expect(within(bobRow).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    expect(
      within(bobRow).queryByRole("button", { name: "Reset Password" })
    ).not.toBeInTheDocument();
  });

  it("should open user detail sheet when clicking a user row", async () => {
    mockFetchForUsers(mockUsers);
    const user = userEvent.setup();
    render(<SettingsUsers currentUserId="user-1" />);

    await waitFor(() => {
      expect(screen.getAllByText("Alice Admin").length).toBeGreaterThanOrEqual(1);
    });

    await user.click(within(screen.getByRole("table")).getByText("Bob User"));

    // Sheet should open showing Bob's details
    await waitFor(() => {
      // The sheet will show the role select combobox
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });
  });

  it("should show max 2 group badges with '+N more' for users with many groups", async () => {
    const usersWithManyGroups = [
      {
        id: "u1",
        name: "Max",
        email: "max@test.com",
        role: "member",
        banned: false,
        groups: [
          { id: "g1", name: "Engineering" },
          { id: "g2", name: "Marketing" },
          { id: "g3", name: "Sales" },
          { id: "g4", name: "DevOps" },
        ],
      },
    ];
    mockFetchForUsers(usersWithManyGroups, [], { enterprise: true });
    render(<SettingsUsers currentUserId="admin-1" />);

    await waitFor(() => {
      const tableView = within(screen.getByRole("table"));
      expect(tableView.getByText("Engineering")).toBeInTheDocument();
      expect(tableView.getByText("Marketing")).toBeInTheDocument();
      expect(tableView.getByText("+2 more")).toBeInTheDocument();
      expect(tableView.queryByText("Sales")).not.toBeInTheDocument();
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

  it("should render group badges for users", async () => {
    mockFetchForUsers(mockUsers, mockInvites, { enterprise: true });
    render(<SettingsUsers currentUserId="user-1" />);

    await waitFor(() => {
      expect(screen.getAllByText("Alice Admin").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const tableView = within(table);

    // Bob has two groups (both visible since cap is 2)
    const bobRow = tableView.getByText("Bob User").closest("tr")!;
    expect(within(bobRow).getByText("Engineering")).toBeInTheDocument();
    expect(within(bobRow).getByText("Design")).toBeInTheDocument();

    // Carol has no groups
    const carolRow = tableView.getByText("Carol User").closest("tr")!;
    expect(within(carolRow).queryByText("Engineering")).not.toBeInTheDocument();
    expect(within(carolRow).queryByText("Design")).not.toBeInTheDocument();
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

    it("should not show action buttons in deactivated user row", async () => {
      renderWithDeactivatedUser();

      await waitFor(() => {
        expect(screen.getAllByText("Dave Deactivated").length).toBeGreaterThanOrEqual(1);
      });

      const table = screen.getByRole("table");
      const daveRow = within(table).getByText("Dave Deactivated").closest("tr")!;
      expect(within(daveRow).queryByRole("button", { name: "Reactivate" })).not.toBeInTheDocument();
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

    it("should open sheet with Reactivate button when clicking deactivated user row", async () => {
      const user = userEvent.setup();
      renderWithDeactivatedUser();

      await waitFor(() => {
        expect(screen.getAllByText("Dave Deactivated").length).toBeGreaterThanOrEqual(1);
      });

      const table = screen.getByRole("table");
      await user.click(within(table).getByText("Dave Deactivated"));

      // Sheet should open showing Reactivate button
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /reactivate/i })).toBeInTheDocument();
      });
    });
  });

  it("should refetch groups when user detail sheet is opened", async () => {
    const user = userEvent.setup();

    // Initial load: enterprise enabled but no groups yet
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/users") {
        return { ok: true, json: async () => ({ users: mockUsers }) } as Response;
      }
      if (String(url) === "/api/users/invites") {
        return { ok: true, json: async () => ({ invites: [] }) } as Response;
      }
      if (String(url) === "/api/groups") {
        return { ok: true, json: async () => [] } as Response;
      }
      if (String(url) === "/api/enterprise/status") {
        return { ok: true, json: async () => ({ enterprise: true }) } as Response;
      }
      return { ok: false } as Response;
    });

    render(<SettingsUsers currentUserId="user-1" />);

    await waitFor(() => {
      expect(screen.getAllByText("Bob User").length).toBeGreaterThanOrEqual(1);
    });

    // Now a group was created (e.g. in Groups tab) — update mock to return it
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/users") {
        return { ok: true, json: async () => ({ users: mockUsers }) } as Response;
      }
      if (String(url) === "/api/users/invites") {
        return { ok: true, json: async () => ({ invites: [] }) } as Response;
      }
      if (String(url) === "/api/groups") {
        return {
          ok: true,
          json: async () => [{ id: "g-new", name: "Support" }],
        } as Response;
      }
      if (String(url) === "/api/enterprise/status") {
        return { ok: true, json: async () => ({ enterprise: true }) } as Response;
      }
      return { ok: false } as Response;
    });

    // Click on Bob to open the detail sheet
    await user.click(within(screen.getByRole("table")).getByText("Bob User"));

    // The new "Support" group should appear as a checkbox in the detail sheet
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /support/i })).toBeInTheDocument();
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

    it("should remove the invite row optimistically before the DELETE fetch resolves", async () => {
      const user = userEvent.setup();
      mockFetchForUsers(mockUsers, [pendingInvite]);
      render(<SettingsUsers currentUserId="user-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("pending@example.com").length).toBeGreaterThanOrEqual(1);
      });

      // Hold the DELETE response until we release it, so we can observe the
      // intermediate optimistic state before the round-trip completes.
      let releaseDelete: (value: Response) => void = () => {};
      const deletePromise = new Promise<Response>((resolve) => {
        releaseDelete = resolve;
      });

      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        if (String(url) === "/api/users/invites/inv-1" && init?.method === "DELETE") {
          return deletePromise;
        }
        if (String(url) === "/api/users") {
          return { ok: true, json: async () => ({ users: mockUsers }) } as Response;
        }
        if (String(url) === "/api/users/invites") {
          return { ok: true, json: async () => ({ invites: [] }) } as Response;
        }
        if (String(url) === "/api/groups") {
          return { ok: true, json: async () => [] } as Response;
        }
        if (String(url) === "/api/enterprise/status") {
          return { ok: true, json: async () => ({ enterprise: false }) } as Response;
        }
        return { ok: false } as Response;
      });

      const table = screen.getByRole("table");
      const inviteRow = within(table).getAllByText("pending@example.com")[0].closest("tr")!;
      await user.click(within(inviteRow).getByRole("button", { name: "Revoke" }));

      // The row should be gone immediately even though the DELETE request is
      // still in-flight — this is the optimistic update contract.
      await waitFor(() => {
        expect(within(table).queryByText("pending@example.com")).not.toBeInTheDocument();
      });

      // Now let the DELETE resolve so React Testing Library can clean up.
      releaseDelete({ ok: true, json: async () => ({ success: true }) } as Response);
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
        if (String(url) === "/api/groups") {
          return { ok: true, json: async () => [] } as Response;
        }
        if (String(url) === "/api/enterprise/status") {
          return { ok: true, json: async () => ({ enterprise: false }) } as Response;
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
        if (String(url) === "/api/groups") {
          return { ok: true, json: async () => [] } as Response;
        }
        if (String(url) === "/api/enterprise/status") {
          return { ok: true, json: async () => ({ enterprise: false }) } as Response;
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
