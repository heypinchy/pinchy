import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsGroups } from "@/components/settings-groups";

describe("SettingsGroups", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockGroups = [
    { id: "g1", name: "Engineering", description: "Dev team", memberCount: 3 },
    { id: "g2", name: "Design", description: null, memberCount: 1 },
  ];

  const mockUsers = [
    { id: "u1", name: "Alice", email: "alice@example.com", role: "admin", banned: false },
    { id: "u2", name: "Bob", email: "bob@example.com", role: "member", banned: false },
  ];

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetch(
    groups: unknown[] = mockGroups,
    users: unknown[] = mockUsers,
    enterprise = true
  ) {
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/enterprise/status") {
        return { ok: true, json: async () => ({ enterprise }) } as Response;
      }
      if (String(url) === "/api/groups") {
        return { ok: true, json: async () => groups } as Response;
      }
      if (String(url) === "/api/users") {
        return { ok: true, json: async () => ({ users }) } as Response;
      }
      return { ok: false } as Response;
    });
  }

  it("should render groups list from API", async () => {
    mockFetch();
    render(<SettingsGroups />);

    await waitFor(() => {
      expect(screen.getAllByText("Engineering").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const tableView = within(table);
    expect(tableView.getByText("Engineering")).toBeInTheDocument();
    expect(tableView.getByText("Design")).toBeInTheDocument();
    expect(tableView.getByText("Dev team")).toBeInTheDocument();
    expect(tableView.getByText("3")).toBeInTheDocument();
    expect(tableView.getByText("1")).toBeInTheDocument();
  });

  it("should show create dialog on button click", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<SettingsGroups />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New Group" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "New Group" }));

    await waitFor(() => {
      expect(
        screen.getByText("New Group", { selector: "[data-slot='dialog-title']" })
      ).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
  });

  it("should create group via API on form submit", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<SettingsGroups />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New Group" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "New Group" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Name"), "Marketing");
    await user.type(screen.getByLabelText("Description"), "Marketing team");

    vi.mocked(global.fetch).mockImplementation(async (url, init) => {
      if (String(url) === "/api/groups" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ id: "g3", name: "Marketing", description: "Marketing team" }),
        } as Response;
      }
      if (String(url) === "/api/groups") {
        return {
          ok: true,
          json: async () => [
            ...mockGroups,
            { id: "g3", name: "Marketing", description: "Marketing team", memberCount: 0 },
          ],
        } as Response;
      }
      if (String(url) === "/api/users") {
        return { ok: true, json: async () => ({ users: mockUsers }) } as Response;
      }
      return { ok: false } as Response;
    });

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Marketing", description: "Marketing team" }),
      });
    });
  });

  it("should show delete confirmation dialog", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<SettingsGroups />);

    await waitFor(() => {
      expect(screen.getAllByText("Engineering").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const row = within(table).getByText("Engineering").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getByText("Delete Group")).toBeInTheDocument();
    });
  });

  it("should delete group via API", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<SettingsGroups />);

    await waitFor(() => {
      expect(screen.getAllByText("Engineering").length).toBeGreaterThanOrEqual(1);
    });

    const table = screen.getByRole("table");
    const row = within(table).getByText("Engineering").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getByText("Delete Group")).toBeInTheDocument();
    });

    vi.mocked(global.fetch).mockImplementation(async (url, init) => {
      if (String(url) === "/api/groups/g1" && init?.method === "DELETE") {
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      if (String(url) === "/api/groups") {
        return { ok: true, json: async () => [mockGroups[1]] } as Response;
      }
      if (String(url) === "/api/users") {
        return { ok: true, json: async () => ({ users: mockUsers }) } as Response;
      }
      return { ok: false } as Response;
    });

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/groups/g1", { method: "DELETE" });
    });
  });

  it("should show loading state", () => {
    vi.mocked(global.fetch).mockImplementation(() => new Promise(() => {}));
    render(<SettingsGroups />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("should show enterprise feature card when enterprise is not active", async () => {
    mockFetch(mockGroups, mockUsers, false);
    render(<SettingsGroups />);

    await waitFor(() => {
      expect(screen.getByText("Groups")).toBeInTheDocument();
    });

    expect(screen.getByText("Enterprise")).toBeInTheDocument();
    expect(
      screen.getByText(/Create groups to control which users can access which agents/)
    ).toBeInTheDocument();
  });
});
