import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { SettingsGroups } from "@/components/settings-groups";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

  /**
   * Build a Response-shaped mock that exposes BOTH json() and text() so the test
   * works regardless of which the consumer calls. The api-client helper reads
   * via text() + JSON.parse; raw fetch in components reads via json().
   */
  function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
    const text = JSON.stringify(body);
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => text,
    } as unknown as Response;
  }

  function mockFetch(
    groups: unknown[] = mockGroups,
    users: unknown[] = mockUsers,
    enterprise = true
  ) {
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/enterprise/status") {
        return jsonResponse({ enterprise });
      }
      if (String(url) === "/api/groups") {
        return jsonResponse(groups);
      }
      if (String(url) === "/api/users") {
        return jsonResponse({ users });
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
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
        return jsonResponse({ id: "g3", name: "Marketing", description: "Marketing team" });
      }
      if (String(url) === "/api/groups") {
        return jsonResponse([
          ...mockGroups,
          { id: "g3", name: "Marketing", description: "Marketing team", memberCount: 0 },
        ]);
      }
      if (String(url) === "/api/users") {
        return jsonResponse({ users: mockUsers });
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
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
        return jsonResponse({ success: true });
      }
      if (String(url) === "/api/groups") {
        return jsonResponse([mockGroups[1]]);
      }
      if (String(url) === "/api/users") {
        return jsonResponse({ users: mockUsers });
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
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

  it("renders inline field error when API returns 400 with fieldErrors (no toast)", async () => {
    // Per the project error-display policy: form validation errors should be
    // rendered inline next to the offending field, NOT as toast notifications.
    // The server returns Zod's flatten() output under details.fieldErrors.
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

    // Type something so the Create button is enabled, then fail validation
    // server-side (the client doesn't do its own length check).
    await user.type(screen.getByLabelText("Name"), "x");

    vi.mocked(global.fetch).mockImplementation(async (url, init) => {
      if (String(url) === "/api/groups" && init?.method === "POST") {
        return jsonResponse(
          {
            error: "Validation failed",
            details: { fieldErrors: { name: ["Name is required"] }, formErrors: [] },
          },
          { ok: false, status: 400 }
        );
      }
      if (String(url) === "/api/groups") {
        return jsonResponse(mockGroups);
      }
      if (String(url) === "/api/users") {
        return jsonResponse({ users: mockUsers });
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
    });

    await user.click(screen.getByRole("button", { name: "Create" }));

    // Inline error appears next to the Name field
    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument();
    });

    // Toast must NOT fire when the error is field-scoped
    expect(toast.error).not.toHaveBeenCalled();

    // Dialog stays open so the user can correct the input
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
  });

  it("shows error toast and keeps dialog open when group creation fails", async () => {
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

    await user.type(screen.getByLabelText("Name"), "Bad Group");

    vi.mocked(global.fetch).mockImplementation(async (url, init) => {
      if (String(url) === "/api/groups" && init?.method === "POST") {
        return jsonResponse({ error: "Validation failed" }, { ok: false, status: 400 });
      }
      if (String(url) === "/api/groups") {
        return jsonResponse(mockGroups);
      }
      if (String(url) === "/api/users") {
        return jsonResponse({ users: mockUsers });
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
    });

    await user.click(screen.getByRole("button", { name: "Create" }));

    // Strict: the toast must surface the server's exact error message,
    // not a generic "Request failed: 400" fallback. This catches mock/contract
    // drift where the helper silently loses the body.
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Validation failed");
    });

    // Dialog should remain open so the user can correct the input
    expect(
      screen.getByText("New Group", { selector: "[data-slot='dialog-title']" })
    ).toBeInTheDocument();
    // Stronger check: an interactive form field is only accessible when the dialog is truly open
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
  });
});
